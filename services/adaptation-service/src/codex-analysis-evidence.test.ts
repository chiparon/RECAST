import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { captureAnalysisEvidence, refreshAnalysisEvidence } from './codex-analysis-evidence';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'recast-evidence-')); roots.push(root);
  await mkdir(join(root, 'target'), { recursive: true });
  await writeFile(join(root, 'target', '契约 ports.cs'), 'namespace Example;\r\npublic interface IPort {\r\n  string Execute(string tenant);\r\n}\r\n');
  const file = 'target/契约 ports.cs';
  return { root, file, plan: `Implement the caller using IPort.\nEvidence: \`${file}:2-4\` — IPort, dependency contract.`, allowed: new Set([file]) };
}

it('supplies original dependency bytes, symbols and hashes with line citations, including paths with spaces', async () => {
  const f = await fixture();
  const evidence = await captureAnalysisEvidence(f.root, f.plan, f.allowed);
  expect(evidence.entries).toHaveLength(1);
  expect(evidence.entries[0]).toMatchObject({ path: f.file, startLine: 2, endLine: 4, symbols: ['IPort', 'Execute'], excerpt: 'public interface IPort {\n  string Execute(string tenant);\n}' });
  expect(evidence.entries[0]!.sourceSha256).toBe(createHash('sha256').update(await readFile(join(f.root, f.file))).digest('hex'));
  expect((await refreshAnalysisEvidence(f.root, f.plan, evidence)).entries).toEqual(evidence.entries);
});

it('removes stale excerpts after a dependency changes, even outside the quoted range', async () => {
  const f = await fixture();
  const evidence = await captureAnalysisEvidence(f.root, f.plan, f.allowed);
  await writeFile(join(f.root, f.file), 'namespace Changed;\r\npublic interface IPort {\r\n  string Execute(string tenant);\r\n}\r\n');
  const refreshed = await refreshAnalysisEvidence(f.root, f.plan, evidence);
  expect(refreshed.entries).toEqual([]);
  expect(refreshed.stalePaths).toEqual([f.file]);
});

it('rejects changed plan identity and tampered excerpts instead of trusting persisted summaries', async () => {
  const f = await fixture();
  const evidence = await captureAnalysisEvidence(f.root, f.plan, f.allowed);
  await expect(refreshAnalysisEvidence(f.root, 'changed plan', evidence)).rejects.toThrow('does not match');
  evidence.entries[0]!.excerpt = 'invented interface';
  expect((await refreshAnalysisEvidence(f.root, f.plan, evidence)).entries).toEqual([]);
});

it('omits invalid, unavailable, traversal and out-of-range citations; deduplicates valid citations', async () => {
  const f = await fixture();
  const plan = [f.plan, f.plan, '`target/../secret.cs:1-9`', '`target/missing.cs:1-9`', `\`${f.file}:999-1000\``, `\`${f.file}:4-2\``].join('\n');
  const evidence = await captureAnalysisEvidence(f.root, plan, f.allowed);
  expect(evidence.entries).toHaveLength(1);
  expect(evidence.omissions).toHaveLength(4);
});

it('bounds excerpts and explicitly reports truncated evidence while leaving original sources available', async () => {
  const f = await fixture();
  await writeFile(join(f.root, f.file), Array.from({ length: 500 }, (_, i) => `line ${i}: ` + 'x'.repeat(200)).join('\n'));
  const evidence = await captureAnalysisEvidence(f.root, `\`${f.file}:1-500\``, f.allowed);
  expect(evidence.entries[0]!.excerpt.length).toBeLessThanOrEqual(12000);
  expect(evidence.omissions.join(' ')).toContain('Partial citation');
  expect((await readFile(join(f.root, f.file), 'utf8')).length).toBeGreaterThan(100000);
});
