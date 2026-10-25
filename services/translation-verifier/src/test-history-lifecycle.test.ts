import { afterEach, expect, it, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { ScriptedChatModel } from '../test-support/scripted-chat-model.js';
import { createSingleFunctionFixture, TEST_PATH } from '../test-support/single-function-fixture.js';
import { createLangChainFunctionGroupAgentHost } from './host/agent/langchain-runtime.js';
import { createFunctionGroupVerifier } from './function-group-verify.js';
import type { RequirementFunctionGroupVerificationInput } from './types.js';
import type { TestChangeReview } from './host/verification/test-history.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const call = (name: string, args: Record<string, unknown> = {}) => new AIMessage({ content: '', tool_calls: [{ id: Math.random().toString(), name, args, type: 'tool_call' }] });
const final = () => new AIMessage({ content: JSON.stringify({ verdict: 'no-bug', summary: 'Current tests pass.' }) });
async function fixture(test = 'class BehaviorTest { /* FAILING */ }') {
  const f = await createSingleFunctionFixture(roots, test);
  const input: RequirementFunctionGroupVerificationInput = { schemaVersion: '3.1', mode: 'requirement', sourceLanguage: 'Java', targetLanguage: 'Java',
    targetProjectPath: f.root, requirement: 'targetFn must reject expired tenants.', functions: [{ target: f.input.subject.targetFunction }] };
  return { ...f, input, resolveToolContext: async (task: { functionGroup?: unknown }) => ({ ...await f.resolveToolContext(), functionGroup: task.functionGroup as typeof input }) };
}

it.each([true, false])('checks changed failing assertions in one batch and accepts only justified corrections: %s', async approved => {
  const f = await fixture();
  const review = vi.fn(async (_input: TestChangeReview) => ({ approved, note: approved ? 'The original assertion used an incorrect expiry boundary; the corrected assertion preserves tenant rejection.' : 'The failed tenant rejection assertion was removed.' }));
  const model = new ScriptedChatModel([
    () => call('run_function_group_tests'),
    () => call('write_target_test', { path: TEST_PATH, content: 'class BehaviorTest { /* corrected boundary */ }' }),
    () => call('run_function_group_tests'), final,
  ]);
  const result = await createFunctionGroupVerifier(createLangChainFunctionGroupAgentHost({ model, resolveToolContext: f.resolveToolContext, reviewTestChanges: review }))(f.input, 'requirement-function-group', 'verify');
  expect(result.status).toBe(approved ? 'success' : 'failure');
  expect(review).toHaveBeenCalledOnce();
  expect(review.mock.calls[0]?.[0]).toMatchObject({ requirement: f.input.requirement, failures: [{ test: 'BehaviorTest#requirement', original: [{ path: TEST_PATH, content: expect.stringContaining('FAILING') }] }] });
  expect(result.testEvidence!.failures[0]!.status).toBe(approved ? 'resolved' : 'unresolved');
  if (!approved) expect(result).toMatchObject({ issue: { kind: 'unknown' }, reason: 'unresolved-test-failure' });
});

it('does not review compile-only repairs or normal green runs', async () => {
  for (const initial of ['class BehaviorTest { /* BROKEN */ }', 'class BehaviorTest { /* already passing */ }']) {
    const f = await fixture(initial), review = vi.fn();
    const model = new ScriptedChatModel([
      () => call('run_function_group_tests'),
      () => call('write_target_test', { path: TEST_PATH, content: 'class BehaviorTest { /* fixed import */ }' }), final,
    ]);
    const result = await createFunctionGroupVerifier(createLangChainFunctionGroupAgentHost({ model, resolveToolContext: f.resolveToolContext, reviewTestChanges: review }))(f.input, 'requirement-function-group', 'verify');
    expect(result.status).toBe('success'); expect(review).not.toHaveBeenCalled();
  }
});

it('does not review an unchanged test that passes after production is fixed', async () => {
  const f = await fixture(), review = vi.fn();
  const runner = await readFile(join(f.root, 'fake-runner.cjs'), 'utf8');
  await writeFile(join(f.root, 'fake-runner.cjs'), runner.replace("content.includes('FAILING')", "content.includes('FAILING') && !fs.readFileSync('src/Target.java','utf8').includes('FIXED')"));
  const model = new ScriptedChatModel([
    () => call('run_function_group_tests'),
    async () => { await writeFile(join(f.root, 'src/Target.java'), 'class Target { int targetFn() { return 2; } /* FIXED */ }'); return final(); },
  ]);
  const result = await createFunctionGroupVerifier(createLangChainFunctionGroupAgentHost({ model, resolveToolContext: f.resolveToolContext, reviewTestChanges: review }))(f.input, 'requirement-function-group', 'verify');
  expect(result.status).toBe('success'); expect(review).not.toHaveBeenCalled();
  expect(result.testEvidence!.failures[0]!.resolution?.kind).toBe('unchanged-test-replayed');
});

it('carries failed assertions through an interrupted run and checks them after resume', async () => {
  const f = await fixture(), review = vi.fn(async () => ({ approved: false, note: 'Required rejection was removed.' }));
  const interrupted = new ScriptedChatModel([() => call('run_function_group_tests'), () => { throw new Error('interrupted'); }]);
  const error = await createFunctionGroupVerifier(createLangChainFunctionGroupAgentHost({ model: interrupted, resolveToolContext: f.resolveToolContext }))(f.input, 'requirement-function-group', 'verify').catch(error => error);
  expect(error.testEvidence.failures).toHaveLength(1);
  await writeFile(join(f.root, TEST_PATH), 'class BehaviorTest { /* weakened */ }');
  const result = await createFunctionGroupVerifier(createLangChainFunctionGroupAgentHost({ model: new ScriptedChatModel([final]), resolveToolContext: f.resolveToolContext, reviewTestChanges: review }))({ ...f.input, testEvidence: error.testEvidence }, 'requirement-function-group', 'verify');
  expect(result.status).toBe('failure'); expect(review).toHaveBeenCalledOnce();
});

it('reaches correction review for evidence above the former local size limit', async () => {
  const f = await fixture(`class BehaviorTest { /* FAILING ${'x'.repeat(170_000)} */ }`);
  const review = vi.fn(async (_input: TestChangeReview) => ({ approved: true, note: 'The fixture correction preserves rejection.' }));
  const model = new ScriptedChatModel([
    () => call('run_function_group_tests'),
    () => call('write_target_test', { path: TEST_PATH, content: 'class BehaviorTest { /* corrected boundary */ }' }),
    final,
  ]);
  const result = await createFunctionGroupVerifier(createLangChainFunctionGroupAgentHost({ model, resolveToolContext: f.resolveToolContext, reviewTestChanges: review }))(f.input, 'requirement-function-group', 'verify');
  expect(result.status).toBe('success');
  expect(review).toHaveBeenCalledOnce();
  expect(JSON.stringify(review.mock.calls[0]![0]).length).toBeGreaterThan(160_000);
  expect(result.testEvidence!.failures.every(failure => failure.status === 'resolved')).toBe(true);
});

it('uses the default model reviewer to deduplicate a large batch through the real Host', async () => {
  const f = await fixture(`class BehaviorTest { /* FAILING ${'x'.repeat(28_000)} */ }`);
  const runner = await readFile(join(f.root, 'fake-runner.cjs'), 'utf8');
  const cases = Array.from({ length: 12 }, (_, i) => `<testcase classname="BehaviorTest" name="case${i}"><failure message="expected rejection"/></testcase>`).join('');
  await writeFile(join(f.root, 'fake-runner.cjs'), runner.replace('process.exitCode = 1;',
    `fs.writeFileSync(surefire, ${JSON.stringify(`<testsuite tests="12" failures="12" errors="0" skipped="0">${cases}</testsuite>`)}); process.exitCode = 1;`));
  const model = new ScriptedChatModel([
    () => call('run_function_group_tests'),
    () => call('write_target_test', { path: TEST_PATH, content: 'class BehaviorTest { /* corrected boundary */ }' }), final,
    messages => {
      const payload = JSON.parse(String(messages.at(-1)!.content));
      expect(payload.failures).toHaveLength(12);
      expect(payload.files).toHaveLength(3);
      expect(new Set(payload.failures.flatMap((failure: { original: string[] }) => failure.original)).size).toBe(1);
      return new AIMessage({ content: JSON.stringify({ approved: true, note: 'The corrected boundary retains the scenarios.' }) });
    },
  ]);
  vi.spyOn(model, 'getNumTokens').mockImplementation(async content => Math.ceil(String(content).length / 4));
  const result = await createFunctionGroupVerifier(createLangChainFunctionGroupAgentHost({ model, resolveToolContext: f.resolveToolContext }))(f.input, 'requirement-function-group', 'verify');
  expect(result.status).toBe('success');
  expect(result.testEvidence!.failures).toHaveLength(12);
  expect(result.testEvidence!.failures.every(failure => failure.resolution?.kind === 'reviewed-test-correction')).toBe(true);
  expect(model.observations).toHaveLength(4);
});
