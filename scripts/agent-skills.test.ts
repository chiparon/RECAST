import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { buildAgentSkills } from './build-agent-skills.mjs';
import { promptFingerprints } from './agent-skill-prompts.fixture';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('project-distributed agent skills', () => {
  it('preserves complete pre-migration prompts across modes, retries, protocol branches and long input', async () => {
    const baseline = JSON.parse(await readFile(path.join(root, 'scripts/agent-skill-prompts.baseline.json'), 'utf8'));
    expect(promptFingerprints()).toEqual(baseline);
  });

  it('keeps the committed runtime bundle current with its Markdown sources', async () => {
    await expect(buildAgentSkills({ check: true })).resolves.toHaveProperty('verifier');
  });

  it('renders identical prompts from a relocated CJS bundle with no Markdown or repository paths at runtime', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'recast-skills-'));
    try {
      const output = await build({
        stdin: { contents: "import { promptFingerprints } from './scripts/agent-skill-prompts.fixture.ts'; process.stdout.write(JSON.stringify(promptFingerprints()));", resolveDir: root, loader: 'ts' },
        bundle: true, platform: 'node', format: 'cjs', target: 'node20', write: false,
        // Native grammars are unrelated to prompt rendering and loaded lazily.
        external: ['tree-sitter', 'tree-sitter-*', '@tree-sitter-grammars/*', 'node-gyp-build'],
      });
      const file = path.join(directory, 'prompts.cjs');
      await writeFile(file, output.outputFiles[0]!.contents);
      const stdout = execFileSync(process.execPath, [file], { cwd: directory, encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(root, 'node_modules') } });
      expect(JSON.parse(stdout)).toEqual(promptFingerprints());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
