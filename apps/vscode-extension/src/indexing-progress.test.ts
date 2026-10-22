import { describe, expect, it, vi } from 'vitest';
import { createIndexingProgressReporter, indexingProgressMessage, retrievalAvailable } from './indexing-progress';
import type { CodeIntelligencePresentation } from './ui-types';

describe('indexing progress presentation', () => {
  it('throttles counts while immediately showing stage changes and completion', () => {
    let time = 0;
    const report = vi.fn();
    const progress = createIndexingProgressReporter(report, () => time);
    const repository = { repositoryId: 'repo', displayName: 'Camel' };
    progress({ ...repository, stage: 'parse', completed: 1, total: 100 });
    time = 100;
    progress({ ...repository, stage: 'parse', completed: 2, total: 100 });
    time = 500;
    progress({ ...repository, stage: 'parse', completed: 60, total: 100 });
    time = 501;
    progress({ ...repository, stage: 'parse', completed: 100, total: 100 });
    progress({ ...repository, stage: 'parse', completed: 100, total: 100 });
    progress({ ...repository, stage: 'search-projection', completed: 0, total: 300 });
    expect(report.mock.calls.map(([update]) => [update.stage, update.completed])).toEqual([
      ['parse', 1], ['parse', 60], ['parse', 100], ['search-projection', 0],
    ]);
    expect(indexingProgressMessage({ ...repository, stage: 'parse', completed: 100, total: 100 }))
      .toBe('Camel：正在解析源文件（100/100）');
  });

  it('labels source verification separately from parsing', () => {
    expect(indexingProgressMessage({ repositoryId: 'repo', displayName: 'Camel', stage: 'snapshot-verify', completed: 32, total: 40 }))
      .toBe('Camel：正在校验源码快照（32/40）');
    expect(indexingProgressMessage({ repositoryId: 'repo', displayName: 'Camel', stage: 'search-projection', completed: 128, filesCompleted: 3, filesTotal: 40 }))
      .toBe('Camel：正在生成检索向量（128） · 源文件 3/40');
    const report = vi.fn();
    const progress = createIndexingProgressReporter(report, () => 0);
    progress({ repositoryId: 'repo', displayName: 'Camel', stage: 'search-projection', completed: 128, filesCompleted: 3, filesTotal: 40 });
    progress({ repositoryId: 'repo', displayName: 'Camel', stage: 'search-projection', completed: 128, filesCompleted: 40, filesTotal: 40 });
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('keeps existing retrieval usable after one repository fails', () => {
    const failed = { status: 'error', storage: 'seekdb', repositories: [
      { repositoryId: 'target', analysisStatus: 'failed', activeRevision: null },
    ] } as CodeIntelligencePresentation;
    expect(retrievalAvailable(failed)).toBe(false);
    expect(retrievalAvailable({ ...failed, status: 'ready' })).toBe(false);
    expect(retrievalAvailable({ ...failed, repositories: [
      ...failed.repositories,
      { repositoryId: 'history', analysisStatus: 'ready', activeRevision: 'ready-revision' },
    ] } as CodeIntelligencePresentation)).toBe(true);
    expect(retrievalAvailable({ status: 'initializing', storage: 'seekdb', repositories: [] })).toBe(false);
    expect(retrievalAvailable({ status: 'ready', storage: 'seekdb', repositories: [] })).toBe(true);
  });
});
