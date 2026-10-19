import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProjectPipelineRun } from './project-pipeline-types';
import { projectPipelineMarkdown } from './project-pipeline';
import { isNewProjectIntegrationSource } from '../../../services/adaptation-service/src/project-integration-context';

const execute = promisify(execFile);
const ignored = new Set(['.git', '.forexpore', '.agent-tmp', '.translation-verifier-tests', '.translation-verifier-coverage', '.forexplore', '.vs', '.idea', 'node_modules', 'bin', 'obj', 'dist', 'build', 'out', 'target', 'coverage', '__pycache__']);
const safeId = /^[a-f0-9-]{36}$/;
async function git(root: string, args: string[]): Promise<string> {
  return (await execute('git', ['-C', root, ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout;
}

export class ProjectPipelineFiles {
  constructor(readonly storageRoot: string) {}
  directory(id: string): string {
    if (!safeId.test(id)) throw new Error('无效的项目运行标识。');
    return path.join(this.storageRoot, 'project-pipelines', id);
  }
  async snapshot(source: string, id: string, signal: AbortSignal): Promise<{ outputRoot: string; baselineCommit: string }> {
    const root = await realpath(source), directory = this.directory(id), outputRoot = path.join(directory, 'project');
    if (path.relative(root, directory) === '' || !path.relative(root, directory).startsWith('..') && !path.isAbsolute(path.relative(root, directory))) throw new Error('运行存储目录不能位于目标工程内。');
    await mkdir(outputRoot, { recursive: true });
    let count = 0, bytes = 0;
    const copy = async (from: string, to: string): Promise<void> => {
      for (const entry of await readdir(from, { withFileTypes: true })) {
        signal.throwIfAborted();
        if (ignored.has(entry.name.toLowerCase()) || /^\.env(?:\.|$)/i.test(entry.name)) continue;
        const sourceFile = path.join(from, entry.name), dest = path.join(to, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`目标骨架含符号链接，请先整理后重试：${path.relative(root, sourceFile)}`);
        if (entry.isDirectory()) { await mkdir(dest); await copy(sourceFile, dest); }
        else if (entry.isFile()) {
          const before = await lstat(sourceFile); bytes += before.size; count++;
          if (count > 30_000 || bytes > 512 * 1024 * 1024) throw new Error('骨架项目超过 30000 文件或 512 MiB 上限，请缩小目标工程范围。');
          await copyFile(sourceFile, dest);
          const after = await lstat(sourceFile);
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('复制期间源工程发生变化，请保存文件后重试。');
        }
      }
    };
    await copy(root, outputRoot); signal.throwIfAborted();
    await git(outputRoot, ['init', '-b', `codex/project-pipeline/${id}`]);
    await writeFile(path.join(outputRoot, '.git', 'info', 'exclude'), '\n.forexplore/\n.forexpore/\n.agent-tmp/\n.translation-verifier-tests/\n.translation-verifier-coverage/\nnode_modules/\nbin/\nobj/\ndist/\nbuild/\nout/\ntarget/\ncoverage/\n__pycache__/\n');
    await git(outputRoot, ['add', '--force', '--all']);
    await this.commit(outputRoot, 'RECAST: capture target skeleton baseline', true);
    return { outputRoot, baselineCommit: (await git(outputRoot, ['rev-parse', 'HEAD'])).trim() };
  }
  private commit(root: string, message: string, empty = false): Promise<string> {
    return git(root, ['-c', 'user.name=RECAST', '-c', 'user.email=recast@localhost', '-c', 'core.hooksPath=', 'commit', '--no-gpg-sign', ...(empty ? ['--allow-empty'] : []), '-m', message]);
  }
  async sourceHash(run: ProjectPipelineRun): Promise<string> {
    const root = this.output(run), hash = createHash('sha256');
    const tracked = (await git(root, ['ls-files', '-z'])).split('\0').filter(Boolean);
    const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
    for (const file of [...new Set([...tracked, ...untracked])].sort()) {
      const absolute = path.join(root, file); const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`输出项目存在非普通文件：${file}`);
      hash.update(JSON.stringify([file, createHash('sha256').update(await readFile(absolute)).digest('hex')]));
    }
    return hash.digest('hex');
  }
  async assertWriteScope(run: ProjectPipelineRun): Promise<void> {
    const root = this.output(run), allowed = new Set(run.modules.flatMap(module => module.authorizedFiles ?? module.target.module?.sourceFiles ?? []));
    const changed = [...(await git(root, ['diff', '--name-only', '-z', run.baselineCommit!, '--'])).split('\0'),
      ...(await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0')].filter(Boolean);
    const baseline = new Set((await git(root, ['ls-tree', '-r', '--name-only', '-z', run.baselineCommit!])).split('\0').filter(Boolean));
    const integrations = run.modules.filter(module => module.taskKind === 'project-integration');
    const acceptedNew = new Set(integrations.flatMap(module => module.changedFiles ?? []).filter(file => !baseline.has(file) && isNewProjectIntegrationSource(file, [...allowed])));
    const outside = changed.filter(file => !allowed.has(file) && !acceptedNew.has(file));
    if (outside.length) throw new Error(`输出修改超出已批准的生产文件范围：${outside.join('、')}`);
  }
  async publish(run: ProjectPipelineRun, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted(); await this.assertWriteScope(run);
    if (!run.validation || await this.sourceHash(run) !== run.validation.sourceHash) throw new Error('待提交输出与验收快照不一致。');
    const root = this.output(run);
    const allowed = [...new Set(run.modules.flatMap(module => [...(module.authorizedFiles ?? module.target.module?.sourceFiles ?? []), ...(module.taskKind === 'project-integration' ? module.changedFiles ?? [] : [])]))];
    // Keep large projects below Windows' command-line length limit and treat
    // every reviewed file name literally, rather than as a Git path pattern.
    await writeFile(path.join(root, '.git', 'recast-approved-files'), allowed.join('\0') + '\0');
    await git(root, ['--literal-pathspecs', 'add', '--pathspec-from-file=.git/recast-approved-files', '--pathspec-file-nul']);
    await this.assertWriteScope(run);
    if (await this.sourceHash(run) !== run.validation.sourceHash) throw new Error('暂存期间输出文件发生变化，已停止发布。');
    await this.commit(root, `RECAST: deliver project pipeline ${run.id}`, true);
    return (await git(root, ['rev-parse', 'HEAD'])).trim();
  }
  async diff(run: ProjectPipelineRun): Promise<string> { return git(this.output(run), ['diff', run.baselineCommit!, '--']); }
  output(run: ProjectPipelineRun): string {
    const expected = path.join(this.directory(run.id), 'project');
    if (run.outputRoot !== expected) throw new Error('输出项目不是当前运行的受管副本。');
    return expected;
  }
  async save(run: ProjectPipelineRun): Promise<void> {
    const directory = this.directory(run.id); await mkdir(directory, { recursive: true });
    for (const [name, content] of [['run.json', JSON.stringify(run, null, 2)], ['acceptance-report.md', projectPipelineMarkdown(run)]] as const) {
      const destination = path.join(directory, name), temporary = `${destination}.tmp`;
      await writeFile(temporary, content, 'utf8'); await rename(temporary, destination);
    }
  }
  async read(id: string): Promise<ProjectPipelineRun> {
    const value = JSON.parse(await readFile(path.join(this.directory(id), 'run.json'), 'utf8')) as ProjectPipelineRun;
    if (value.id !== id || !Array.isArray(value.modules) || !Array.isArray(value.events)) throw new Error('项目运行记录损坏。');
    if (value.outputRoot) this.output(value);
    if (value.status === 'running') {
      value.status = 'interrupted';
      value.error = '扩展宿主已重启，本次执行已中断；保留输出和报告，请重新开始以重新验证。';
      value.reportAvailable = true;
      await this.save(value);
    }
    return value;
  }
}
