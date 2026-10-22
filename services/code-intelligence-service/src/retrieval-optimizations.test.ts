import { describe, expect, it } from 'vitest';
import { ModuleSearchConcurrencyGate, moduleMatchingInternals } from './module-matching.js';
import { compactLexicalQuery } from './seekdb-index-store.js';

describe('retrieval optimizations', () => {
  it('keeps distinct module meanings even when their manifests are identical', () => {
    const base = { repositoryId: 'history', analysisRevision: 'revision', repositoryName: 'History',
      projectId: 'project', projectPath: '', score: 0.8, semanticScore: 0.8, semanticOrderScore: 0.8 };
    const module = { kind: 'feature', description: 'Implementation', sourceFiles: ['shared.ts'], symbolKeys: [], coreApis: [], dependsOn: [], evidenceIds: [] };
    const hits = [
      { ...base, module: { ...module, id: 'upload', name: 'Multipart parsing' } },
      { ...base, module: { ...module, id: 'size-limit', name: 'Upload limits' } },
    ];
    expect(moduleMatchingInternals.shortlistHits([...hits, hits[0]!], 16).map(hit => hit.module.id).sort()).toEqual(['size-limit', 'upload']);
  });

  it('selects core production implementations instead of build files, package metadata or tests', () => {
    const files = ['pom.xml', 'src/package-info.java', 'src/test/java/UploadTest.java', 'src/main/java/GenericEntry.java',
      'src/main/java/MultipartParser.java', 'src/main/java/SizeLimit.java'];
    const hit = { repositoryId: 'history', analysisRevision: 'revision', repositoryName: 'History',
      projectId: 'project', projectPath: '', score: 0.8, semanticScore: 0.8, semanticOrderScore: 0.8,
      module: { id: 'upload', name: 'Upload', kind: 'feature', description: 'Parse multipart requests', sourceFiles: files,
        coreApis: ['MultipartParser.parse'], symbolKeys: [], dependsOn: [], evidenceIds: [] },
      fileEvidence: new Map([['src/main/java/SizeLimit.java', { score: 0.02, fragmentScore: 0.02 }]]) };
    expect(moduleMatchingInternals.representativeFiles(hit)).toEqual([
      'src/main/java/MultipartParser.java', 'src/main/java/SizeLimit.java', 'src/main/java/GenericEntry.java',
    ]);
    expect(hit.module.sourceFiles).toEqual(files);
  });

  it('does not mistake a class declaration or return type for a core implementation API', () => {
    const hit = { repositoryId: 'history', analysisRevision: 'revision', repositoryName: 'History',
      projectId: 'project', projectPath: '', score: 0.8, semanticScore: 0.8, semanticOrderScore: 0.8,
      module: { id: 'engine', name: 'Engine', kind: 'feature', description: 'Run tasks',
        sourceFiles: ['AppModel.java', 'String.java', 'TaskRuntime.java'],
        coreApis: ['public class AppModel', 'public String getName()', 'Engine.TaskRuntime.execute'],
        symbolKeys: [], dependsOn: [], evidenceIds: [] } };
    expect(moduleMatchingInternals.representativeFiles(hit, 1)).toEqual(['TaskRuntime.java']);
  });

  it('removes preview boilerplate while preserving transactions, literals and Rust attributes', () => {
    const excerpt = moduleMatchingInternals.implementationExcerpt('/* license */\nusing System;\nusing var transaction = Begin();\nvar marker = "/*";\n#[derive(Clone)]', [], 500);
    expect(excerpt).not.toContain('license');
    expect(excerpt).not.toContain('using System');
    expect(excerpt).toContain('using var transaction = Begin()');
    expect(excerpt).toContain('"/*"');
    expect(excerpt).toContain('#[derive(Clone)]');
  });

  it('bounds repository fan-out and honors an explicit setting', () => {
    const previous = process.env.CODE_INTELLIGENCE_MODULE_REPOSITORY_CONCURRENCY;
    try {
      delete process.env.CODE_INTELLIGENCE_MODULE_REPOSITORY_CONCURRENCY;
      expect(moduleMatchingInternals.configuredRepositoryConcurrency()).toBe(4);
      for (const value of ['1', '2', '4']) {
        process.env.CODE_INTELLIGENCE_MODULE_REPOSITORY_CONCURRENCY = value;
        expect(moduleMatchingInternals.configuredRepositoryConcurrency()).toBe(Number(value));
      }
      for (const value of ['0', '5', '1.5', 'invalid']) {
        process.env.CODE_INTELLIGENCE_MODULE_REPOSITORY_CONCURRENCY = value;
        expect(moduleMatchingInternals.configuredRepositoryConcurrency()).toBe(4);
      }
    } finally {
      if (previous === undefined) delete process.env.CODE_INTELLIGENCE_MODULE_REPOSITORY_CONCURRENCY;
      else process.env.CODE_INTELLIGENCE_MODULE_REPOSITORY_CONCURRENCY = previous;
    }
  });

  it('keeps production implementations ahead of pure test modules while retaining useful test evidence', () => {
    const { productionEvidenceWeight } = moduleMatchingInternals;
    expect(productionEvidenceWeight(['src/Health.cs'], ['pom.xml', 'src/test/java/HealthTest.java'])).toBe(0.5);
    expect(productionEvidenceWeight(['src/Health.cs'], ['health.test.ts'])).toBe(0.5);
    expect(productionEvidenceWeight(['src/Health.cs'], ['src/main/java/Health.java', 'src/test/java/HealthTest.java'])).toBe(1);
    expect(productionEvidenceWeight(['tests/HealthTest.java'], ['src/test/java/HealthTest.java'])).toBe(1);
    expect(productionEvidenceWeight(['src/Health.cs'], ['test_health.py'])).toBe(0.5);
    expect(productionEvidenceWeight(['pom.xml', 'src/test/java/HealthTest.java'], ['src/test/java/HealthTest.java'])).toBe(1);
  });

  it('prevents one large repository from consuming the entire model shortlist and fills all available slots', () => {
    const hit = (repositoryId: string, index: number, score: number, semantic: number) => ({ repositoryId, analysisRevision: 'revision',
      repositoryName: repositoryId, projectId: 'project', projectPath: '', score, semanticScore: semantic, semanticOrderScore: semantic,
      module: { id: `${repositoryId}-${index}`, name: 'Module', kind: 'feature', description: 'Implementation', sourceFiles: [`${index}.ts`],
        symbolKeys: [], coreApis: [], dependsOn: [], evidenceIds: [] } });
    const dense = Array.from({ length: 20 }, (_, i) => hit('dense', i, 1 - i / 100, 1 - i / 100));
    const relevant = Array.from({ length: 10 }, (_, i) => hit('other', i, 0.6 - i / 100, 0.6 - i / 100));
    const selected = moduleMatchingInternals.shortlistHits([...dense, ...relevant], 16);
    expect(selected).toHaveLength(16);
    expect(selected.filter(hit => hit.repositoryId === 'other').length).toBeGreaterThanOrEqual(6);
    expect(moduleMatchingInternals.shortlistHits(dense, 16)).toHaveLength(16);
  });
  it('keeps high-signal terms while removing repeated metadata from full-text queries', () => {
    const query = [
      'Web 接口层',
      'Web 接口层',
      'Web 接口层包含请求/响应 DTO、错误模型以及端点映射接口。',
      '目标语言：Java',
      '目标工程：pom',
    ].join('\n');
    const lexical = compactLexicalQuery(query);
    expect(lexical).toContain('Web');
    expect(lexical).toContain('DTO');
    expect(lexical).toContain('错误模型');
    expect(lexical).not.toContain('Java');
    expect(lexical).not.toContain('pom');
    expect(lexical.match(/Web/g)?.length).toBe(1);
  });

  it('removes declaration boilerplate while retaining Java behavior identifiers', () => {
    const lexical = compactLexicalQuery([
      'public final class IdempotencyCoordinator',
      'public Object execute(Object input)',
      'package com.example.assetupgrade.retry;',
      '负责请求幂等性保障与重试协调。',
    ].join('\n'));
    expect(lexical).toContain('IdempotencyCoordinator');
    expect(lexical).toContain('execute');
    expect(lexical).toContain('幂等性');
    expect(lexical).not.toMatch(/\bpublic\b/i);
    expect(lexical).not.toMatch(/\b(?:class|package|Object|input)\b/);
  });

  it('limits active searches across callers instead of only within one request', async () => {
    const gate = new ModuleSearchConcurrencyGate(1);
    const firstRelease = await gate.acquire();
    let secondEntered = false;
    const second = gate.acquire().then((release) => {
      secondEntered = true;
      release();
    });
    await Promise.resolve();
    expect(gate.active).toBe(1);
    expect(gate.queued).toBe(1);
    expect(secondEntered).toBe(false);
    firstRelease();
    await second;
    expect(secondEntered).toBe(true);
    expect(gate.active).toBe(0);
  });

  it('bounds a long requirement to sixteen distinct lexical terms', () => {
    const query = `AssetLifecycleCoordinator.SubmitAsync ${Array.from({ length: 80 }, (_, i) => `feature${i}`).join(' ')}\n目标工程：sample`;
    const lexical = compactLexicalQuery(query).split(' ');
    expect(lexical).toHaveLength(16);
    expect(lexical[0]).toBe('AssetLifecycleCoordinator.SubmitAsync');
    expect(lexical).not.toContain('sample');
  });

  it('removes an aborted waiter without consuming a later permit', async () => {
    const gate = new ModuleSearchConcurrencyGate(1);
    const firstRelease = await gate.acquire();
    const controller = new AbortController();
    const waiting = gate.acquire(controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(waiting).rejects.toThrow('cancelled');
    expect(gate.queued).toBe(0);
    firstRelease();
    const release = await gate.acquire();
    release();
    expect(gate.active).toBe(0);
  });
});
