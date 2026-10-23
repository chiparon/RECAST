import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkspaceTranslationRequest, WorkspaceTranslationRun } from '@forexplore/contracts';
import { CodexWorkspaceTranslationRuntime } from './codex-workspace-translation-runtime';

async function eventually<T>(read: () => T | Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
    value = await read();
  }
  return value;
}

async function fixture(script: string, options: { retries?: number; timeoutMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'recast-output-recovery-'));
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'main.js'), 'exports.answer = () => 0;\n');
  await writeFile(join(project, 'acceptance.cjs'), "require('node:assert/strict').equal(require('./main.js').answer(), 42);\n");
  const cli = join(root, 'codex.mjs'), state = join(root, 'calls.json');
  await writeFile(cli, `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const prompt = readFileSync(0, 'utf8');
const statePath = process.env.RECAST_RECOVERY_STATE;
const calls = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : [];
const stage = process.argv[process.argv.indexOf('--sandbox') + 1] === 'read-only' ? 'analyzer' : 'translator';
const call = { root: process.cwd(), stage, recovery: prompt.includes('OUTPUT LIMIT RECOVERY'), source: readFileSync('target/main.js', 'utf8') };
calls.push(call); writeFileSync(statePath, JSON.stringify(calls));
const finish = text => writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], text);
const limit = (exitCode = 1) => { console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'exceed output tokens' } })); process.exit(exitCode); };
${script}
`);
  const runtime = new CodexWorkspaceTranslationRuntime({ workspaceRoot: project, codexCommand: cli,
    environment: { RECAST_RECOVERY_STATE: state }, maxModelTurns: 2,
    maxOutputLimitRetries: options.retries ?? 2, timeoutMs: options.timeoutMs ?? 30_000,
    compileCommand: { executable: process.execPath, args: ['--check', 'main.js'] },
    verification: { command: { executable: process.execPath, args: ['acceptance.cjs'] }, protectedFiles: ['acceptance.cjs'] },
  });
  const request: WorkspaceTranslationRequest = { spec: 'answer must return 42', sourceLanguage: 'JavaScript', targetLanguage: 'JavaScript',
    context: [], workspaceFiles: ['main.js'], writeFiles: ['main.js'], translationMode: 'direct-translator' };
  return { project, runtime, request,
    calls: async (): Promise<Array<{ root: string; stage: string; recovery: boolean; source: string }>> => {
      try { return JSON.parse(await readFile(state, 'utf8')); } catch { return []; }
    },
    done: async (run: WorkspaceTranslationRun) => eventually(() => runtime.get(run.id), value => ['completed', 'failed', 'cancelled'].includes(value.status)),
    close: async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); },
  };
}

