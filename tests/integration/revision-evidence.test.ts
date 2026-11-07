import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpWorkspaceEvidencePort } from '@forexplore/adaptation-service';
import { createCodeIntelligenceRuntime, createSemanticQueryHttpServer } from '@forexplore/code-intelligence-service';
import { expect, it } from 'vitest';
import { withLocalServer } from '../local-server';

it('retrieves the selected revision after the repository has been reindexed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recast-history-'));
  const runtime = await createCodeIntelligenceRuntime();
  const repositoryId = 'history';
  const bearerToken = 'test-only-semantic-query';
  try {
    await runtime.registry.register({ repositoryId, role: 'history', displayName: 'Quote policy', localPath: root });
    const file = join(root, 'policy.ts');
    await writeFile(file, 'export function quoteLimit() { return 10; }\n');
    const original = await runtime.coordinator.run({ repositoryId });
    await writeFile(file, 'export function quoteLimit() { return 20; }\n');
    const updated = await runtime.coordinator.run({ repositoryId });
    expect(updated.scope.analysisRevision).not.toBe(original.scope.analysisRevision);

    await withLocalServer(createSemanticQueryHttpServer({ queryPort: runtime.queryPort, bearerToken }), async endpoint => {
      const requirement = 'Use the historical quoteLimit';
      const consumer = new HttpWorkspaceEvidencePort({ endpoint, bearerToken });
      for (const [scope, expectedReturn] of [[original.scope, 'return 10'], [updated.scope, 'return 20']] as const) {
        const result = await consumer.query({ requirement, limit: 1, scopes: [scope] });
        expect(result.evidence).toHaveLength(1);
        expect(result.evidence[0]).toMatchObject({
          repositoryId, analysisRevision: scope.analysisRevision, relativePath: 'policy.ts',
          content: expect.stringContaining(expectedReturn), truncated: false,
        });
      }
      const unauthenticated = new HttpWorkspaceEvidencePort({ endpoint });
      await expect(unauthenticated.query({ requirement, limit: 1, scopes: [original.scope] }))
        .rejects.toThrow(/Unauthorized/);
    });
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
