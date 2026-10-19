import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { CodexWorkspaceTranslationRuntime } from "./codex-workspace-translation-runtime";

async function eventually<T>(read: () => T, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read();
    if (done(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return read();
}

describe("CodexWorkspaceTranslationRuntime", () => {
  it('cancels the owned Codex process tree before returning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-cancel-tree-'));
    const scripts = await mkdtemp(join(tmpdir(), 'codex-cancel-cli-'));
    let descendant: number | undefined;
    let runtime: CodexWorkspaceTranslationRuntime | undefined;
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      await writeFile(join(root, 'main.ts'), 'export const value = 0;');
      const marker = join(scripts, 'pid.json'), cli = join(scripts, 'codex.mjs');
      await writeFile(cli, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(process.env.RECAST_TEST_PID_FILE, JSON.stringify({ pid: child.pid }));
setInterval(() => {}, 1000);`);
      runtime = new CodexWorkspaceTranslationRuntime({ workspaceRoot: root, codexCommand: cli,
        environment: { RECAST_TEST_PID_FILE: marker }, compileCommand: { executable: process.execPath, args: ['--check', 'main.ts'] } });
      const run = runtime.start({ spec: 'implement value', translationMode: 'direct-translator', sourceLanguage: 'TypeScript', targetLanguage: 'TypeScript',
        context: [{ id: 'requirement', kind: 'summary', content: 'implement value' }], workspaceFiles: ['main.ts'], writeFiles: ['main.ts'] });
      expect(await eventually(() => existsSync(marker), Boolean)).toBe(true);
      descendant = JSON.parse(await readFile(marker, 'utf8')).pid;
      expect(alive(descendant!)).toBe(true);
      expect((await runtime.cancel(run.id)).status).toBe('cancelled');
      expect(await eventually(() => alive(descendant!), value => !value)).toBe(false);
      expect(await readFile(join(root, 'main.ts'), 'utf8')).toBe('export const value = 0;');
    } finally {
      await runtime?.shutdown();
      if (descendant && alive(descendant)) process.kill(descendant, 'SIGKILL');
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); await rm(scripts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  it("runs project integration with complete visibility and sends long requirements through stdin", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runtime-integration-"));
    const scripts = await mkdtemp(join(tmpdir(), "codex-runtime-integration-script-"));
    try {
      await mkdir(join(root, "src"));
      await mkdir(join(root, "evaluation"));
      await writeFile(join(root, "src", "Entry.java"), "class Entry { }\n");
      await writeFile(join(root, "src", "Storage.java"), "class Storage { }\n");
      await writeFile(join(root, "evaluation", "hidden.json"), "PRIVATE CRITERIA");
      const codex = join(scripts, "integration.mjs");
      await writeFile(codex, `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
if (process.argv[process.argv.indexOf('--sandbox') + 1] !== 'workspace-write') process.exit(12);
if (!existsSync('target/src/Entry.java') || !existsSync('target/src/Storage.java') || existsSync('target/evaluation')) process.exit(13);
if (process.argv.at(-1) !== '-') process.exit(16);
const prompt = readFileSync(0, 'utf8');
if (prompt.length < 32768 || !prompt.includes('END_OF_LONG_REQUIREMENT')) process.exit(17);
if (!prompt.includes('one coding session') || !prompt.includes('assertion-based integration checks')) process.exit(14);
if (/AssetUpgradeService|AttachmentIntakeService|OrderPluginBridge|ReconciliationOrchestrator/.test(prompt)) process.exit(15);
if (!prompt.includes('PUBLIC_INVARIANT') || !prompt.includes('cite its public requirement file') || !prompt.includes('assumptions and unresolved ambiguity')) process.exit(18);
if (/TRANSPORT_ONLY_FAILURE_MESSAGE|OLD_MODULE_PLAN|host-failure-review|integration-host-facts|integration-verifier-tests/.test(prompt)) process.exit(19);
if (existsSync('history-view/integration-host-facts.json') || existsSync('history-view/integration-host-failure-review.json') || existsSync('history-view/integration-verifier-tests') || existsSync('CODEX_IMPLEMENTATION_PLAN.json')) process.exit(20);
if (!prompt.includes('Host build entry:')) process.exit(21);
mkdirSync('.agent-tmp/integration-checks');
writeFileSync('.agent-tmp/integration-checks/coverage.md', 'public requirement -> expected -> assertion');
writeFileSync('.agent-tmp/integration-checks/execution.log', 'node checks.js: exit=0 assertions=1');
writeFileSync('.agent-tmp/integration-checks/checks.js', 'assert(true);');
writeFileSync('.agent-tmp/check.js', 'scratch check');
writeFileSync('target/src/Entry.java', 'class Entry { Storage storage; }');
writeFileSync('target/src/Storage.java', 'class Storage { int value = 42; }');
writeFileSync('target/src/Integration.java', 'class Integration { }');
writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], JSON.stringify({ summary: 'Repaired the call chain; integration checks passed.' }));
`);
      await chmod(codex, 0o755);
      const runtime = new CodexWorkspaceTranslationRuntime({ workspaceRoot: root,
        compileCommand: { executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000 },
        codexCommand: codex, maxModelTurns: 2, timeoutMs: 30_000 });
      try {
        const spec = 'Integrate entry and storage\n' + '需求保留引号 "quoted" 与换行\n'.repeat(2_000) + 'END_OF_LONG_REQUIREMENT';
        const run = runtime.start({ taskKind: "project-integration", spec, sourceLanguage: "Java", targetLanguage: "Java",
          globalProtocol: { version: 1, invariants: [{ id: 'rule-1', rule: 'PUBLIC_INVARIANT', source: 'requirement', status: 'fixed' }], boundaries: [], sharedContracts: [], openQuestions: [] },
          context: [{ id: 'integration-verification-history', kind: 'summary', content: 'Host facts\n' + JSON.stringify([{ moduleId: 'entry',
            testEvidence: { failures: [{ id: 'host-failure-1', testId: 'case-1', message: 'TRANSPORT_ONLY_FAILURE_MESSAGE', status: 'unresolved' }] } }]) }, { id: 'integration-module-plans', kind: 'summary', content: 'OLD_MODULE_PLAN' }],
          workspaceFiles: ["src/Entry.java", "src/Storage.java"], writeFiles: ["src/Entry.java", "src/Storage.java"] });
        const completed = await eventually(() => runtime.get(run.id), value => ["completed", "failed"].includes(value.status));
        expect(completed.status).toBe("completed");
        expect(completed.modelTurns).toBe(1);
        expect(completed.agent?.stages?.map(stage => stage.stage)).toEqual(["translator"]);
        expect(completed.agent?.stages?.[0].finalMessage).toContain('integration checks passed');
        expect(completed.changes.map(change => change.path)).toEqual(["src/Entry.java", "src/Integration.java", "src/Storage.java"]);
        expect(completed.request.writeFiles).toContain('src/Integration.java');
        expect(completed.compilations.at(-1)?.success).toBe(true);
        expect(existsSync(join(root, ".agent-tmp"))).toBe(false);
        const evidence = completed.agent?.stages?.[0].integrationEvidence;
        expect(evidence?.files).toHaveLength(3);
        expect(evidence?.files.find(file => file.path.endsWith('coverage.md'))?.content).toContain('public requirement');
        expect(runtime.get(run.id).agent?.stages?.[0].integrationEvidence).toEqual(evidence);
      } finally { await runtime.shutdown(); }
    } finally { await Promise.all([rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), rm(scripts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })]); }
  });
  it("compiles an already implemented module even when the Translator has no new diff", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runtime-overlap-"));
    const scripts = await mkdtemp(join(tmpdir(), "codex-runtime-overlap-script-"));
    try {
      await writeFile(join(root, "src.cs"), "class Target { public int Answer() => 42; }\n");
      const codex = join(scripts, "fake-overlap.mjs");
      await writeFile(codex, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], 'The overlapping module was already implemented.');
`);
      await chmod(codex, 0o755);
      const runtime = new CodexWorkspaceTranslationRuntime({ workspaceRoot: root,
        compileCommand: { executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000 },
        codexCommand: codex, maxModelTurns: 2, timeoutMs: 30_000 });
      try {
        const run = runtime.start({ spec: "Implement Answer", sourceLanguage: "C#", targetLanguage: "C#",
          context: [], workspaceFiles: ["src.cs"], writeFiles: ["src.cs"], translationMode: "direct-translator" });
        const completed = await eventually(() => runtime.get(run.id), value => ["completed", "failed"].includes(value.status));
        expect(completed.status).toBe("completed");
        expect(completed.changes).toEqual([]);
        expect(completed.compilations.at(-1)?.success).toBe(true);
        expect(completed.acceptance).toBe("compilation-only");
      } finally { await runtime.shutdown(); }
    } finally { await Promise.all([rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), rm(scripts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })]); }
  });
  it("does not accept an interrupted integration process that exits zero without a final message", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-integration-incomplete-"));
    const scripts = await mkdtemp(join(tmpdir(), "codex-integration-incomplete-script-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "Entry.java"), "class Entry {}\n");
      const codex = join(scripts, "incomplete.mjs");
      await writeFile(codex, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync('target/src/Entry.java', 'class Entry { int unverified = 1; }');
console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'cat target/src/Entry.java',exit_code:0}}));
`);
      await chmod(codex, 0o755);
      const runtime = new CodexWorkspaceTranslationRuntime({ workspaceRoot: root,
        compileCommand: { executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000 },
        codexCommand: codex, maxModelTurns: 2, timeoutMs: 30_000 });
      try {
        const run = runtime.start({ taskKind: "project-integration", spec: "Integrate entry", sourceLanguage: "Java", targetLanguage: "Java",
          context: [], workspaceFiles: ["src/Entry.java"], writeFiles: ["src/Entry.java"] });
        const finished = await eventually(() => runtime.get(run.id), value => ["completed", "failed"].includes(value.status));
        expect(finished.status).toBe("failed");
        expect(finished.error).toContain("without a final completion message");
        expect(finished.changes).toEqual([]);
        expect(finished.compilations).toEqual([]);
        expect(await readFile(join(root, "src", "Entry.java"), "utf8")).toBe("class Entry {}\n");
      } finally { await runtime.shutdown(); }
    } finally { await Promise.all([rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), rm(scripts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })]); }
  });
  it("copies only the history module, rejects out-of-scope edits, and keeps hidden criteria out of staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runtime-test-"));
    const history = await mkdtemp(join(tmpdir(), "forexplore-history-view-"));
    const scripts = await mkdtemp(join(tmpdir(), "codex-script-test-"));
    try {
      await writeFile(join(root, "src.cs"), "class Target { }\n");
      await writeFile(join(root, "visible.txt"), "visible\n");
      await writeFile(join(root, "hidden.txt"), "secret criteria\n");
      await mkdir(join(root, ".forexplore", "workspace-translations"), { recursive: true });
      await writeFile(join(root, ".forexplore", "workspace-translations", "previous.json"),
        JSON.stringify({ changes: [{ after: "prior implementation answer" }], verification: "private test evidence" }));
      await mkdir(join(root, ".forexpore", "history-views"), { recursive: true });
      await writeFile(join(root, ".forexpore", "history-views", "unselected.json"), "unselected history");
      await mkdir(join(root, ".translation-verifier-tests"), { recursive: true });
      await writeFile(join(root, ".translation-verifier-tests", "previous-tests.txt"), "private verifier tests");
      await mkdir(join(history, "source"));
      await writeFile(join(history, "source", "Legacy.cs"), "class Legacy { public int Answer() => 42; }\n");
      const historyContent = await readFile(join(history, "source", "Legacy.cs"));
      const manifestHash = createHash("sha256").update(JSON.stringify([["Legacy.cs", createHash("sha256").update(historyContent).digest("hex")]])).digest("hex");
      await writeFile(join(history, "manifest.json"), JSON.stringify({ repositoryId: "history", analysisRevision: "rev-1", moduleId: "legacy", runId: "00000000-0000-0000-0000-000000000001", files: [{ path: "Legacy.cs", sha256: createHash("sha256").update(historyContent).digest("hex") }], omittedFiles: ["Legacy.Tests.cs"] }));
      const codex = join(scripts, "fake-codex.mjs");
      await writeFile(codex, `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
