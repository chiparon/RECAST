import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexWorkspaceTranslationRuntime } from './codex-workspace-translation-runtime';

async function fixture(script: string, integration = false) {
  const root = await mkdtemp(join(tmpdir(), 'recast-scope-recovery-'));
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'main.js'), 'exports.answer = () => 0;\n');
  await writeFile(join(project, 'dependency.js'), 'exports.contract = 7;\n');
  await writeFile(join(project, 'acceptance.cjs'), "require('node:assert/strict').equal(require('./main.js').answer(), 42);\n");
  const state = join(root, 'calls.json'), cli = join(root, 'codex.mjs');
  await writeFile(cli, `import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
const prompt=readFileSync(0,'utf8'), state=process.env.RECAST_SCOPE_STATE;
const calls=existsSync(state)?JSON.parse(readFileSync(state,'utf8')):[];
calls.push({root:process.cwd(),source:readFileSync('target/main.js','utf8'),dependency:readFileSync('target/dependency.js','utf8'),feedback:prompt.includes('WORKSPACE SCOPE CORRECTION')});
writeFileSync(state,JSON.stringify(calls));
const finish=()=>writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],'Completed');
${script}
`);
  const runtime = new CodexWorkspaceTranslationRuntime({ workspaceRoot: project, codexCommand: cli,
    environment: { RECAST_SCOPE_STATE: state }, maxModelTurns: 2, timeoutMs: 30_000,
    compileCommand: { executable: process.execPath, args: ['--check', 'main.js'] },
    verification: { command: { executable: process.execPath, args: ['acceptance.cjs'] }, protectedFiles: ['acceptance.cjs'] },
  });
  return { project, runtime,
    calls: async (): Promise<Array<{ root: string; source: string; dependency: string; feedback: boolean }>> => JSON.parse(await readFile(state,'utf8')),
    run: async () => {
      const started = runtime.start({ spec: 'answer returns 42; preserve the dependency contract', sourceLanguage: 'JavaScript', targetLanguage: 'JavaScript', context: [], workspaceFiles: ['main.js', 'dependency.js'], writeFiles: ['main.js'], translationMode: 'direct-translator', ...(integration ? { taskKind: 'project-integration' } : {}) });
      const deadline = Date.now()+20_000;
      while (Date.now()<deadline) {
        const run=runtime.get(started.id);
        if (['completed','failed','cancelled'].includes(run.status)) return run;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      throw new Error('Scope recovery did not finish');
    },
    close: async () => { await runtime.shutdown(); await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}); },
  };
}

describe('internal recovery of staging file mistakes', () => {
  it.each([false, true])('discards target/debug.log without another model call (integration=%s)', async integration => {
    const f=await fixture("writeFileSync('target/main.js','exports.answer = () => 42;'); writeFileSync('target/debug.log','temporary diagnostic'); finish();",integration);
    try {
      const done=await f.run();
      expect(done.error).toBeUndefined(); expect(done.status).toBe('completed'); expect(done.acceptance).toBe('behavior-verified');
      expect(await f.calls()).toHaveLength(1);
      expect(await readFile(join(f.project,'debug.log'),'utf8').catch(()=>null)).toBeNull();
      expect(done.events?.some(event=>event.message.includes('已隔离'))).toBe(true);
    } finally { await f.close(); }
  });

  it.each(['edit', 'delete', 'new-source'])('restores %s, preserves valid edits and feeds back within the original budget', async kind => {
    const mistake = kind==='edit' ? "writeFileSync('target/dependency.js','exports.contract = 99;');" : kind==='delete' ? "unlinkSync('target/dependency.js');" : "writeFileSync('target/unauthorized.cjs','exports.extra = true;');";
    const f=await fixture(`if(calls.length===1) { writeFileSync('target/main.js','exports.answer = () => 42;'); ${mistake} } else if(!prompt.includes('WORKSPACE SCOPE CORRECTION') || existsSync('target/unauthorized.cjs')) process.exit(90); finish();`);
    try {
      const done=await f.run(), calls=await f.calls();
      expect(done.error).toBeUndefined(); expect(done.status).toBe('completed'); expect(done.acceptance).toBe('behavior-verified');
      expect(calls).toHaveLength(2); expect(calls[1]?.root).toBe(calls[0]?.root);
      expect(calls[1]?.source).toContain('42'); expect(calls[1]?.dependency).toContain('7'); expect(calls[1]?.feedback).toBe(true);
      expect(await readFile(join(f.project,'dependency.js'),'utf8')).toBe('exports.contract = 7;\n');
      expect(await readFile(join(f.project,'unauthorized.cjs'),'utf8').catch(()=>null)).toBeNull();
      expect(done.modelTurns).toBe(2);
    } finally { await f.close(); }
  });

  it('recreates an accidentally deleted allowed file before asking the Agent to complete it', async () => {
    const f=await fixture("if(calls.length===1) unlinkSync('target/main.js'); else writeFileSync('target/main.js','exports.answer = () => 42;'); finish();");
    try {
      const done=await f.run();
      expect(done.status).toBe('completed'); expect((await f.calls())[1]?.source).toContain('0');
      expect(await readFile(join(f.project,'main.js'),'utf8')).toContain('42');
    } finally { await f.close(); }
  });

  it('stops repeated violations at the existing budget without publishing partial edits', async () => {
    const f=await fixture("writeFileSync('target/main.js','exports.answer = () => 42;'); writeFileSync('target/dependency.js','exports.contract = 99;'); finish();");
    try {
      const done=await f.run();
      expect(done.status).toBe('failed'); expect(done.error).toContain('剩余实现轮数'); expect(await f.calls()).toHaveLength(2);
      expect(done.compilations).toEqual([]);
      expect(await readFile(join(f.project,'main.js'),'utf8')).toContain('0');
      expect(await readFile(join(f.project,'dependency.js'),'utf8')).toContain('7');
    } finally { await f.close(); }
  });
});
