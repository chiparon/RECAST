import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("copies only the history module, rejects out-of-scope edits, and keeps hidden criteria out of staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runtime-test-"));
    const history = await mkdtemp(join(tmpdir(), "forexplore-history-view-"));
    const scripts = await mkdtemp(join(tmpdir(), "codex-script-test-"));
    try {
      await writeFile(join(root, "src.cs"), "class Target { }\n");
      await writeFile(join(root, "visible.txt"), "visible\n");
      await writeFile(join(root, "hidden.txt"), "secret criteria\n");
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
const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
if (!existsSync('CODEX_IMPLEMENTATION_PLAN.json')) {
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
      expect(completed.plan?.steps.map(step => step.id)).toEqual(["answer"]);
      expect(completed.agent?.stages?.map(stage => [stage.stage, stage.sandbox])).toEqual([["analyzer", "read-only"], ["translator", "workspace-write"]]);
      expect(completed.agent?.stages?.every(stage => stage.readFiles?.includes("history-view/source/Legacy.cs"))).toBe(true);
      expect(completed.agent?.incrementalLines).toBeGreaterThan(0);
      await runtime.shutdown();
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(history, { recursive: true, force: true }), rm(scripts, { recursive: true, force: true })]);
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
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses the direct Translator route when history is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runtime-direct-test-"));
    const scripts = await mkdtemp(join(tmpdir(), "codex-direct-script-test-"));
    try {
      await writeFile(join(root, "src.cs"), "class Target { }\n");
      const codex = join(scripts, "fake-direct-codex.mjs");
      await writeFile(codex, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
const prompt = process.argv.at(-1) ?? '';
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
      await Promise.all([rm(root, { recursive: true, force: true }), rm(scripts, { recursive: true, force: true })]);
    }
  });

  it("records invalid Analyzer JSON and its validation error", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runtime-analyzer-log-test-"));
    const scripts = await mkdtemp(join(tmpdir(), "codex-analyzer-log-script-test-"));
    try {
      await writeFile(join(root, "src.cs"), "class Target { }\n");
      const codex = join(scripts, "fake-invalid-analyzer.mjs");
      await writeFile(codex, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
const prompt = process.argv.at(-1) ?? '';
if (prompt.includes('Direct Translator Codex')) writeFileSync('target/src.cs', 'class Target { public int Answer() => 42; }\\n');
else writeFileSync(output, JSON.stringify({ summary: 'missing mappings and steps' }));
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
        context: [{ id: "target", kind: "summary", content: "Target module" }], workspaceFiles: ["src.cs"], writeFiles: ["src.cs"],
      });
      const failed = await eventually(() => runtime.get(run.id), value => ["completed", "failed", "cancelled"].includes(value.status));
      expect(failed.status).toBe("completed");
      const analyzer = failed.agent?.stages?.find(stage => stage.stage === "analyzer");
      expect(analyzer?.analyzerOutput).toContain("missing mappings and steps");
      expect(analyzer?.analyzerOutputError).toContain("Plan requires summary, mappings, dependencies and implementation steps");
      expect(analyzer?.analyzerStatus).toBe("fallback");
      expect(await readFile(join(root, "src.cs"), "utf8")).toContain("Answer() => 42");
      await runtime.shutdown();
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(scripts, { recursive: true, force: true })]);
    }
  });

  it("falls back when Codex emits events but no final Analyzer message", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runtime-no-final-test-"));
    const scripts = await mkdtemp(join(tmpdir(), "codex-no-final-script-test-"));
    try {
      await writeFile(join(root, "src.cs"), "class Target { }\n");
      const codex = join(scripts, "fake-no-final-codex.mjs");
      await writeFile(codex, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--output-schema')) {
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
      expect(analyzer?.analyzerFallbackReason).toContain("Plan requires");
      expect(await readFile(join(root, "src.cs"), "utf8")).toContain("Answer() => 42");
      await runtime.shutdown();
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(scripts, { recursive: true, force: true })]);
    }
  });

  it("extracts a plan nested in Codex JSONL assistant events", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runtime-jsonl-test-"));
    const scripts = await mkdtemp(join(tmpdir(), "codex-jsonl-script-test-"));
    try {
      await writeFile(join(root, "src.cs"), "class Target { }\n");
      const codex = join(scripts, "fake-jsonl-codex.mjs");
      await writeFile(codex, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
const prompt = process.argv.at(-1) ?? '';
const plan = { summary:'implement answer', mappings:[{source:'requirement',targetPath:'src.cs',targetSymbol:'Answer'}], dependencies:[], steps:[{id:'answer',description:'implement answer',files:['src.cs'],dependsOn:[]}] };
if (!process.argv.includes('--output-schema')) writeFileSync('target/src.cs', 'class Target { public int Answer() => 42; }\\n');
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
      await Promise.all([rm(root, { recursive: true, force: true }), rm(scripts, { recursive: true, force: true })]);
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
import { writeFileSync } from 'node:fs';
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
      await Promise.all([rm(root, { recursive: true, force: true }), rm(scripts, { recursive: true, force: true })]);
    }
  });
});