mkdirSync('.aws', { recursive: true });
mkdirSync('.git', { recursive: true });
const history = readFileSync('history-view/source/Legacy.cs', 'utf8');
const manifest = readFileSync('history-view/manifest.json', 'utf8');
const hiddenWasVisible = existsSync('target/hidden.txt');
if (existsSync('target/.forexplore') || existsSync('target/.forexpore') || existsSync('target/.translation-verifier-tests')) process.exit(11);
const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
if (!existsSync('CODEX_IMPLEMENTATION_PLAN.json') && !existsSync('CODEX_IMPLEMENTATION_PLAN.md')) {
  if (process.argv.includes('--output-schema')) throw new Error('Analyzer must not require a JSON schema');
  writeFileSync(output, JSON.stringify({ summary:'implement answer', mappings:[{source:'Legacy.Answer',targetPath:'src.cs',targetSymbol:'Answer'}], dependencies:[], steps:[{id:'answer',description:'implement answer',files:['src.cs'],dependsOn:[]}] }));
} else {
  writeFileSync('patch.txt', 'temporary unified diff artifact\\n');
  writeFileSync('.agent-tmp/translator.tmp', 'scratch\\n');
  writeFileSync('target/src.cs', 'class Target { public int Answer() => ' + (history.includes('42') && manifest.includes('Legacy.Tests.cs') && !hiddenWasVisible ? '42' : '0') + '; }\\n');
  writeFileSync(output, 'done');
}
`);
      await chmod(codex, 0o755);
      const runtime = new CodexWorkspaceTranslationRuntime({
        workspaceRoot: root,
        compileCommand: { executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000 },
        verification: { command: { executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000 }, protectedFiles: ["hidden.txt"] },
        codexCommand: codex,
        maxModelTurns: 2,
        timeoutMs: 30_000,
      });
      const run = runtime.start({
        spec: "Implement Answer using the selected history implementation.", sourceLanguage: "C#", targetLanguage: "C#",
        context: [{ id: "candidate", kind: "summary", content: "Legacy module" }], workspaceFiles: ["src.cs"], writeFiles: ["src.cs"],
        historyView: { root: history, files: ["Legacy.cs"], repositoryId: "history", analysisRevision: "rev-1", moduleId: "legacy", runId: "00000000-0000-0000-0000-000000000001", manifestHash },
      });
      const completed = await eventually(() => runtime.get(run.id), value => ["completed", "failed", "cancelled"].includes(value.status));
      expect(completed.status).toBe("completed");
      expect(await readFile(join(root, "src.cs"), "utf8")).toContain("Answer() => 42");
      expect(completed.agent?.kind).toBe("codex");
      expect(completed.agent?.historyView?.files).toBe(1);
      expect(completed.plan?.markdown).toContain("implement answer");
      expect(completed.plan?.steps).toEqual([]);
      expect(completed.agent?.stages?.map(stage => [stage.stage, stage.sandbox])).toEqual([["analyzer", "read-only"], ["translator", "workspace-write"]]);
      expect(completed.agent?.stages?.every(stage => stage.readFiles?.includes("history-view/source/Legacy.cs"))).toBe(true);
      expect(completed.agent?.incrementalLines).toBeGreaterThan(0);
      await runtime.shutdown();
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), rm(history, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), rm(scripts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })]);
    }
  });

  it("uses three isolated history inputs in one Analyzer plan and one Translator run", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runtime-multi-test-"));
    const history = await mkdtemp(join(tmpdir(), "forexplore-history-view-"));
    const scripts = await mkdtemp(join(tmpdir(), "codex-multi-script-test-"));
    try {
      await writeFile(join(root, "src.cs"), "class Target { }\n");
      const candidates = [1, 2, 3].map(index => ({ prefix: `candidate-${index}`, repositoryId: `repo-${index}`,
        analysisRevision: `rev-${index}`, moduleId: `module-${index}`, name: `Module ${index}`, language: "C#" }));
      const entries: Array<[string, string]> = [];
      for (const candidate of candidates) {
        await mkdir(join(history, "source", candidate.prefix), { recursive: true });
        const content = `class Legacy { public int Value = ${candidate.prefix.at(-1)}; }`;
        await writeFile(join(history, "source", candidate.prefix, "Same.cs"), content);
        entries.push([`${candidate.prefix}/Same.cs`, createHash("sha256").update(content).digest("hex")]);
      }
      const identity = { repositoryId: "repo-1", analysisRevision: "rev-1", moduleId: "module-1" };
      const manifestHash = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
      await writeFile(join(history, "manifest.json"), JSON.stringify({ ...identity, candidates, files: entries.map(([path, sha256]) => ({ path, sha256 })) }));
      const codex = join(scripts, "fake-multi-codex.mjs");
      await writeFile(codex, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
const prompt = readFileSync(0, 'utf8');
for (const prefix of ['candidate-1','candidate-2','candidate-3']) {
  if (!prompt.includes(prefix) || !readFileSync('history-view/source/' + prefix + '/Same.cs', 'utf8').includes(prefix.at(-1))) process.exit(10);
}
if (!existsSync('CODEX_IMPLEMENTATION_PLAN.json') && !existsSync('CODEX_IMPLEMENTATION_PLAN.md')) {
  writeFileSync(output, JSON.stringify({summary:'combine three behaviors', mappings:[1,2,3].map(i=>({source:'candidate-'+i+'/Same.cs',targetPath:'src.cs',targetSymbol:'Answer'})), dependencies:[],steps:[{id:'implement',description:'combine the behaviors',files:['src.cs'],dependsOn:[]}]}));
} else {
  writeFileSync('target/src.cs','class Target { public int Answer() => 6; }');
  writeFileSync('patch.txt', 'temporary');
  writeFileSync(output,'done');
  console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'cat history-view/source/candidate-2/Same.cs',exit_code:0}}));
}
`);
      await chmod(codex, 0o755);
      const runtime = new CodexWorkspaceTranslationRuntime({ workspaceRoot: root,
        compileCommand: { executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5000 }, codexCommand: codex, maxModelTurns: 2 });
      const run = runtime.start({ spec: "Combine three behaviors.", sourceLanguage: "C#", targetLanguage: "C#", context: [],
        workspaceFiles: ["src.cs"], writeFiles: ["src.cs"], historyView: { root: history, ...identity, files: entries.map(([file]) => file), manifestHash, candidates } });
      const result = await eventually(() => runtime.get(run.id), value => ["completed", "failed"].includes(value.status));
      expect(result.status).toBe("completed");
      expect(result.plan?.markdown).toContain("candidate-3");
      expect(result.plan?.mappings).toEqual([]);
      expect(Object.keys(result.plan!)).toEqual(["markdown", "summary", "mappings", "dependencies", "steps"]);
      expect(result.agent?.historyView?.candidates).toHaveLength(3);
      expect(result.agent?.stages?.map(stage => stage.stage)).toEqual(["analyzer", "translator"]);
      expect(result.agent?.stages?.at(-1)?.commands?.[0]?.command).toContain("candidate-2");
      expect(await readFile(join(root, "src.cs"), "utf8")).toContain("Answer() => 6");
      expect(await readFile(join(root, "patch.txt"), "utf8").catch(() => null)).toBeNull();
      await runtime.shutdown();
    } finally {
      await Promise.all([root, history, scripts].map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
    }
  });

  it("rejects a merged history manifest that substitutes an unselected module", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runtime-history-identity-"));
    const history = await mkdtemp(join(tmpdir(), "forexplore-history-view-"));
    const runtime = new CodexWorkspaceTranslationRuntime({ workspaceRoot: root,
      compileCommand: { executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5000 },
      codexCommand: process.execPath });
    try {
      await writeFile(join(root, "src.cs"), "class Target { }\n");
      const candidates = [1, 2].map(index => ({ prefix: `candidate-${index}`, repositoryId: `repo-${index}`,
        analysisRevision: `rev-${index}`, moduleId: `module-${index}` }));
      const entries: Array<[string, string]> = [];
      for (const candidate of candidates) {
        await mkdir(join(history, "source", candidate.prefix), { recursive: true });
        const content = `class Legacy${candidate.prefix.at(-1)} { }`;
        await writeFile(join(history, "source", candidate.prefix, "Same.cs"), content);
        entries.push([`${candidate.prefix}/Same.cs`, createHash("sha256").update(content).digest("hex")]);
      }
      const identity = { repositoryId: "repo-1", analysisRevision: "rev-1", moduleId: "module-1" };
      const manifestHash = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
      await writeFile(join(history, "manifest.json"), JSON.stringify({ ...identity,
        candidates: [candidates[0], { ...candidates[1], repositoryId: "unselected-repository" }],
        files: entries.map(([path, sha256]) => ({ path, sha256 })) }));
      const run = runtime.start({ spec: "Implement only from the selected modules.", sourceLanguage: "C#", targetLanguage: "C#",
        context: [], workspaceFiles: ["src.cs"], writeFiles: ["src.cs"],
        historyView: { root: history, ...identity, candidates, files: entries.map(([file]) => file), manifestHash } });
      const result = await eventually(() => runtime.get(run.id), value => value.status === "failed");
      expect(result.status).toBe("failed");
      expect(result.events?.at(-1)?.message).toContain("History view candidate metadata mismatch");
      expect(result.agent?.stages ?? []).toEqual([]);
      expect(await readFile(join(root, "src.cs"), "utf8")).toBe("class Target { }\n");
    } finally {
      await runtime.shutdown();
      await Promise.all([root, history].map(directory => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
    }
  });

  it("rejects traversal paths before a Codex process is started", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runtime-path-test-"));
    try {
      await writeFile(join(root, "src.cs"), "class Target { }\n");
      const runtime = new CodexWorkspaceTranslationRuntime({
        workspaceRoot: root,
        compileCommand: { executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000 },
        codexCommand: process.execPath,
      });
      expect(() => runtime.start({
        spec: "x", sourceLanguage: "C#", targetLanguage: "C#", context: [], workspaceFiles: ["src.cs"], writeFiles: ["../escape.cs"],
      })).toThrow(/Invalid workspace-relative file path/);
      await runtime.shutdown();
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });

  it("uses the direct Translator route when history is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runtime-direct-test-"));
    const scripts = await mkdtemp(join(tmpdir(), "codex-direct-script-test-"));
    try {
      await writeFile(join(root, "src.cs"), "class Target { }\n");
      const codex = join(scripts, "fake-direct-codex.mjs");
      await writeFile(codex, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
const prompt = readFileSync(0, 'utf8');
if (!prompt.includes('Direct Translator Codex')) process.exit(7);
writeFileSync('target/src.cs', 'class Target { public int Answer() => 42; }\\n');
writeFileSync(output, 'done');
`);
      await chmod(codex, 0o755);
      const runtime = new CodexWorkspaceTranslationRuntime({
        workspaceRoot: root,
        compileCommand: { executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000 },
        codexCommand: codex,
        maxModelTurns: 2,
        timeoutMs: 30_000,
      });
      const run = runtime.start({
        spec: "Implement Answer directly from the requirement.", sourceLanguage: "C#", targetLanguage: "C#",
        context: [{ id: "target", kind: "summary", content: "Target module" }], workspaceFiles: ["src.cs"], writeFiles: ["src.cs"],
        translationMode: "direct-translator",
      });
      const completed = await eventually(() => runtime.get(run.id), value => ["completed", "failed", "cancelled"].includes(value.status));
      expect(completed.status).toBe("completed");
      expect(completed.modelTurns).toBe(1);
      expect(completed.agent?.stages?.map(stage => stage.stage)).toEqual(["translator"]);
      expect(completed.plan?.summary).toContain("No usable historical candidate");
      expect(await readFile(join(root, "src.cs"), "utf8")).toContain("Answer() => 42");
      await runtime.shutdown();
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), rm(scripts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })]);
    }
  });

  it("accepts a verifier repair that only fixes the Host-owned test harness", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runtime-test-only-repair-"));
    const scripts = await mkdtemp(join(tmpdir(), "codex-test-only-repair-script-"));
    try {
      await writeFile(join(root, "src.cs"), "class Target { }\n");
      const codex = join(scripts, "fake-test-only-repair.mjs");
      await writeFile(codex, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
if (!existsSync('CODEX_IMPLEMENTATION_PLAN.json') && !existsSync('CODEX_IMPLEMENTATION_PLAN.md')) {
  writeFileSync(output, JSON.stringify({ summary:'implement answer', mappings:[{source:'requirement',targetPath:'src.cs',targetSymbol:'Answer'}], dependencies:[], steps:[{id:'answer',description:'implement answer',files:['src.cs'],dependsOn:[]}] }));
} else {
  const target = readFileSync('target/src.cs', 'utf8');
  if (!target.includes('Answer')) writeFileSync('target/src.cs', 'class Target { public int Answer() => 42; }\\n');
  writeFileSync(output, 'done');
}
`);
      await chmod(codex, 0o755);
      const runtime = new CodexWorkspaceTranslationRuntime({
        workspaceRoot: root,
        compileCommand: { executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000 },
        codexCommand: codex,
        maxModelTurns: 2,
        timeoutMs: 30_000,
      });
      const run = runtime.start({
        spec: "Implement Answer.", sourceLanguage: "C#", targetLanguage: "C#",
        context: [{ id: "target", kind: "summary", content: "Target module" }], workspaceFiles: ["src.cs"], writeFiles: ["src.cs"],
      });
      const completed = await eventually(() => runtime.get(run.id), value => value.status === "completed");
      expect(completed.status).toBe("completed");
      const repaired = runtime.repairAfterVerification(run.id, {
        attempt: 1, status: "failure", reason: "test-failed",
        issue: { kind: "test", description: "The Host test fixture needed a correction." },
      });
      const afterRepair = await eventually(() => runtime.get(repaired.id), value => ["completed", "failed"].includes(value.status));
      expect(afterRepair.status).toBe("completed");
      expect(afterRepair.error).toBeUndefined();
      expect(afterRepair.events?.some(event => event.message.includes("未产生生产代码 diff"))).toBe(true);
      expect(await readFile(join(root, "src.cs"), "utf8")).toContain("Answer() => 42");
      await runtime.shutdown();
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), rm(scripts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })]);
    }
  });

  it("rejects a production repair that produces no allowed source diff", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runtime-production-repair-test-"));
    const scripts = await mkdtemp(join(tmpdir(), "codex-production-repair-script-"));
    try {
      await writeFile(join(root, "src.cs"), "class Target { }\n");
      const codex = join(scripts, "fake-production-noop-repair.mjs");
      await writeFile(codex, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
const prompt = readFileSync(0, 'utf8');
if (prompt.includes('Analyzer Codex')) {
  writeFileSync(output, JSON.stringify({ summary:'implement answer', mappings:[{source:'requirement',targetPath:'src.cs',targetSymbol:'Answer'}], dependencies:[], steps:[{id:'answer',description:'implement answer',files:['src.cs'],dependsOn:[]}] }));
} else if (!readFileSync('target/src.cs', 'utf8').includes('Answer')) {
  writeFileSync('target/src.cs', 'class Target { public int Answer() => 42; }\\n');
  writeFileSync(output, 'done');
} else writeFileSync(output, 'done');
`);
      await chmod(codex, 0o755);
      const runtime = new CodexWorkspaceTranslationRuntime({
        workspaceRoot: root,
        compileCommand: { executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000 },
        codexCommand: codex,
        maxModelTurns: 2,
        timeoutMs: 30_000,
      });
      const run = runtime.start({
        spec: "Implement Answer.", sourceLanguage: "C#", targetLanguage: "C#",
        context: [{ id: "target", kind: "summary", content: "Target module" }], workspaceFiles: ["src.cs"], writeFiles: ["src.cs"],
      });
      const completed = await eventually(() => runtime.get(run.id), value => value.status === "completed");
      const repaired = runtime.repairAfterVerification(completed.id, {
        attempt: 1, status: "failure", reason: "test-failed",
        issue: { kind: "translation", description: "The production behavior is still incorrect." },
      });
      const failed = await eventually(() => runtime.get(repaired.id), value => ["completed", "failed"].includes(value.status));
      expect(failed.status).toBe("failed");
      expect(failed.error).toContain("after production verifier feedback");
      expect(failed.verificationRepairs?.at(-1)?.status).toBe("failed");
      await runtime.shutdown();
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), rm(scripts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })]);
    }
  });

  it.each([
    { output: "# Implementation plan\n\n## Steps\nKeep raw line breaks and an unfinished JSON example: {\n", expectedError: "Markdown requires no schema" },
    { output: { summary: "missing mappings and steps" }, expectedError: "Plan requires summary, mappings, dependencies and implementation steps" },
    { output: { summary: "out-of-scope mapping", mappings: [{ source: "history", targetPath: "missing.cs", targetSymbol: "Other" }],
      dependencies: [], steps: [{ id: "answer", description: "implement answer", files: ["src.cs"], dependsOn: [] }] },
      expectedError: "Mappings must reference an allowed write file" },
  ])("accepts nonempty Analyzer text without validating its fields: $expectedError", async ({ output: invalidPlan, expectedError }) => {
    const root = await mkdtemp(join(tmpdir(), "codex-runtime-analyzer-log-test-"));
    const scripts = await mkdtemp(join(tmpdir(), "codex-analyzer-log-script-test-"));
    try {
      await writeFile(join(root, "src.cs"), "class Target { }\n");
      await writeFile(join(root, "other.cs"), "class Other { }\n");
      const codex = join(scripts, "fake-invalid-analyzer.mjs");
      await writeFile(codex, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
const prompt = readFileSync(0, 'utf8');
if (!prompt.includes('You are the Analyzer Codex')) {
  const plan = ${JSON.stringify(invalidPlan)};
  const expected = typeof plan === 'string' ? plan : JSON.stringify(plan);
  if (readFileSync('CODEX_IMPLEMENTATION_PLAN.md', 'utf8') !== expected || !prompt.includes(expected)) process.exit(23);
  writeFileSync('target/src.cs', 'class Target { public int Answer() => 42; }\\n');
  writeFileSync(output, 'Implemented the public requirement.');
}
else {
  const plan = ${JSON.stringify(invalidPlan)};
  writeFileSync(output, typeof plan === 'string' ? plan : JSON.stringify(plan));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4 } }));
}
`);
      await chmod(codex, 0o755);
      const runtime = new CodexWorkspaceTranslationRuntime({
        workspaceRoot: root,
        compileCommand: { executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000 },
        codexCommand: codex,
        maxModelTurns: 2,
        timeoutMs: 30_000,
      });
      const run = runtime.start({
        spec: "Implement the target.", sourceLanguage: "C#", targetLanguage: "C#",
        context: [{ id: "target", kind: "summary", content: "Target module" }], workspaceFiles: ["src.cs", "other.cs"], writeFiles: ["src.cs", "other.cs"],
      });
      const failed = await eventually(() => runtime.get(run.id), value => ["completed", "failed", "cancelled"].includes(value.status));
      expect(failed.status).toBe("completed");
      const analyzer = failed.agent?.stages?.find(stage => stage.stage === "analyzer");
      const expectedText = typeof invalidPlan === "string" ? invalidPlan : JSON.stringify(invalidPlan);
      expect(analyzer?.analyzerOutput).toBe(expectedText);
      expect(analyzer?.analyzerOutputError).toBeUndefined();
      expect(analyzer?.analyzerStatus).toBe("accepted");
      expect(failed.plan?.markdown).toBe(expectedText);
      expect(await readFile(join(root, "src.cs"), "utf8")).toContain("Answer() => 42");
      await runtime.shutdown();
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), rm(scripts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })]);
    }
  });

  it("falls back when Codex emits events but no final Analyzer message", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runtime-no-final-test-"));
    const scripts = await mkdtemp(join(tmpdir(), "codex-no-final-script-test-"));
    try {
      await writeFile(join(root, "src.cs"), "class Target { }\n");
      const codex = join(scripts, "fake-no-final-codex.mjs");
      await writeFile(codex, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
if (readFileSync(0, 'utf8').includes('You are the Analyzer Codex')) {
  console.log(JSON.stringify({ type:'item.completed', item:{ type:'command_execution', aggregated_output:'read target' } }));
} else {
  writeFileSync('target/src.cs', 'class Target { public int Answer() => 42; }\\n');
  writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], 'done');
}
`);
      await chmod(codex, 0o755);
      const runtime = new CodexWorkspaceTranslationRuntime({
        workspaceRoot: root,
        compileCommand: { executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000 },
        codexCommand: codex,
        maxModelTurns: 2,
        timeoutMs: 30_000,
      });
      const run = runtime.start({
        spec: "Implement Answer.", sourceLanguage: "C#", targetLanguage: "C#",
        context: [{ id: "target", kind: "summary", content: "Target module" }], workspaceFiles: ["src.cs"], writeFiles: ["src.cs"],
      });
      const completed = await eventually(() => runtime.get(run.id), value => ["completed", "failed", "cancelled"].includes(value.status));
      const analyzer = completed.agent?.stages?.find(stage => stage.stage === "analyzer");
      expect(completed.status).toBe("completed");
      expect(analyzer?.analyzerStatus).toBe("fallback");
      expect(analyzer?.analyzerFallbackReason).toContain("empty implementation plan");
      expect(await readFile(join(root, "src.cs"), "utf8")).toContain("Answer() => 42");
      await runtime.shutdown();
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), rm(scripts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })]);
    }
  });

  it("extracts a plan nested in Codex JSONL assistant events", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runtime-jsonl-test-"));
    const scripts = await mkdtemp(join(tmpdir(), "codex-jsonl-script-test-"));
    try {
      await writeFile(join(root, "src.cs"), "class Target { }\n");
      const codex = join(scripts, "fake-jsonl-codex.mjs");
      await writeFile(codex, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
const prompt = readFileSync(0, 'utf8');
const plan = { summary:'implement answer', mappings:[{source:'requirement',targetPath:'src.cs',targetSymbol:'Answer'}], dependencies:[], steps:[{id:'answer',description:'implement answer',files:['src.cs'],dependsOn:[]}] };
if (!prompt.includes('You are the Analyzer Codex')) {
  writeFileSync('target/src.cs', 'class Target { public int Answer() => 42; }\\n');
  console.log(JSON.stringify({ type:'item.completed', item:{ type:'agent_message', text:'Implemented Answer.' } }));
}
else console.log(JSON.stringify({ type:'item.completed', item:{ type:'agent_message', text: JSON.stringify(plan) } }));
`);
      await chmod(codex, 0o755);
      const runtime = new CodexWorkspaceTranslationRuntime({
        workspaceRoot: root,
        compileCommand: { executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000 },
        codexCommand: codex,
        maxModelTurns: 2,
        timeoutMs: 30_000,
      });
      const run = runtime.start({
        spec: "Implement Answer.", sourceLanguage: "C#", targetLanguage: "C#",
        context: [{ id: "target", kind: "summary", content: "Target module" }], workspaceFiles: ["src.cs"], writeFiles: ["src.cs"],
      });
      const completed = await eventually(() => runtime.get(run.id), value => ["completed", "failed", "cancelled"].includes(value.status));
      expect(completed.status).toBe("completed");
      expect(completed.agent?.stages?.find(stage => stage.stage === "analyzer")?.analyzerStatus).toBe("accepted");
      expect(await readFile(join(root, "src.cs"), "utf8")).toContain("Answer() => 42");
      await runtime.shutdown();
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), rm(scripts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })]);
    }
  });

  it("does not pass a global CODEX_MODEL into the experiment child", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runtime-env-test-"));
    const scripts = await mkdtemp(join(tmpdir(), "codex-env-script-test-"));
    const previousModel = process.env.CODEX_MODEL;
    process.env.CODEX_MODEL = "personal-only-model";
    try {
      await writeFile(join(root, "src.cs"), "class Target { }\n");
      const codex = join(scripts, "fake-env-codex.mjs");
      await writeFile(codex, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
const answer = process.env.CODEX_MODEL === undefined ? 42 : 0;
writeFileSync('target/src.cs', 'class Target { public int Answer() => ' + answer + '; }\\n');
writeFileSync(output, 'done');
`);
      await chmod(codex, 0o755);
      const runtime = new CodexWorkspaceTranslationRuntime({
        workspaceRoot: root,
        compileCommand: { executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000 },
        codexCommand: codex,
        maxModelTurns: 2,
        timeoutMs: 30_000,
      });
      const run = runtime.start({
        spec: "Implement Answer directly.", sourceLanguage: "C#", targetLanguage: "C#",
        context: [{ id: "target", kind: "summary", content: "Target module" }], workspaceFiles: ["src.cs"], writeFiles: ["src.cs"],
        translationMode: "direct-translator",
      });
      const completed = await eventually(() => runtime.get(run.id), value => ["completed", "failed", "cancelled"].includes(value.status));
      expect(completed.status).toBe("completed");
      expect(await readFile(join(root, "src.cs"), "utf8")).toContain("Answer() => 42");
      await runtime.shutdown();
    } finally {
      if (previousModel === undefined) delete process.env.CODEX_MODEL;
      else process.env.CODEX_MODEL = previousModel;
      await Promise.all([rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), rm(scripts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })]);
    }
  });
});
