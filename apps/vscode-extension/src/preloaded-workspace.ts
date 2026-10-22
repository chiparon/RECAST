import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { RepositoryId, RepositoryRole } from '@forexplore/contracts';

interface PreloadedRepositoryEntry {
  repositoryId: RepositoryId;
  localPath: string;
  role: RepositoryRole;
  displayName?: string;
  projectId?: string;
}

interface PreloadedManifest {
  format: 'forexplore-preloaded-workspace';
  version: 1;
  repositories: PreloadedRepositoryEntry[];
}

export interface PreloadedWorkspaceBindings {
  repositoryIds: Map<string, RepositoryId>;
  projectIds: Map<RepositoryId, string>;
}

function pathKeys(value: string): Set<string> {
  const raw = value.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  const resolved = path.resolve(value).replaceAll('\\', '/').replace(/\/+$/, '');
  const keys = new Set([raw.toLowerCase(), resolved.toLowerCase()]);
  try { keys.add(realpathSync(value).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()); } catch { /* keep the lexical key */ }
  const drive = /^([a-z]):\/(.*)$/i.exec(raw);
  if (drive) keys.add(`/mnt/${drive[1]!.toLowerCase()}/${drive[2]!}`.toLowerCase());
  const mounted = /^\/mnt\/([a-z])\/(.*)$/i.exec(raw);
  if (mounted) keys.add(`${mounted[1]!.toLowerCase()}:/${mounted[2]!}`.toLowerCase());
  for (const candidate of [...keys]) {
    const checkout = candidate.indexOf('/weichai/');
    if (checkout >= 0) keys.add(candidate.slice(checkout + '/weichai/'.length));
    const dataset = candidate.indexOf('/experiments/enterprise-asset-upgrade/');
    if (dataset >= 0) keys.add(candidate.slice(dataset + '/experiments/enterprise-asset-upgrade/'.length));
  }
  return keys;
}

function validRepositoryId(value: unknown): value is RepositoryId {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9._-]+$/.test(value);
}

/**
 * Loads only trusted host configuration from the launcher environment. The
 * file is never sent to the Webview and is ignored with the preloaded profile.
 */
export function loadPreloadedBindings(): PreloadedWorkspaceBindings {
  if (process.env.FOREXPLORE_PRELOADED !== '1') return { repositoryIds: new Map(), projectIds: new Map() };
  const manifestPath = process.env.FOREXPLORE_PRELOADED_MANIFEST?.trim();
  if (!manifestPath) throw new Error('预置入口没有提供仓库清单。');
  if (!existsSync(manifestPath)) throw new Error(`预置仓库清单不存在：${manifestPath}`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch (error) { throw new Error(`预置仓库清单无法读取：${error instanceof Error ? error.message : String(error)}`); }
  if (!raw || typeof raw !== 'object') throw new Error('预置仓库清单格式无效。');
  const record = raw as Partial<PreloadedManifest>;
  if (record.format !== 'forexplore-preloaded-workspace' || record.version !== 1 || !Array.isArray(record.repositories)) {
    throw new Error('预置仓库清单版本不受支持。');
  }
  const bindings = new Map<string, RepositoryId>();
  const projectIds = new Map<RepositoryId, string>();
  for (const entry of record.repositories) {
    if (!entry || typeof entry !== 'object') throw new Error('预置仓库清单包含无效条目。');
    const candidate = entry as Partial<PreloadedRepositoryEntry>;
    if (!validRepositoryId(candidate.repositoryId) || typeof candidate.localPath !== 'string' || !candidate.localPath.trim() ||
        (candidate.role !== 'history' && candidate.role !== 'target')) {
      throw new Error('预置仓库清单包含无效 repositoryId、localPath 或 role。');
    }
    for (const key of pathKeys(candidate.localPath)) {
      const existing = bindings.get(key);
      if (existing && existing !== candidate.repositoryId) throw new Error(`预置仓库路径映射冲突：${candidate.localPath}`);
      bindings.set(key, candidate.repositoryId);
    }
    if (candidate.projectId?.trim()) projectIds.set(candidate.repositoryId, candidate.projectId.trim());
  }
  return { repositoryIds: bindings, projectIds };
}

export function preloadedRepositoryId(
  bindings: ReadonlyMap<string, RepositoryId>,
  localPath: string,
): RepositoryId | undefined {
  for (const key of pathKeys(localPath)) {
    const repositoryId = bindings.get(key);
    if (repositoryId) return repositoryId;
  }
  return undefined;
}
