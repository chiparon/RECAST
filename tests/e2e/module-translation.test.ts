import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { prepareModuleTranslationScope } from '../../apps/vscode-extension/src/module-translation-handoff';
import { WorkspaceTranslationHost } from '../../apps/vscode-extension/src/workspace-translation-host';
import { createHttpServer, WorkspaceTranslationRuntime, type WorkspaceTranslationModelClient } from '@forexplore/adaptation-service';
import { withLocalServer } from '../local-server';

const targetFile = 'quote.mts';
const skeleton = 'export function quoteLimit(): number { throw new Error("TODO"); }\n';
const implementation = 'export function quoteLimit(): number { return 10; }\n';
const verification = `import assert from 'node:assert/strict';
import { quoteLimit } from './quote.mts';
assert.equal(quoteLimit(), 10);
`;

function quoteModel(): WorkspaceTranslationModelClient {
  const plan = {
    summary: 'Restore the quote limit', dependencies: [],
    mappings: [{ source: 'Quote.limit', targetPath: targetFile, targetSymbol: 'quoteLimit' }],
    steps: [{ id: 'limit', description: 'Implement quoteLimit', files: [targetFile], dependsOn: [] }],
  };
  const calls: Array<[string, object?]> = [
    ['submit_plan', plan], ['read_file', { path: targetFile }],
    ['write_file', { path: targetFile, expectedHash: createHash('sha256').update(skeleton).digest('hex'), content: implementation }],
    ['complete_step', { stepId: 'limit' }], ['compile'], ['run_tests'], ['finish'],
  ];
  return { async complete() {
    const next = calls.shift();
    if (!next) throw new Error('Unexpected model turn for the quote module');
    const [name, args] = next;
    return { content: '', toolCalls: [{ id: name, name, arguments: JSON.stringify(args ?? {}) }] };
  } };
}

it('translates a reviewed module once, verifies its behavior, then rolls it back from a fresh host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recast-quote-'));
  let runtime: WorkspaceTranslationRuntime | undefined;
  try {
    await writeFile(join(root, targetFile), skeleton);
    await writeFile(join(root, 'verify.mjs'), verification);
    const scope = await prepareModuleTranslationScope({
      workspaceRoot: root, requirement: 'Restore the historical quote limit.', decisionNotes: '',
      target: { id: 'quote', name: 'Quote', kind: 'module', path: targetFile, language: 'TypeScript', signature: 'quoteLimit()',
        module: { sourceFiles: [targetFile], coreApis: ['quoteLimit'], dependsOn: [] } },
      candidate: { id: 'legacy', title: 'Quote', kind: 'module', repository: 'history', language: 'Java', license: 'MIT',
        path: 'Quote.java', signature: 'int limit()', summary: 'Limit policy', preview: 'int limit() { return 10; }',
        score: { overall: 1, semantic: 1, symbol: 1, contract: 1 }, dependencies: [], compatibility: [], risks: [],
        sourceModule: { repositoryId: 'history', analysisRevision: 'rev-1', projectId: 'legacy-project',
          moduleId: 'quote', name: 'Quote', projectPath: '.', sourceFiles: ['Quote.java'] } },
    });
    const compiler = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url));
    runtime = new WorkspaceTranslationRuntime({
      workspaceRoot: root, client: quoteModel(),
      compileCommand: { executable: process.execPath, args: [compiler, '--noEmit', '--skipLibCheck', '--strict',
        '--module', 'nodenext', '--target', 'es2022', targetFile] },
      verification: { command: { executable: process.execPath, args: ['verify.mjs'] }, protectedFiles: ['verify.mjs'] },
    });
    const token = 'locally-issued-quote-translation-test-token';
    const server = createHttpServer({ adapter: { async adapt() { throw new Error('Unexpected legacy adaptation'); } },
      workspaceTranslation: { runtime, bearerToken: token } });
    await withLocalServer(server, async url => {
      const host = new WorkspaceTranslationHost(() => ({ url, token }));
      const moduleScopeId = host.rememberModuleScope(scope);
      const described = await host.handle({ type: 'WORKSPACE_TRANSLATION', action: 'describe', requestId: 'describe', moduleScopeId });
      assert(described.type === 'WORKSPACE_TRANSLATION_RESULT' && described.profile, JSON.stringify(described));
      expect(described.profile).toMatchObject({ behavioralVerification: true, writeFiles: [targetFile] });

      const start = (requestId: string) => host.handle({ type: 'WORKSPACE_TRANSLATION', action: 'start', requestId,
        moduleScopeId, profileId: described.profile!.profileId });
      const [first, duplicate] = await Promise.all([start('start'), start('second click')]);
      assert(first.type === 'WORKSPACE_TRANSLATION_RESULT' && first.run, JSON.stringify(first));
      expect(duplicate).toMatchObject({ type: 'WORKSPACE_TRANSLATION_RESULT', run: { id: first.run.id } });
      const runId = first.run.id;

      const read = async () => {
        const reply = await host.handle({ type: 'WORKSPACE_TRANSLATION', action: 'read', requestId: 'review', runId });
        assert(reply.type === 'WORKSPACE_TRANSLATION_RESULT' && reply.run, JSON.stringify(reply));
        return reply.run;
      };
      await expect.poll(async () => (await read()).status, { timeout: 20_000 })
        .toMatch(/^(completed|failed|interrupted|cancelled)$/);
      expect(await read()).toMatchObject({ status: 'completed', acceptance: 'behavior-verified',
        changes: [{ path: targetFile, applied: true }], verification: { runs: [{ success: true, exitCode: 0 }] } });
      expect(await readFile(join(root, targetFile), 'utf8')).toBe(implementation);

      const freshHost = new WorkspaceTranslationHost(() => ({ url, token }));
      const rollback = await freshHost.handle({ type: 'WORKSPACE_TRANSLATION', action: 'rollback', requestId: 'undo', runId });
      expect(rollback).toMatchObject({ type: 'WORKSPACE_TRANSLATION_RESULT', run: { status: 'rolled-back' } });
      expect(await readFile(join(root, targetFile), 'utf8')).toBe(skeleton);
      expect(await readFile(join(root, 'verify.mjs'), 'utf8')).toBe(verification);
    });
  } finally {
    await runtime?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
