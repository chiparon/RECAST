// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { ModuleTarget, SearchCandidate } from '@forexplore/contracts';
import { prepareIntegrationTranslationScope, prepareModuleTranslationScope } from './module-translation-handoff';
import { WorkspaceTranslationHost } from './workspace-translation-host';
import { isWebviewToHostMessage } from './protocol/messages';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'recast-module-handoff-')); roots.push(root);
  await writeFile(path.join(root, 'first.ts'), 'export const first = 0;');
  await writeFile(path.join(root, 'second.ts'), 'export const second = 0;');
  const target: ModuleTarget = { id: 'target', kind: 'module', name: 'Payments', language: 'TypeScript', path: 'first.ts', signature: '',
    module: { sourceFiles: ['first.ts', 'second.ts'], coreApis: ['first'], dependsOn: [] } };
  const candidate: SearchCandidate = { id: 'candidate', kind: 'module', repository: 'history', language: 'Java', path: 'History.java', preview: 'class History {}', dependencies: [],
    title: 'Payments', license: 'MIT', signature: 'first()', summary: 'Payments', compatibility: [], risks: [], score: { overall: 1, semantic: 1, symbol: 1, contract: 1 },
    sourceModule: { repositoryId: 'history-id', analysisRevision: 'revision-1', projectId: 'history-project', projectPath: '', moduleId: 'payments', name: 'Payments', sourceFiles: ['History.java'], coreApis: ['first'] } };
  const input = { workspaceRoot: root, target, candidate, requirement: 'pay', decisionNotes: 'Keep order' };
  const scope = await prepareModuleTranslationScope(input);
  const requests: Array<{ url: string; body?: any }> = [];
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(String(url).endsWith('/configuration') ? { workspaceRoot: root, behavioralVerification: true }
      : { id: '11111111-2222-3333-4444-555555555555', workspaceRoot: root, status: 'completed' }), { status: 200 });
  });
  const host = new WorkspaceTranslationHost(() => ({ url: 'http://127.0.0.1:8788', token: 'x'.repeat(32) }), transport);
  const id = host.rememberModuleScope(scope);
  const describe = { type: 'WORKSPACE_TRANSLATION' as const, requestId: 'describe', action: 'describe' as const, moduleScopeId: id };
  expect(isWebviewToHostMessage(describe)).toBe(true);
  const result = await host.handle(describe);
  if (result.type !== 'WORKSPACE_TRANSLATION_RESULT' || !result.profile) throw new Error(JSON.stringify(result));
  const start = { type: 'WORKSPACE_TRANSLATION' as const, requestId: 'start', action: 'start' as const, moduleScopeId: id, profileId: result.profile.profileId };
  return { root, input, scope, requests, transport, host, id, start, profile: result.profile };
}

it('passes reviewed Java module evidence and both target files without a static profile', async () => {
  const { host, start, requests, profile } = await setup();
  expect(profile).toMatchObject({ sourceLanguage: 'Java', targetLanguage: 'TypeScript', writeFiles: ['first.ts', 'second.ts'] });
  const [first, duplicate] = await Promise.all([host.handle(start), host.handle(start)]);
  expect(first.type).toBe('WORKSPACE_TRANSLATION_RESULT'); expect(duplicate).toEqual(first);
  const posts = requests.filter(request => request.body);
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toMatchObject({ sourceLanguage: 'Java', targetLanguage: 'TypeScript', writeFiles: ['first.ts', 'second.ts'],
    evidenceScopes: [{ repositoryId: 'history-id', analysisRevision: 'revision-1' }] });
  expect(posts[0]!.body.spec).toContain('Keep order');
  expect(posts[0]!.body.context.some((item: any) => item.content.includes('class History'))).toBe(true);
  // Task translation does not implicitly pick up a module selected in another tab.
  const task = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'task', action: 'describe' });
  expect(task.type).toBe('WORKSPACE_TRANSLATION_ERROR');
});

it('keeps the target write scope when three reviewed candidates are selected', async () => {
  const { input } = await setup();
  const candidates = [1, 2, 3].map(index => ({ ...input.candidate, id: `candidate-${index}`,
    sourceModule: { ...input.candidate.sourceModule!, repositoryId: `history-${index}`, moduleId: `module-${index}` } }));
  const scope = await prepareModuleTranslationScope({ ...input, candidates });
  expect(scope.profile.writeFiles).toEqual(['first.ts', 'second.ts']);
  expect(scope.evidenceScopes).toHaveLength(3);
  expect(scope.context.filter(item => item.id.startsWith('module-candidate:'))).toHaveLength(3);
  await expect(prepareModuleTranslationScope({ ...input, candidates: [candidates[0]!, candidates[0]!] })).rejects.toThrow('不同的历史模块');
  await expect(prepareModuleTranslationScope({ ...input, candidates: [...candidates, { ...candidates[0]!, sourceModule: { ...candidates[0]!.sourceModule!, moduleId: 'fourth' } }] })).rejects.toThrow('1～3');
});

it('excludes previous history views and verifier harnesses from target visibility', async () => {
  const { root, input } = await setup();
  for (const directory of ['.forexpore/history-views/old', '.translation-verifier-tests/old/tests', '.translation-verifier-coverage/old', '.agent-tmp']) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, 'private.ts'), 'export const privateEvidence = 1;');
  }
  const scope = await prepareModuleTranslationScope(input);
  expect(scope.profile.workspaceFiles.some(file => file.includes('private.ts'))).toBe(false);
  expect(scope.profile.writeFiles).toEqual(['first.ts', 'second.ts']);
});

