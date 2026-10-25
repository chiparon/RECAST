import { expect, it } from 'vitest';
import { releaseTreeProblems } from './check-repo-hygiene.mjs';

it('rejects tracked experiment snapshots and compiler output even when individual files are small', () => {
  for (const path of ['experiments/vendor/src/Main.java', 'logs/run.json', 'fixtures/example/obj/project.assets.json', 'fixtures/example/bin/app.dll']) {
    expect(releaseTreeProblems([{ path, bytes: 10 }]).length, path).toBeGreaterThan(0);
  }
});

it('preserves runtime assets, regression fixtures and the illustrated enterprise manual', () => {
  expect(releaseTreeProblems([
    { path: 'services/code-intelligence-service/src/query-lexicon.json', bytes: 100_000 },
    { path: 'services/translation-verifier/e2e/fixtures/example/target-project-after/Main.java', bytes: 500 },
    { path: 'docs/user-guide/RECAST企业使用说明书.docx', bytes: 1_600_000 },
  ])).toEqual([]);
});

it('rejects aggregate corpora that evade the per-file limit', () => {
  expect(releaseTreeProblems(Array.from({ length: 5001 }, (_, i) => ({ path: `fixtures/${i}.txt`, bytes: 10 })))).toEqual(expect.arrayContaining([expect.objectContaining({ path: '(tree)' })]));
  expect(releaseTreeProblems(Array.from({ length: 60 }, (_, i) => ({ path: `fixtures/${i}.txt`, bytes: 900_000 })))).toEqual(expect.arrayContaining([expect.objectContaining({ path: '(tree)' })]));
});
