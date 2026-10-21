import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexWorkspaceTranslationRuntime as CurrentRuntime } from '../services/adaptation-service/src/codex-workspace-translation-runtime';
import { prepareDeepSeekCodexHome } from '../services/adaptation-service/src/codex-experiment-home';
import { resolveCodexCommand } from '../services/adaptation-service/src/codex-command';

// This comparison uses real CLI/sandbox/files/patches/Host checks. Only model
// decisions are deterministic local Responses fixtures, so it cannot measure
// paid-model reasoning speed or promise a full project's wall-clock speedup.
const require = createRequire(import.meta.url);
const option = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const baselineFile = option('--baseline-runtime');
assert.ok(baselineFile, '--baseline-runtime must point to a bundle captured before the change');
const BeforeRuntime = require(path.resolve(baselineFile)).CodexWorkspaceTranslationRuntime as typeof CurrentRuntime;
const output = path.resolve(option('--output') || 'output/translation-efficiency-validation');
await mkdir(output, { recursive: true });
const quote = (value: string) => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : `'"'"'`)}'`;
const shellNode = (script: string) => `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} -e ${quote(`eval(Buffer.from('${Buffer.from(script).toString('base64')}','base64').toString())`)}`;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const plan = '# Implementation\nUse the public limit and historical acceptance predicate; preserve tenant isolation and reject invalid amounts.\n' +
  '## Evidence\n- `target/contracts.mjs:1-1` — limit, public cross-module dependency.\n' +
  '- `history-view/source/Legacy.mjs:1-3` — accept, tenant and amount boundary behavior.\n' +
  '## Steps\nRead the current target, implement accept using limit, and retain all public exports.\n';
const implementation = "import { limit } from './contracts.mjs';\nexport function accept(tenant, amount) { return tenant === 'tenant-a' && Number.isInteger(amount) && amount >= 0 && amount <= limit; }\n";
const initial = "import { limit } from './contracts.mjs';\nexport function accept(tenant, amount) { return false; }\n";
const patch = ['*** Begin Patch', '*** Update File: target/main.mjs', '@@', ...initial.trimEnd().split('\n').map(line => '-' + line), ...implementation.trimEnd().split('\n').map(line => '+' + line), '*** End Patch'].join('\n');
const cases: any[] = [];