it('adds only a referenced target dependency to the interactive write scope', async () => {
  const { root, input } = await setup();
  await writeFile(path.join(root, 'first.ts'), 'import type { PaymentContract } from "./contract";\nexport const first = (value: PaymentContract) => value;');
  await writeFile(path.join(root, 'contract.ts'), 'export interface PaymentContract { id: string; }');
  const related: ModuleTarget = {
    id: `module://${encodeURIComponent(JSON.stringify(['repo-target', 'revision-target', 'project-target', 'module-contract']))}`,
    name: 'Contracts', kind: 'module', path: 'contract.ts', language: 'TypeScript', signature: 'PaymentContract',
    module: { sourceFiles: ['contract.ts'], coreApis: ['PaymentContract'], dependsOn: [] },
  };
  const scope = await prepareModuleTranslationScope({ ...input, relatedModules: [related] });
  expect(scope.profile.writeFiles).toEqual(['first.ts', 'second.ts', 'contract.ts']);
  expect(scope.profile.workspaceFiles).toContain('contract.ts');
  expect(scope.warnings?.some(warning => warning.includes('依赖闭包'))).toBe(true);
});

it('rejects changes to a non-representative module file and permits retry after restoration', async () => {
  const { root, host, start, requests } = await setup();
  await writeFile(path.join(root, 'second.ts'), 'export const second = 42;');
  expect(await host.handle(start)).toMatchObject({ type: 'WORKSPACE_TRANSLATION_ERROR', message: expect.stringContaining('second.ts 已变化') });
  expect(requests.filter(request => request.body)).toHaveLength(0);
  await writeFile(path.join(root, 'second.ts'), 'export const second = 0;');
  expect((await host.handle(start)).type).toBe('WORKSPACE_TRANSLATION_RESULT');
});

it('invalidates same-length requirement changes and a cleared selection before writing', async () => {
  const { host, id, scope, start, requests } = await setup();
  expect(host.rememberModuleScope({ ...scope, spec: scope.spec.replace('pay', 'buy') })).not.toBe(id);
  expect(await host.handle(start)).toMatchObject({ type: 'WORKSPACE_TRANSLATION_ERROR' });
  host.clearModuleScope();
  expect(await host.handle(start)).toMatchObject({ type: 'WORKSPACE_TRANSLATION_ERROR' });
  expect(requests.filter(request => request.body)).toHaveLength(0);
});

it('rechecks the selection after an asynchronous configuration lookup', async () => {
  const { host, start, transport, requests } = await setup();
  transport.mockImplementationOnce(async () => {
    host.clearModuleScope();
    return new Response(JSON.stringify({ workspaceRoot: process.cwd(), behavioralVerification: true }));
  });
  expect(await host.handle(start)).toMatchObject({ type: 'WORKSPACE_TRANSLATION_ERROR', message: expect.stringContaining('范围已变化') });
  expect(requests.filter(request => request.body)).toHaveLength(0);
});

it('does not resubmit a possibly accepted start after a transport failure', async () => {
  const { host, start, transport, root } = await setup();
  let submissions = 0;
  transport.mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') { submissions++; throw new Error('Response lost'); }
    return new Response(JSON.stringify({ workspaceRoot: root, behavioralVerification: true }));
  });
  expect((await host.handle(start)).type).toBe('WORKSPACE_TRANSLATION_ERROR');
  expect((await host.handle(start)).type).toBe('WORKSPACE_TRANSLATION_ERROR');
  expect(submissions).toBe(1);
});

it('carries the complete integration protocol through the scope and Host request', async () => {
  const { root, host, requests } = await setup();
  const protocol = { version: 1 as const, invariants: [{ id: 'rule', rule: 'Public observable guarantee', source: 'requirement' as const, status: 'fixed' as const, scope: ['different-module'] }], boundaries: [], sharedContracts: [], openQuestions: [{ id: 'question', question: 'Unspecified status', source: 'observed' as const, status: 'ambiguous' as const }] };
  const scope = await prepareIntegrationTranslationScope({ workspaceRoot: root, targetLanguage: 'TypeScript', requirement: 'Public requirements', writeFiles: ['first.ts', 'second.ts'], globalProtocol: protocol, context: [{ id: 'integration-module-plans', kind: 'summary', content: 'OLD_MODULE_PLAN' }, { id: 'integration-verification-history', kind: 'summary', content: 'OLD_VERIFY_HISTORY' }] });
  protocol.invariants[0]!.rule = 'Mutated after scope creation';
  const scopeId = host.rememberModuleScope(scope);
  const described = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'integration-describe', action: 'describe', moduleScopeId: scopeId });
  if (described.type !== 'WORKSPACE_TRANSLATION_RESULT' || !described.profile) throw new Error('Missing profile');
  await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'integration-start', action: 'start', moduleScopeId: scopeId, profileId: described.profile.profileId });
  const request = requests.find(item => item.body)?.body;
  expect(request.taskKind).toBe('project-integration');
  expect(request.globalProtocol.invariants[0].rule).toBe('Public observable guarantee');
  expect(request.globalProtocol.openQuestions[0].status).toBe('ambiguous');
  expect(request.context).toEqual([]);
  expect(JSON.stringify(request)).not.toMatch(/OLD_MODULE_PLAN|OLD_VERIFY_HISTORY/);
});


it('checks the actual Integration envelope before submission with the original 2 MiB limit', async () => {
  const { root } = await setup();
  await expect(prepareIntegrationTranslationScope({ workspaceRoot: root, targetLanguage: 'TypeScript',
    requirement: 'Public requirements', writeFiles: ['first.ts'],
    globalProtocol: { version: 1, invariants: [{ id: 'large-public-protocol', rule: '界'.repeat(720_000), source: 'requirement', status: 'fixed' }], boundaries: [], sharedContracts: [], openQuestions: [] },
  })).rejects.toThrow('existing 2 MiB envelope');
});
