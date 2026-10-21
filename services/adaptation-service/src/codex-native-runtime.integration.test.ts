import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CodexWorkspaceTranslationRuntime } from './codex-workspace-translation-runtime';
import { prepareDeepSeekCodexHome } from './codex-experiment-home';

// Opt in on a platform with Codex installed. Only model responses are local
// fixtures: the CLI, sandbox, shell tools, staging and compilation are real.
it.runIf(process.env.RECAST_CODEX_NATIVE_TEST === '1')('uses native Codex tools to read history, edit staging and compile without remote inference', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'recast-native-runtime-'));
  const observed: Array<{ stage: string; output: string }> = [];
  let responseId = 0;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const text = JSON.stringify(body.input);
      const stage = text.includes('Analyzer Codex') ? 'analyzer' : 'translator';
      const toolResult = body.input?.findLast((item: any) => item.type === 'function_call_output');
      let item: Record<string, unknown>;
      if (!toolResult) {
        assert.ok(body.tools.some((tool: any) => tool.name === 'exec_command'));
        const script = `const fs=require('node:fs');const assert=require('node:assert/strict');
assert.match(fs.readFileSync('history-view/source/Legacy.java','utf8'),/42/);
assert.ok(fs.readFileSync('target/main.mjs','utf8').includes('answer'));
${stage === 'translator' ? "fs.mkdirSync('.agent-tmp',{recursive:true});fs.writeFileSync('.agent-tmp/native.patch','*** Begin Patch\\n*** Update File: target/main.mjs\\n@@\\n-export function answer() { return 0; }\\n+export function answer() { return 42; }\\n*** End Patch');" : ''}
console.log('RECAST_NATIVE_TOOLS_OK');`;
        const quote = (value: string) => process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'"'"'`)}'`;
        // Do not use shell quoting for source text: pass a fixed base64 payload.
        const code = `eval(Buffer.from('${Buffer.from(script).toString('base64')}','base64').toString())`;
        const command = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} -e ${quote(code)}` +
          (stage === 'translator' ? `; ${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} RECAST_APPLY_PATCH.cjs .agent-tmp/native.patch` : '');
        item = { type: 'function_call', id: `fc_${++responseId}`, call_id: `call_${responseId}`, name: 'exec_command',
          arguments: JSON.stringify({ cmd: command, login: false, yield_time_ms: 1000 }) };
      } else {
        const output = typeof toolResult.output === 'string' ? toolResult.output : JSON.stringify(toolResult.output);
        observed.push({ stage, output });
        const completed = output.includes(stage === 'translator' ? 'Success. Updated the following files:' : 'RECAST_NATIVE_TOOLS_OK') && !/blocked by policy|exec_command failed/.test(output);
        const message = !completed ? JSON.stringify({ status: 'blocked', summary: output })
          : stage === 'analyzer' ? 'Implement answer from the validated read-only reference; preserve the public function.'
          : JSON.stringify({ status: 'completed', summary: 'Implemented answer using the staged reference.' });
        item = { type: 'message', id: `msg_${++responseId}`, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: message, annotations: [] }] };
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (type: string, payload: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      emit('response.created', { response: { id: `response_${responseId}`, status: 'in_progress', output: [] } });
      emit('response.output_item.added', { output_index: 0, item });
      emit('response.output_item.done', { output_index: 0, item });
      emit('response.completed', { response: { id: `response_${responseId}`, status: 'completed', output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      response.end();
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  let runtime: CodexWorkspaceTranslationRuntime | undefined;
  let home: Awaited<ReturnType<typeof prepareDeepSeekCodexHome>> | undefined;
  try {
    await writeFile(path.join(root, 'main.mjs'), 'export function answer() { return 0; }\n');
    const runId = '11111111-2222-3333-4444-555555555555';
    const history = path.join(root, '.forexpore/history-views', runId);
    await mkdir(path.join(history, 'source'), { recursive: true });
    const content = 'class Legacy { int answer() { return 42; } }';
    const sha256 = createHash('sha256').update(content).digest('hex');
    await writeFile(path.join(history, 'source/Legacy.java'), content);
    const identity = { repositoryId: 'history', analysisRevision: 'r1', moduleId: 'legacy', runId };
    await writeFile(path.join(history, 'manifest.json'), JSON.stringify({ ...identity, files: [{ path: 'Legacy.java', sha256 }] }));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    home = await prepareDeepSeekCodexHome({ apiKey: 'local-fixture', model: 'fixture', baseUrl: `http://127.0.0.1:${port}/v1` });
    runtime = new CodexWorkspaceTranslationRuntime({ workspaceRoot: root, codexHome: home.path,
      environment: home.environment, codexCommand: process.env.RECAST_CODEX_COMMAND || 'codex', timeoutMs: 120_000,
      compileCommand: { executable: process.execPath, args: ['--check', 'main.mjs'] } });
    const run = runtime.start({ spec: 'answer must return 42', sourceLanguage: 'Java', targetLanguage: 'JavaScript', context: [],
      workspaceFiles: ['main.mjs'], writeFiles: ['main.mjs'], historyView: { ...identity, root: history, files: ['Legacy.java'],
        manifestHash: createHash('sha256').update(JSON.stringify([['Legacy.java', sha256]])).digest('hex') } });
    let result = run;
    while (['analyzing', 'translating', 'compiling'].includes(result.status)) {
      await new Promise(resolve => setTimeout(resolve, 100)); result = runtime.get(run.id);
    }
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('completed');
    expect(observed.map(item => item.stage)).toEqual(['analyzer', 'translator']);
    expect(result.agent?.stages?.every(item => item.commands?.some(command => command.exitCode === 0))).toBe(true);
    expect(result.compilations.at(-1)?.success).toBe(true);
    expect(await readFile(path.join(root, 'main.mjs'), 'utf8')).toContain('return 42');
  } finally {
    await runtime?.shutdown(); server.closeAllConnections(); server.close(); await home?.cleanup();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}, 150_000);