for (const [label, Runtime] of [['before', BeforeRuntime], ['after', CurrentRuntime]] as const) {
  const root = await mkdtemp(path.join(tmpdir(), 'recast-efficiency-'));
  const launcher = await resolveCodexCommand(process.env.RECAST_CODEX_COMMAND || 'codex', { cwd: root, environment: process.env });
  const protocol = { calls: 0, requestChars: 0, reads: [] as any[], toolFailures: 0, toolOutputs: [] as any[] };
  const stageTurns = { analyzer: 0, translator: 0 };
  let responseId = 0;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      protocol.calls++; protocol.requestChars += JSON.stringify(body.input).length;
      const analyzer = JSON.stringify(body.input).includes('You are the Analyzer Codex');
      const stage = analyzer ? 'analyzer' : 'translator';
      const tool = body.input?.findLast((item: any) => item.type === 'function_call_output');
      const toolOutput = typeof tool?.output === 'string' ? tool.output : JSON.stringify(tool?.output ?? '');
      if (tool) {
        protocol.toolOutputs.push({ stage, tail: toolOutput.slice(-1800) });
        const metrics = toolOutput.match(/RECAST_READ_METRICS=(\{[^\n]+\})/);
        if (metrics) protocol.reads.push({ stage, ...JSON.parse(metrics[1]!) });
        if (/Exit code: [1-9]|exited with code [1-9]/i.test(toolOutput)) protocol.toolFailures++;
      }
      let item: any;
      const turn = stageTurns[stage]++;
      if (turn === 0) {
        let script: string;
        let suffix = '';
        if (analyzer) script = "const fs=require('node:fs');console.log(fs.readFileSync('target/contracts.mjs','utf8').split('\\n')[0]);console.log(fs.readFileSync('history-view/source/Legacy.mjs','utf8').split('\\n').slice(0,3).join('\\n'));";
        else {
          const optimized = JSON.stringify(body.input).includes('Host patch entry:');
          script = `const fs=require('node:fs'),cp=require('node:child_process');
let bytes=0;const paths=[];function read(file){const value=fs.readFileSync(file,'utf8');bytes+=Buffer.byteLength(value);paths.push(file);console.log(value);return value;}
read('CODEX_IMPLEMENTATION_PLAN.md');read('target/main.mjs');
${optimized ? `const packet=JSON.parse(read('CODEX_ANALYSIS_EVIDENCE.json'));if(packet.entries.length!==2||packet.stalePaths.length)throw Error('Missing current evidence');`
  : `read('target/contracts.mjs');read('history-view/source/Legacy.mjs');`}
console.log('RECAST_READ_METRICS='+JSON.stringify({bytes,paths}));
fs.mkdirSync('.agent-tmp',{recursive:true});const patch=${JSON.stringify(patch)};fs.writeFileSync('.agent-tmp/change.patch',patch);
${optimized ? `const result={status:0};`
  : process.platform === 'win32'
    ? `fs.writeFileSync('.agent-tmp/legacy-apply-patch.bat',${JSON.stringify('@echo off\r\n' + [launcher.executable, ...launcher.args].map(value => '"' + value + '"').join(' ') + ' --codex-run-as-apply-patch %*\r\n')});fs.writeFileSync('.agent-tmp/legacy.ps1',"$patch = @'\\n"+patch+"\\n'@\\n& ./.agent-tmp/legacy-apply-patch.bat $patch\\nexit $LASTEXITCODE\\n");const result={status:0};`
    : `fs.writeFileSync('.agent-tmp/legacy.sh',"apply_patch <<'RECAST_PATCH'\\n"+patch+"\\nRECAST_PATCH\\n");const result={status:0};`}
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');if(result.error)console.error('PATCH_LAUNCH_ERROR='+result.error.message);process.exitCode=result.status??1;`;
          suffix = optimized ? `; ${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} RECAST_APPLY_PATCH.cjs .agent-tmp/change.patch`
            : process.platform === 'win32' ? '; & powershell.exe -NoProfile -File .agent-tmp/legacy.ps1' : '; sh .agent-tmp/legacy.sh';
        }
        item = { type: 'function_call', id: `fc_${++responseId}`, call_id: `call_${responseId}`, name: 'exec_command',
          arguments: JSON.stringify({ cmd: shellNode(script) + suffix, login: false, yield_time_ms: 10000, max_output_tokens: 20000 }) };
      } else if (!analyzer && turn === 1 && !toolOutput.includes('Success. Updated the following files:')) {
        const script = `const fs=require('node:fs');fs.writeFileSync('target/main.mjs',${JSON.stringify(implementation)});console.log('Baseline recovery wrote the intended production bytes directly.');`;
        item = { type: 'function_call', id: `fc_${++responseId}`, call_id: `call_${responseId}`, name: 'exec_command',
          arguments: JSON.stringify({ cmd: shellNode(script), login: false, yield_time_ms: 10000 }) };
      } else {
        const text = analyzer ? plan : JSON.stringify({ summary: 'Implemented the unchanged tenant/amount requirements.' });
        item = { type: 'message', id: `msg_${++responseId}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (type: string, payload: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      emit('response.created', { response: { id: `r_${responseId}`, status: 'in_progress', output: [] } });
      emit('response.output_item.added', { output_index: 0, item });
      emit('response.output_item.done', { output_index: 0, item });
      emit('response.completed', { response: { id: `r_${responseId}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      response.end();
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  let runtime: InstanceType<typeof CurrentRuntime> | undefined;
  let home: Awaited<ReturnType<typeof prepareDeepSeekCodexHome>> | undefined;
  try {
    await writeFile(path.join(root, 'main.mjs'), initial);
    await writeFile(path.join(root, 'contracts.mjs'), 'export const limit = 42;\n' + '// unrelated contract detail\n'.repeat(500));
    const history = path.join(root, '.forexpore/history-views/11111111-2222-3333-4444-555555555555');
    await mkdir(path.join(history, 'source'), { recursive: true });
    const source = 'export function accept(tenant, amount, limit) {\n  return tenant === "tenant-a" && Number.isInteger(amount) && amount >= 0 && amount <= limit;\n}\n' + '// unrelated historical implementation\n'.repeat(500);
    await writeFile(path.join(history, 'source/Legacy.mjs'), source);
    const identity = { repositoryId: 'history', analysisRevision: 'r1', moduleId: 'legacy', runId: '11111111-2222-3333-4444-555555555555' };
    await writeFile(path.join(history, 'manifest.json'), JSON.stringify({ ...identity, files: [{ path: 'Legacy.mjs', sha256: sha(source) }] }));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    home = await prepareDeepSeekCodexHome({ apiKey: 'local-fixture', model: 'fixture', baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` });
    const checks = `import('./main.mjs').then(({accept})=>{const a=require('node:assert/strict');for(let n=-5;n<=50;n++){a.equal(accept('tenant-a',n),n>=0&&n<=42);a.equal(accept('tenant-b',n),false);}for(const n of [null,undefined,NaN,1.5,'1'])a.equal(accept('tenant-a',n),false);})`;
    runtime = new Runtime({ workspaceRoot: root, codexHome: home.path, environment: home.environment, timeoutMs: 120000,
      codexCommand: process.env.RECAST_CODEX_COMMAND || 'codex', compileCommand: { executable: process.execPath, args: ['-e', checks], timeoutMs: 10000 } });
    const started = Date.now();
    const startedRun = runtime.start({ spec: 'Accept tenant-a only, with integer amount from 0 through the public limit inclusive. Preserve cross-module contracts.', sourceLanguage: 'JavaScript', targetLanguage: 'JavaScript', context: [],
      workspaceFiles: ['main.mjs', 'contracts.mjs'], writeFiles: ['main.mjs'], historyView: { ...identity, root: history, files: ['Legacy.mjs'], manifestHash: sha(JSON.stringify([['Legacy.mjs', sha(source)]])) } });
    let run = startedRun;
    while (['analyzing', 'translating', 'compiling', 'testing'].includes(run.status)) {
      await new Promise(resolve => setTimeout(resolve, 100)); run = runtime.get(run.id);
    }
    await writeFile(path.join(output, `${label}-observed.json`), JSON.stringify({ status: run.status, error: run.error, protocol, compilations: run.compilations }, null, 2) + '\n');
    assert.equal(run.status, 'completed', run.error);
    assert.equal(await readFile(path.join(root, 'main.mjs'), 'utf8'), implementation);
    const row = { label, root, durationMs: Date.now() - started, protocol, sourceHash: sha(implementation), hostAssertions: 117,
      compilationPassed: run.compilations.at(-1)?.success, stages: run.agent?.stages };
    cases.push(row);
    await writeFile(path.join(output, `${label}-native.json`), JSON.stringify(row, null, 2) + '\n');
  } finally { await runtime?.shutdown(); server.closeAllConnections(); server.close(); await home?.cleanup(); }
}

const historical: any[] = [];
const records = option('--historical-records');
if (records) {
  for (const file of await readdir(records)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
    const run = JSON.parse(await readFile(path.join(records, file), 'utf8'));
    if (!run.plan?.markdown || run.request?.taskKind === 'project-integration') continue;
    const options = { workspaceRoot: run.workspaceRoot, compileCommand: { executable: process.execPath, args: ['--version'] } };
    const before = new BeforeRuntime(options) as any, after = new CurrentRuntime(options) as any;
    const args = [run.request, 'history-view', run.plan];
    const beforeChars = before.translatorPrompt(...args).length, afterChars = after.translatorPrompt(...args).length;
    historical.push({ runId: run.id, planChars: run.plan.markdown.length, beforePromptChars: beforeChars, afterPromptChars: afterChars,
      savedChars: beforeChars - afterChars, promptReductionPercent: Math.round((1 - afterChars / beforeChars) * 1000) / 10 });
    await before.shutdown(); await after.shutdown();
  }
  assert.ok(historical.length, 'Historical comparison requires at least one real plan');
  assert.ok(historical.every(row => row.savedChars > 0), 'Every historical prompt must have a net input reduction');
}
const before = cases[0]!, after = cases[1]!;
const beforeReads = before.protocol.reads.find((row: any) => row.stage === 'translator');
const afterReads = after.protocol.reads.find((row: any) => row.stage === 'translator');
assert.ok(beforeReads && afterReads, 'CLI must expose actual observed read metrics');
assert.ok(afterReads.bytes < beforeReads.bytes, 'Evidence handoff must reduce actual bytes read');
assert.equal(before.sourceHash, after.sourceHash);
assert.equal(after.stages.at(-1).patchTool.failures, 0);
if (process.platform === 'win32') assert.ok(before.protocol.calls > after.protocol.calls, 'Fixed Windows patch entry must remove a recovery model call');
const result = { platform: process.platform, scope: 'Real native CLI and Host behavior checks; model decisions are deterministic local fixtures, not live-model latency measurements.',
  acceptancePassed: true, historical, comparison: {
    beforeReadBytes: beforeReads.bytes, afterReadBytes: afterReads.bytes, readReductionPercent: Math.round((1 - afterReads.bytes / beforeReads.bytes) * 1000) / 10,
    beforeModelCalls: before.protocol.calls, afterModelCalls: after.protocol.calls, sameSourceHash: before.sourceHash === after.sourceHash,
    hostAssertionsPerRun: 117, bothHostChecksPassed: before.compilationPassed && after.compilationPassed,
    beforeDurationMs: before.durationMs, afterDurationMs: after.durationMs,
  } };
await writeFile(path.join(output, 'acceptance.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
