import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModuleTarget, ProjectModuleProposal } from '@forexplore/contracts';
import {
  createCodeIntelligenceRuntime,
  ProjectAnalysisCoordinator,
  projectAnalysisObjective,
  projectPlanHash,
  Sag2Bm25IndexStore,
  Sag2SqliteBm25Index,
  searchModulesWithSag2,
  tokenizeSag2Text,
  type Sag2RetrievalDiagnostics,
} from './index.js';
import { searchModules } from './module-matching.js';
import { RecallKernel } from './recall-kernel.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SAG2 embedding-free BM25 + JEV multi-hop retrieval', () => {
  it('uses FTS5 virtual table inverted index first and splits camelCase + CJK tokens', () => {
    const tokens = tokenizeSag2Text('MultipartStream parse_boundary_token 附件签名鉴权', true);
    expect(tokens).toContain('multipartstream');
    expect(tokens).toContain('multipart');
    expect(tokens).toContain('stream');
    expect(tokens).toContain('boundary');
    expect(tokens).toContain('token');
    expect(tokens.some((t) => t.includes('附件') || t.includes('鉴权'))).toBe(true);

    const index = new Sag2SqliteBm25Index();
    try {
      const plan = index.explainQueryPlan();
      expect(plan.some((line) => line.includes('sag2_fts VIRTUAL TABLE INDEX'))).toBe(true);
      expect(plan.some((line) => line.includes('idx_sag2_documents_scope'))).toBe(false);
    } finally {
      index.close();
    }
  });

  it('recovers Hop-2 collaborator modules via JEV contextual evidence and bridge terms when 1-hop BM25 misses them', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sag2-multihop-'));
    roots.push(root);

    await writeFile(path.join(root, 'package.json'), '{"name":"enterprise-workflow"}');
    // Module 1: Anchor module that matches Hop-1 query ("workflow dispatch") and references HmacLedgerEnvelopeSigner
    await writeFile(
      path.join(root, 'workflow-dispatcher.ts'),
      [
        'import { HmacLedgerEnvelopeSigner } from "./ledger-envelope.js";',
        'export class WorkflowOrderDispatcher {',
        '  private readonly signer = new HmacLedgerEnvelopeSigner();',
        '  public dispatchWorkflowOrder(orderId: string, payload: string): string {',
        '    const digest = this.signer.sealCanonicalMerkleDigest(payload);',
        '    return `${orderId}:${digest}`;',
        '  }',
        '}',
      ].join('\n'),
    );
    // Module 2: Collaborator module whose terminology ("HmacLedgerEnvelopeSigner", "sealCanonicalMerkleDigest")
    // is only reachable via Module 1's structural dependencies / code body / dependsOn bridge terms!
    await writeFile(
      path.join(root, 'ledger-envelope.ts'),
      [
        'export class HmacLedgerEnvelopeSigner {',
        '  public sealCanonicalMerkleDigest(canonicalPayload: string): string {',
        '    return `merkle-ed25519:${canonicalPayload.length}`;',
        '  }',
        '  public verifyCanonicalMerkleDigest(digest: string): boolean {',
        '    return digest.startsWith("merkle-ed25519:");',
        '  }',
        '}',
      ].join('\n'),
    );
    // Module 3: Unrelated distractor module
    await writeFile(
      path.join(root, 'theme-preferences.ts'),
      'export function resolveColorPalette(darkMode: boolean): string { return darkMode ? "slate" : "ivory"; }\n',
    );

    const store = new Sag2Bm25IndexStore();
    let diagnostics: Sag2RetrievalDiagnostics | undefined;
    const recall = new RecallKernel(store);
    const recallBatch = vi.spyOn(recall, 'recallBatch');
    const runtime = await createCodeIntelligenceRuntime({ store, sag2: {
      enabled: true, recall, observeDiagnostics: (result) => { diagnostics = result; },
    } });
    try {
      await runtime.registry.register({
        repositoryId: 'history',
        localPath: root,
        role: 'history',
        displayName: 'EnterpriseHistory',
      });
      const run = await runtime.coordinator.run({ repositoryId: 'history' });
      const index = (await store.getStructuralIndex(run.scope))!;
      const scope = { ...run.scope, projectId: index.projects[0]!.projectId };

      const proposal: ProjectModuleProposal = {
        ...run.scope,
        analysisHash: index.analysisHash,
        objective: projectAnalysisObjective,
        summary: 'Enterprise workflow and ledger modules',
        modules: [
          {
            id: 'workflow-dispatch',
            name: 'Workflow Order Dispatcher',
            kind: 'feature',
            purpose: 'Dispatch workflow orders',
            description: 'Routes incoming workflow orders and invokes HmacLedgerEnvelopeSigner for envelope sealing',
            language: 'TypeScript',
            coreApis: ['WorkflowOrderDispatcher.dispatchWorkflowOrder', 'HmacLedgerEnvelopeSigner.sealCanonicalMerkleDigest'],
            sourceFiles: ['workflow-dispatcher.ts'],
            symbolKeys: [],
            dependsOn: ['merkle-ledger-sealer'],
            evidenceIds: [`project:${scope.projectId}`],
          },
          {
            id: 'merkle-ledger-sealer',
            name: 'Merkle Ledger Envelope Sealer',
            kind: 'infrastructure',
            purpose: 'Cryptographic canonical Merkle digest sealing',
            description: 'Provides HmacLedgerEnvelopeSigner and sealCanonicalMerkleDigest for immutable envelope digests',
            language: 'TypeScript',
            coreApis: ['HmacLedgerEnvelopeSigner.sealCanonicalMerkleDigest', 'HmacLedgerEnvelopeSigner.verifyCanonicalMerkleDigest'],
            sourceFiles: ['ledger-envelope.ts'],
            symbolKeys: [],
            dependsOn: [],
            evidenceIds: [`project:${scope.projectId}`],
          },
          {
            id: 'ui-theme',
            name: 'UI Theme Palette',
            kind: 'feature',
            purpose: 'Color palette preferences',
            description: 'Resolves light and dark mode color palettes',
            language: 'TypeScript',
            coreApis: ['resolveColorPalette'],
            sourceFiles: ['theme-preferences.ts', 'package.json'],
            symbolKeys: [],
            dependsOn: [],
            evidenceIds: [`project:${scope.projectId}`],
          },
        ],
      };

      const analysis = new ProjectAnalysisCoordinator({
        store,
        plan: async () => ({
          proposal,
          evidence: {
            ...run.scope,
            analysisHash: index.analysisHash,
            planHash: projectPlanHash(proposal),
            evidenceIds: [`project:${scope.projectId}`],
          },
        }),
      });
      await analysis.ensure(scope, true);
      expect((await analysis.read(scope)).state).toBe('ready');

      // Target module only mentions high-level workflow dispatch in English and a second unmapped Chinese responsibility
      const target: ModuleTarget = {
        id: 'target-order',
        kind: 'module',
        name: 'OrderWorkflowProcessor',
        path: 'OrderWorkflowProcessor.cs',
        language: 'C#',
        signature: 'DispatchWorkflowOrder',
        module: {
          description: 'Dispatch incoming workflow orders',
          purpose: 'Workflow order dispatching',
          sourceFiles: ['OrderWorkflowProcessor.cs'],
          coreApis: ['DispatchWorkflowOrder'],
          dependsOn: [],
        },
      };
      const requirement = '实现工作流订单派发调度；以及完成不可篡改底层回执封存校验';

      // 1. Standard 1-Hop retrieval only finds 'workflow-dispatch' because 'merkle-ledger-sealer'
      // shares zero tokens with the initial query before bridging through 'workflow-dispatch'.
      const oneHopResults = await searchModules(store, {
        target,
        requirement,
        topK: 4,
        repositoryIds: ['history'],
      });
      const oneHopModuleIds = oneHopResults.map((c) => c.sourceModule?.moduleId);
      expect(oneHopModuleIds).toContain('workflow-dispatch');
      expect(oneHopModuleIds).not.toContain('merkle-ledger-sealer');

      // 2. SAG2 2-Hop retrieval uses JEV to detect the uncovered second responsibility,
      // extracts bridge terms ('hmacledgerenvelopessigner', 'sealcanonicalmerkledigest', 'merkle', 'ledger', 'sealer')
      // from 'workflow-dispatch', and retrieves 'merkle-ledger-sealer' in Hop 2!
      const sag2Results = await runtime.moduleImplementationSearch.search({ target, requirement, topK: 4, repositoryIds: ['history'] });
      expect(recallBatch).toHaveBeenCalledTimes(2);
      expect(recallBatch.mock.calls[1]![0][0]!.plans.every(plan => plan.label.startsWith('sag2-hop2-'))).toBe(true);

      const sag2ModuleIds = sag2Results.map((c) => c.sourceModule?.moduleId);
      expect(sag2ModuleIds).toContain('workflow-dispatch');
      expect(sag2ModuleIds).toContain('merkle-ledger-sealer');
      expect(diagnostics).toBeDefined();
      expect(diagnostics!.hopsExecuted).toBe(2);
      expect(diagnostics!.hop2NewlyDiscoveredIds.length).toBeGreaterThanOrEqual(1);
      expect(diagnostics!.bridgeTerms.some((term) => term.includes('merkle') || term.includes('ledger') || term.includes('seal'))).toBe(true);
    } finally {
      await runtime.close();
      await store.close();
    }
  });

  it('skips Hop 2 (early exit) when JEV confirms all responsibilities are covered in Hop 1', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sag2-early-exit-'));
    roots.push(root);

    await writeFile(path.join(root, 'package.json'), '{"name":"single-hop"}');
    await writeFile(
      path.join(root, 'payment.ts'),
      'export function submitPaymentOrder(amount: number): boolean { return amount > 0; }\n',
    );

    const store = new Sag2Bm25IndexStore();
    const runtime = await createCodeIntelligenceRuntime({ store });
    try {
      await runtime.registry.register({
        repositoryId: 'history',
        localPath: root,
        role: 'history',
        displayName: 'SingleHopRepo',
      });
      const run = await runtime.coordinator.run({ repositoryId: 'history' });
      const index = (await store.getStructuralIndex(run.scope))!;
      const scope = { ...run.scope, projectId: index.projects[0]!.projectId };

      const proposal: ProjectModuleProposal = {
        ...run.scope,
        analysisHash: index.analysisHash,
        objective: projectAnalysisObjective,
        summary: 'Payment module',
        modules: [
          {
            id: 'payments',
            name: 'Payment Order Submission',
            kind: 'feature',
            purpose: 'Submit payment orders',
            description: 'Submit payment orders and validate positive amounts',
            language: 'TypeScript',
            coreApis: ['submitPaymentOrder'],
            sourceFiles: index.files.map((file) => file.relativePath),
            symbolKeys: [],
            dependsOn: [],
            evidenceIds: [`project:${scope.projectId}`],
          },
        ],
      };

      const analysis = new ProjectAnalysisCoordinator({
        store,
        plan: async () => ({
          proposal,
          evidence: {
            ...run.scope,
            analysisHash: index.analysisHash,
            planHash: projectPlanHash(proposal),
            evidenceIds: [`project:${scope.projectId}`],
          },
        }),
      });
      await analysis.ensure(scope, true);

      const target: ModuleTarget = {
        id: 'target-payment',
        kind: 'module',
        name: 'PaymentOrderService',
        path: 'PaymentOrderService.cs',
        language: 'C#',
        signature: 'submitPaymentOrder',
        module: {
          description: 'Submit payment orders',
          purpose: 'Submit payment orders',
          sourceFiles: ['PaymentOrderService.cs'],
          coreApis: ['submitPaymentOrder'],
          dependsOn: [],
        },
      };

      let diagnostics: Sag2RetrievalDiagnostics | undefined;
      const results = await searchModulesWithSag2(
        store,
        {
          target,
          requirement: 'Submit payment orders',
          topK: 4,
          repositoryIds: ['history'],
        },
        undefined,
        {
          observeDiagnostics: (d) => {
            diagnostics = d;
          },
        },
      );

      expect(results).toHaveLength(1);
      expect(results[0]!.sourceModule?.moduleId).toBe('payments');
      expect(diagnostics?.hopsExecuted).toBe(1);
      expect(diagnostics?.missingResponsibilities).toHaveLength(0);
    } finally {
      await runtime.close();
      await store.close();
    }
  });
});
