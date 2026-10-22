import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CodexWorkspaceTranslationRuntime } from './codex-workspace-translation-runtime';

it.each(['none', 'RECAST_APPLY_PATCH.cjs', 'CODEX_ANALYSIS_EVIDENCE.json'])('hands off versioned dependencies and rejects control-file changes (%s)', async tamper => {
  const root = await mkdtemp(join(tmpdir(), 'recast-handoff-'));
  const scripts = await mkdtemp(join(tmpdir(), 'recast-handoff-cli-'));
  let runtime: CodexWorkspaceTranslationRuntime | undefined;
  try {
    await writeFile(join(root, 'main.mjs'), 'export const value = 0;\n');
    await writeFile(join(root, 'ports.mjs'), 'export const required = 42;\n');
    const plan = '# Plan\nImplement value from required.\n## Evidence\n`target/ports.mjs:1-1` — required, dependency.\n';
    const cli = join(scripts, 'codex.mjs');
    await writeFile(cli, `import fs from 'node:fs';
const prompt = fs.readFileSync(0,'utf8');
const out = process.argv[process.argv.indexOf('--output-last-message')+1];
if(prompt.includes('You are the Analyzer Codex')) fs.writeFileSync(out,${JSON.stringify(plan)});
else {
  if(prompt.includes(${JSON.stringify(plan)})) throw Error('Plan was duplicated in the prompt');
  if(fs.readFileSync('CODEX_IMPLEMENTATION_PLAN.md','utf8')!==${JSON.stringify(plan)}) throw Error('Plan changed');
  const packet=JSON.parse(fs.readFileSync('CODEX_ANALYSIS_EVIDENCE.json','utf8'));
  if(packet.entries.length!==1||packet.entries[0].excerpt!=='export const required = 42;'||packet.stalePaths.length) throw Error('Dependency evidence is missing');
  fs.writeFileSync('target/main.mjs','export const value = 42;\\n');
  const tamper=${JSON.stringify(tamper)};
  if(tamper!=='none'){fs.chmodSync(tamper,0o600);fs.writeFileSync(tamper,'replaced host control');}
  fs.writeFileSync(out,'Implemented value.');
}`);
    runtime = new CodexWorkspaceTranslationRuntime({ workspaceRoot: root, codexCommand: cli,
      compileCommand: { executable: process.execPath, args: ['-e', "import('./main.mjs').then(m=>require('node:assert/strict').equal(m.value,42))"] } });
    const started = runtime.start({ spec: 'value must equal the ports requirement', sourceLanguage: 'JavaScript', targetLanguage: 'JavaScript',
      context: [], workspaceFiles: ['main.mjs', 'ports.mjs'], writeFiles: ['main.mjs'] });
    let run = started;
    for (let i = 0; i < 100 && ['analyzing','translating','compiling'].includes(run.status); i++) {
      await new Promise(resolve => setTimeout(resolve,50)); run = runtime.get(started.id);
    }
    expect(run.status, run.error).toBe(tamper === 'none' ? 'completed' : 'failed');
    if (tamper === 'none') {
      expect(run.agent?.stages?.at(-1)?.analysisEvidence).toMatchObject({ entries: 1, stalePaths: [] });
      expect(await readFile(join(root, 'main.mjs'), 'utf8')).toContain('42');
    } else {
      expect(run.error).toContain('modified host control file');
      expect(await readFile(join(root, 'main.mjs'), 'utf8')).toContain('0');
    }
  } finally { await runtime?.shutdown(); await rm(root,{recursive:true,force:true}); await rm(scripts,{recursive:true,force:true}); }
});

it('invalidates changed source excerpts on compiler repair and retains unchanged dependency evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recast-handoff-repair-'));
  const scripts = await mkdtemp(join(tmpdir(), 'recast-handoff-repair-cli-'));
  let runtime: CodexWorkspaceTranslationRuntime | undefined;
  try {
    await writeFile(join(root,'main.mjs'),'export const value = 0;\n');
    await writeFile(join(root,'ports.mjs'),'export const required = 42;\n');
    const cli=join(scripts,'codex.mjs');
    const plan='# Plan\nUse required.\nEvidence: `target/main.mjs:1-1`, `target/ports.mjs:1-1`.';
    await writeFile(cli,`import fs from 'node:fs';
const prompt=fs.readFileSync(0,'utf8');const out=process.argv[process.argv.indexOf('--output-last-message')+1];
if(prompt.includes('You are the Analyzer Codex')) fs.writeFileSync(out,${JSON.stringify(plan)});
else {
 const old=fs.readFileSync('target/main.mjs','utf8');const second=old.includes('41');
 const packet=JSON.parse(fs.readFileSync('CODEX_ANALYSIS_EVIDENCE.json','utf8'));
 if(second&&(packet.entries.length!==1||!packet.stalePaths.includes('target/main.mjs')))throw Error('Stale implementation was retained');
 if(!packet.entries.some(e=>e.path==='target/ports.mjs'))throw Error('Unchanged contract disappeared');
 fs.writeFileSync('target/main.mjs','export const value = '+(second?'42':'41')+';\\n');fs.writeFileSync(out,'Implemented value.');
}`);
    runtime=new CodexWorkspaceTranslationRuntime({workspaceRoot:root,codexCommand:cli,maxModelTurns:3,
      compileCommand:{executable:process.execPath,args:['-e',"import('./main.mjs').then(m=>require('node:assert/strict').equal(m.value,42))"]}});
    const started=runtime.start({spec:'value must equal 42',sourceLanguage:'JavaScript',targetLanguage:'JavaScript',context:[],workspaceFiles:['main.mjs','ports.mjs'],writeFiles:['main.mjs']});
    let run=started;
    for(let i=0;i<100&&['analyzing','translating','compiling'].includes(run.status);i++){await new Promise(resolve=>setTimeout(resolve,50));run=runtime.get(started.id);}
    expect(run.status,run.error).toBe('completed');
    expect(run.compilations.map(item=>item.success)).toEqual([false,true]);
    expect(run.agent?.stages?.at(-1)?.analysisEvidence).toMatchObject({entries:1,stalePaths:['target/main.mjs']});
  } finally {await runtime?.shutdown();await rm(root,{recursive:true,force:true});await rm(scripts,{recursive:true,force:true});}
});
