import { afterEach, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createSingleFunctionFixture, TEST_PATH } from '../../../test-support/single-function-fixture.js';
import { createVerifier } from '../../verify.js';
import { createTranslationVerifierChatModel } from './chat-model.js';
import { createLangChainAgentHost } from './langchain-runtime.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('never executes complete-looking writes from an output-truncated response in the real Host', async () => {
  const original = 'class BehaviorTest { int requirement() { return 1; } }';
  const fixture = await createSingleFunctionFixture(roots, original);
  const frames: Record<string, unknown>[] = [];
  const request: typeof fetch = async (_input, init) => {
    frames.push(JSON.parse(String(init?.body)));
    const first = frames.length === 1;
    return new Response(JSON.stringify({ id: 'completion-' + frames.length, object: 'chat.completion', created: 0, model: 'test',
      choices: [{ index: 0, finish_reason: first ? 'length' : 'stop', message: { role: 'assistant', content: first ? '' : JSON.stringify({ verdict: 'no-bug', summary: 'The original test passes.' }),
        ...(first ? { tool_calls: [{ id: 'discarded-write', type: 'function', function: { name: 'write_target_test', arguments: JSON.stringify({ path: TEST_PATH, content: 'class BehaviorTest { /* incomplete suite */ }' }) } }] } : {}) } }],
      usage: { prompt_tokens: 1, completion_tokens: 16384, total_tokens: 16385 } }), { headers: { 'Content-Type': 'application/json' } });
  };
  const result = await createVerifier(createLangChainAgentHost({ model: createTranslationVerifierChatModel({ apiKey: 'fake-key', request }), resolveToolContext: fixture.resolveToolContext }))(fixture.input, 'single-agent', 'verify');
  expect(result.status).toBe('success');
  expect(await readFile(join(fixture.root, TEST_PATH), 'utf8')).toBe(original);
  expect(frames).toHaveLength(2);
  expect(JSON.stringify(frames[1])).not.toContain('discarded-write');
});
