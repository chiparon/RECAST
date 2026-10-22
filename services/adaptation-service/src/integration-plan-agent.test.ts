import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIntegrationPlanAgent } from './integration-plan-agent';

const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('Integration Plan Agent', () => {
  it('uses only the target skeleton prompt and returns bounded protocol facts', async () => {
    let requestBody: any;
    const result = await runIntegrationPlanAgent({
      targetRoot: process.cwd(),
      requirement: 'Only clean attachments may be released.',
      modules: [{ id: 'attachments', name: 'Attachments', sourceFiles: ['src/Attachment.cs'], coreApis: ['AttachmentService'], dependsOn: [] } as any],
      taskIdentity: 'task-test',
      model: { apiKey: 'test-key', request: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return response({ choices: [{ message: { content: JSON.stringify({
          invariants: [{ id: 'release', rule: 'clean scan before release', source: 'requirement', status: 'fixed', scope: ['attachments'] }],
          boundaries: [], sharedContracts: [], openQuestions: [], evaluator: 'must not persist',
        }) } }] });
      } },
    });
    expect(result.warning).toBeUndefined();
    expect(result.protocol.invariants[0]).toMatchObject({ id: 'release', status: 'fixed' });
    expect(JSON.stringify(result.protocol)).not.toContain('evaluator');
    const prompt = requestBody.messages.map((message: any) => message.content).join('\n');
    expect(prompt).toContain('Target skeleton excerpts');
    expect(prompt).toContain('Do not read or request history repositories');
    expect(prompt).not.toContain('hidden test result');
  });

  it('degrades to an empty protocol on planner failure', async () => {
    const result = await runIntegrationPlanAgent({
      targetRoot: process.cwd(), requirement: 'requirement', modules: [], taskIdentity: 'task-failure',
      model: { apiKey: 'test-key', request: async () => { throw new Error('planner unavailable'); } },
    });
    expect(result.protocol.invariants).toEqual([]);
    expect(result.warning).toContain('planner unavailable');
  });

  it('samples later producer/consumer modules even when an earlier directory fills the file limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'integration-plan-'));
    let prompt = '';
    try {
      await mkdir(join(root, 'a'));
      await mkdir(join(root, 'z'));
      await mkdir(join(root, 'tests'));
      await Promise.all(Array.from({ length: 170 }, (_, index) => writeFile(join(root, 'a', `Type${index}.ts`), 'export interface Early {}')));
      await writeFile(join(root, 'z', 'Consumer.ts'), 'export interface Consumer { consume(item: ReadyItem): void }');
      await writeFile(join(root, 'tests', 'Secret.ts'), 'EXCLUDED_TEST_CONTENT');
      const result = await runIntegrationPlanAgent({
        targetRoot: root, requirement: 'Consume only ready items.', taskIdentity: 'bounded-catalog',
        modules: [
          { id: 'producer', name: 'Producer', sourceFiles: Array.from({ length: 170 }, (_, index) => `a/Type${index}.ts`), coreApis: [], dependsOn: [] } as any,
          { id: 'consumer', name: 'Consumer', sourceFiles: ['z/Consumer.ts'], coreApis: ['Consumer'], dependsOn: ['producer'] } as any,
        ],
        model: { apiKey: 'test-key', request: async (_url, init) => {
          prompt = JSON.parse(String(init?.body)).messages.map((message: any) => message.content).join('\n');
          return response({ choices: [{ message: { content: '{"invariants":[],"boundaries":[],"sharedContracts":[],"openQuestions":[]}' } }] });
        } },
      });
      expect(result.warning).toBeUndefined();
      expect(prompt).toContain('export interface Consumer { consume(item: ReadyItem): void }');
      expect(prompt).toContain('evidenced producer and consumers/callers');
      expect(prompt).toContain('preconditions before side effects');
      expect(prompt).not.toContain('EXCLUDED_TEST_CONTENT');
      expect((prompt.match(/^### /gm) ?? []).length).toBeLessThanOrEqual(160);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps a missing skeleton non-fatal without issuing a model request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'integration-plan-missing-'));
    await rm(root, { recursive: true, force: true });
    let called = false;
    const result = await runIntegrationPlanAgent({
      targetRoot: root, requirement: 'public requirement', modules: [], taskIdentity: 'missing-root',
      model: { apiKey: 'test-key', request: async () => { called = true; throw new Error('unexpected request'); } },
    });
    expect(called).toBe(false);
    expect(result.protocol).toEqual({ version: 1, invariants: [], boundaries: [], sharedContracts: [], openQuestions: [] });
    expect(result.warning).toBeDefined();
  });
});