describe('output-limit recovery through the real subprocess and Host checks', () => {
  it.each([1, 0])('keeps staged edits and completes compile and behavior checks after a truncated exit %s', async exitCode => {
    const f = await fixture(`if (calls.length === 1) {
  writeFileSync('target/main.js', 'exports.answer = () =>');
  finish('An earlier summary is not completion'); limit(${exitCode});
}
if (!call.recovery || call.source !== 'exports.answer = () =>' || calls[0].root !== call.root) process.exit(90);
if (!prompt.includes('one focused edit') || !prompt.includes('answer must return 42')) process.exit(91);
writeFileSync('target/main.js', 'exports.answer = () => 42;'); finish('Completed');`);
    try {
      const done = await f.done(f.runtime.start(f.request));
      expect(done.error).toBeUndefined();
      expect(done.status).toBe('completed');
      expect(done.acceptance).toBe('behavior-verified');
      expect(done.compilations).toHaveLength(1);
      expect(done.verification?.runs).toHaveLength(1);
      expect(done.agent?.stages?.map(stage => stage.outputLimitRecovery?.status)).toEqual(['retrying', 'recovered']);
      expect(done.modelTurns).toBe(2);
      expect(await f.calls()).toHaveLength(2);
      expect(await readFile(join(f.project, 'main.js'), 'utf8')).toContain('42');
      expect(done.events?.some(event => event.message.includes('正在以小步修改续接'))).toBe(true);
    } finally { await f.close(); }
  });

  it('shows the benefit over immediate failure with the same injected truncation', async () => {
    const f = await fixture("writeFileSync('target/main.js', 'exports.answer = () =>'); limit();", { retries: 0 });
    try {
      const done = await f.done(f.runtime.start(f.request));
      expect(done.status).toBe('failed');
      expect(done.error).toContain('用尽 0 次');
      expect(done.compilations).toEqual([]);
      expect(await f.calls()).toHaveLength(1);
      expect(await readFile(join(f.project, 'main.js'), 'utf8')).toContain('() => 0');
    } finally { await f.close(); }
  });

  it('bounds repeated failures and leaves production untouched', async () => {
    const f = await fixture("writeFileSync('target/main.js', 'exports.answer = () =>'); limit();");
    try {
      const done = await f.done(f.runtime.start(f.request));
      expect(done.status).toBe('failed');
      expect(done.error).toContain('用尽 2 次');
      expect(done.compilations).toEqual([]);
      expect(done.verification?.runs).toEqual([]);
      expect(done.agent?.stages?.at(-1)?.outputLimitRecovery?.status).toBe('exhausted');
      expect(await f.calls()).toHaveLength(3);
      expect(await readFile(join(f.project, 'main.js'), 'utf8')).toContain('() => 0');
    } finally { await f.close(); }
  });

  it('rejects a continuation with no final message instead of reusing an earlier summary', async () => {
    const f = await fixture("if (calls.length === 1) { finish('Earlier summary'); limit(); } writeFileSync('target/main.js', 'exports.answer = () => 42;');");
    try {
      const done = await f.done(f.runtime.start(f.request));
      expect(done.status).toBe('failed');
      expect(done.error).toContain('without a final completion message');
      expect(done.compilations).toEqual([]);
      expect(await f.calls()).toHaveLength(2);
      expect(await readFile(join(f.project, 'main.js'), 'utf8')).toContain('() => 0');
    } finally { await f.close(); }
  });

  it.each([
    ['configuration', 'max_tokens must be less than or equal to 8192', '参数超过服务商支持范围'],
    ['credentials', '401 unauthorized', '401 unauthorized'],
    ['context', 'context_length_exceeded', 'context_length_exceeded'],
  ])('does not blindly retry %s errors', async (_kind, message, expected) => {
    const f = await fixture(`console.log(JSON.stringify({ type: 'turn.failed', error: { message: ${JSON.stringify(message)} } })); process.exit(1);`);
    try {
      const done = await f.done(f.runtime.start(f.request));
      expect(done.status).toBe('failed');
      expect(done.error).toContain(expected);
      expect(await f.calls()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it('does not apply or continue unauthorized edits made before truncation', async () => {
    const f = await fixture("writeFileSync('target/unauthorized.cjs', 'exports.bad = true'); limit();");
    try {
      const done = await f.done(f.runtime.start(f.request));
      expect(done.status).toBe('failed');
      expect(done.error).toContain('outside writeFiles');
      expect(await f.calls()).toHaveLength(1);
      expect(done.compilations).toEqual([]);
      expect(await readFile(join(f.project, 'main.js'), 'utf8')).toContain('() => 0');
    } finally { await f.close(); }
  });

  it('still rejects incorrect behavior after a successful continuation', async () => {
    const f = await fixture("if (calls.length === 1) limit(); writeFileSync('target/main.js', 'exports.answer = () => 41;'); finish('done');");
    try {
      const done = await f.done(f.runtime.start(f.request));
      expect(done.status).toBe('failed');
      expect(done.error).toContain('behavioral verification failed');
      expect(done.compilations.at(-1)?.success).toBe(true);
      expect(done.verification?.runs.at(-1)?.success).toBe(false);
      expect(done.acceptance).toBe('compilation-only');
    } finally { await f.close(); }
  });

  it('retries a truncated Analyzer before handing a complete plan to Translator', async () => {
    const f = await fixture(`if (stage === 'analyzer') {
  if (!call.recovery) { finish('INCOMPLETE PLAN'); limit(); }
  finish('# SMALL_COMPLETE_PLAN: Implement main.js answer to return 42.');
} else {
  if (!readFileSync('CODEX_IMPLEMENTATION_PLAN.md', 'utf8').includes('SMALL_COMPLETE_PLAN')) process.exit(92);
  writeFileSync('target/main.js', 'exports.answer = () => 42;'); finish('done');
}`);
    try {
      const done = await f.done(f.runtime.start({ ...f.request, translationMode: 'analyzer-translator' }));
      expect(done.error).toBeUndefined();
      expect(done.status).toBe('completed');
      expect(done.plan?.markdown).toContain('SMALL_COMPLETE_PLAN');
      expect(done.agent?.stages?.map(stage => stage.stage)).toEqual(['analyzer', 'analyzer', 'translator']);
      expect(done.acceptance).toBe('behavior-verified');
    } finally { await f.close(); }
  });

  it('preserves new integration sources across continuation and validates the final project', async () => {
    const f = await fixture(`if (calls.length === 1) {
  writeFileSync('target/extra.js', 'exports.value = 42;'); limit();
}
if (!existsSync('target/extra.js')) process.exit(93);
writeFileSync('target/main.js', "exports.answer = () => require('./extra.js').value;"); finish('done');`);
    try {
      const done = await f.done(f.runtime.start({ ...f.request, taskKind: 'project-integration' }));
      expect(done.error).toBeUndefined();
      expect(done.status).toBe('completed');
      expect(done.changes.map(change => change.path)).toEqual(['extra.js', 'main.js']);
      expect(done.acceptance).toBe('behavior-verified');
    } finally { await f.close(); }
  });

  it('honors cancellation while a continuation process is running', async () => {
    const f = await fixture("if (calls.length === 1) limit(); setInterval(() => {}, 1000);");
    try {
      const run = f.runtime.start(f.request);
      expect((await eventually(f.calls, calls => calls.length === 2)).length).toBe(2);
      const done = await f.runtime.cancel(run.id);
      expect(done.status).toBe('cancelled');
      expect(await f.calls()).toHaveLength(2);
      expect(done.compilations).toEqual([]);
    } finally { await f.close(); }
  });

  it('shares the original task deadline across continuations', async () => {
    const f = await fixture("if (calls.length === 1) limit(); setInterval(() => {}, 1000);", { timeoutMs: 1000 });
    try {
      const done = await f.done(f.runtime.start(f.request));
      expect(done.status).toBe('cancelled');
      expect(done.error).toContain('timed out');
      expect(await f.calls()).toHaveLength(2);
      expect(done.compilations).toEqual([]);
    } finally { await f.close(); }
  });
});
