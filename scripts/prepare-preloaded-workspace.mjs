/**
 * Build the ignored manifest consumed by the preloaded workbench.
 *
 * The manifest does not copy or mutate a repository. It binds the paths in a
 * workspace file to the repository IDs already stored in SeekDB, which is
 * needed when the same database was populated from Windows and is opened from
 * WSL (or the other way around).
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';

const WORKSPACE_MARKER = '/experiments/enterprise-asset-upgrade/';

function normalizeSlashes(value) {
  return String(value).replaceAll('\\', '/').replace(/\/+/g, '/');
}

/** Return comparison keys that survive Windows drive and WSL mount spelling. */
function pathKeys(value) {
  const raw = normalizeSlashes(value).replace(/\/$/, '');
  const resolved = normalizeSlashes(path.resolve(value)).replace(/\/$/, '');
  const keys = new Set([raw.toLowerCase(), resolved.toLowerCase()]);
  const drive = /^([a-z]):\/(.*)$/i.exec(raw);
  if (drive) keys.add(`/mnt/${drive[1].toLowerCase()}/${drive[2]}`.toLowerCase());
  const mounted = /^\/mnt\/([a-z])\/(.*)$/i.exec(raw);
  if (mounted) keys.add(`${mounted[1].toLowerCase()}:/${mounted[2]}`.toLowerCase());
  for (const candidate of [...keys]) {
    const marker = candidate.toLowerCase().indexOf(WORKSPACE_MARKER);
    if (marker >= 0) keys.add(candidate.slice(marker + WORKSPACE_MARKER.length));
    const checkout = candidate.toLowerCase().indexOf('/weichai/');
    if (checkout >= 0) keys.add(candidate.slice(checkout + '/weichai/'.length));
  }
  return keys;
}

function samePath(left, right) {
  const rightKeys = pathKeys(right);
  return [...pathKeys(left)].some((key) => rightKeys.has(key));
}

function readWorkspace(workspacePath) {
  if (!workspacePath.endsWith('.code-workspace')) {
    throw new Error(`预置入口需要 .code-workspace 文件：${workspacePath}`);
  }
  const workspace = JSON.parse(readFileSync(workspacePath, 'utf8'));
  const workspaceRoot = path.dirname(workspacePath);
  const folders = (Array.isArray(workspace.folders) ? workspace.folders : []).map((folder) => {
    if (!folder || typeof folder.path !== 'string') throw new Error('工作区 folders 中存在无效路径。');
    const folderPath = path.resolve(workspaceRoot, folder.path);
    return { name: typeof folder.name === 'string' && folder.name.trim() ? folder.name.trim() : path.basename(folderPath), path: folderPath };
  });
  const byName = new Map(folders.map((folder) => [folder.name, folder.path]));
  const expand = (value) => {
    if (typeof value !== 'string') return undefined;
    const match = /^\$\{workspaceFolder(?::([^}]+))?\}(.*)$/.exec(value.trim());
    if (!match) return path.resolve(workspaceRoot, value);
    const root = match[1] ? byName.get(match[1]) : folders[0]?.path;
    if (!root) throw new Error(`工作区引用了不存在的 workspaceFolder：${value}`);
    return path.resolve(root, (match[2] ?? '').replace(/^[/\\]+/, ''));
  };
  const settings = workspace.settings && typeof workspace.settings === 'object' ? workspace.settings : {};
  const histories = Array.isArray(settings['forexplore.repositoryPaths'])
    ? settings['forexplore.repositoryPaths'].map(expand).filter(Boolean) : [];
  const targets = Array.isArray(settings['forexplore.targetRepositoryPaths'])
    ? settings['forexplore.targetRepositoryPaths'].map(expand).filter(Boolean) : [];
  return { folders, histories, targets };
}

function rowScore(row, localPath, role) {
  if (row.role !== role || !row.activeRevision || row.revisionStatus !== 'ready' || !samePath(row.localPath, localPath)) return -1;
  let score = row.analysisStatus === 'ready' || row.analysisStatus === 'degraded' ? 20 : 0;
  score += 10;
  if (row.displayName && path.basename(localPath).toLowerCase() === row.displayName.toLowerCase()) score += 1;
  return score;
}

/**
 * @param {{ workspacePath: string, outputDirectory: string, database: string }} input
 */
export async function preparePreloadedWorkspace(input) {
  const workspacePath = path.resolve(input.workspacePath);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.database)) {
    throw new Error(`SeekDB 数据库名无效：${input.database}`);
  }
  if (!existsSync(workspacePath)) throw new Error(`预置工作区不存在：${workspacePath}`);
  const { histories, targets } = readWorkspace(workspacePath);
  const requested = [
    ...targets.map((localPath) => ({ localPath, role: 'target' })),
    ...histories.map((localPath) => ({ localPath, role: 'history' })),
  ];
  if (!requested.length) throw new Error(`预置工作区没有配置目标或参考工程：${workspacePath}`);
  const config = {
    host: process.env.CODE_INTELLIGENCE_SEEKDB_HOST?.trim() || '127.0.0.1',
    port: Number(process.env.CODE_INTELLIGENCE_SEEKDB_PORT || process.env.SEEKDB_PORT || 2881),
    user: process.env.CODE_INTELLIGENCE_SEEKDB_USER?.trim() || 'root',
    password: process.env.CODE_INTELLIGENCE_SEEKDB_PASSWORD ?? '',
    database: input.database,
  };
  const pool = mysql.createPool({ ...config, connectionLimit: 2, connectTimeout: 10_000 });
  try {
    const [rows] = await pool.query(`
      SELECT r.repository_id AS repositoryId, r.display_name AS displayName, r.role,
             r.analysis_status AS analysisStatus, r.active_revision AS activeRevision,
             r.local_path AS localPath, ar.status AS revisionStatus
      FROM repositories r
      LEFT JOIN analysis_revisions ar
        ON ar.repository_id = r.repository_id AND ar.analysis_revision = r.active_revision
    `);
    const [projectRows] = await pool.query(`
      SELECT p.repository_id AS repositoryId, p.analysis_revision AS analysisRevision,
             p.project_id AS projectId, COUNT(f.file_id) AS fileCount
      FROM projects p
      LEFT JOIN files f ON f.repository_id = p.repository_id
        AND f.analysis_revision = p.analysis_revision
        AND f.project_id = p.project_id
      GROUP BY p.repository_id, p.analysis_revision, p.project_id
    `);
    const repositories = [];
    const missing = [];
    for (const request of requested) {
      if (!existsSync(request.localPath)) {
        missing.push(`${request.role}:${request.localPath}（本地目录不存在）`);
        continue;
      }
      const candidates = rows
        .map((row) => ({ row, score: rowScore(row, request.localPath, request.role) }))
        .filter((candidate) => candidate.score >= 0)
        .sort((left, right) => right.score - left.score);
      const selected = candidates[0]?.row;
      if (!selected) {
        missing.push(`${request.role}:${request.localPath}`);
        continue;
      }
      const project = projectRows
        .filter((candidate) => String(candidate.repositoryId) === String(selected.repositoryId) &&
          String(candidate.analysisRevision) === String(selected.activeRevision))
        .sort((left, right) => Number(right.fileCount) - Number(left.fileCount) ||
          String(left.projectId).localeCompare(String(right.projectId)))[0];
      repositories.push({
        repositoryId: String(selected.repositoryId),
        displayName: String(selected.displayName ?? path.basename(request.localPath)),
        role: request.role,
        localPath: path.resolve(request.localPath),
        storedPath: String(selected.localPath),
        analysisStatus: String(selected.analysisStatus ?? 'unknown'),
        analysisRevision: String(selected.activeRevision),
        ...(project ? { projectId: String(project.projectId) } : {}),
      });
    }
    if (missing.length) {
      throw new Error(`预置工作区中的路径没有对应的已建模仓库：\n${missing.join('\n')}\n数据库：${input.database}`);
    }
    const duplicateIds = repositories.filter((entry, index, all) =>
      all.findIndex((candidate) => candidate.repositoryId === entry.repositoryId) !== index);
    if (duplicateIds.length) throw new Error('预置工作区把同一个 repository 配置成了多个角色，请检查 workspace 文件。');

    const manifest = {
      format: 'forexplore-preloaded-workspace',
      version: 1,
      generatedAt: new Date().toISOString(),
      database: input.database,
      workspacePath,
      repositories,
    };
    const outputDirectory = path.resolve(input.outputDirectory);
    await mkdir(outputDirectory, { recursive: true });
    const manifestPath = path.join(outputDirectory, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return { manifestPath, manifest };
  } finally {
    await pool.end();
  }
}
