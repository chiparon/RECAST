export interface ProjectModule {
  name: string;
  path: string;
  description: string;
  dependsOn: string[];
}
export interface AcceptanceCheck {
  id: string;
  body: string;
}
export interface ProjectTask {
  id: string;
  title: string;
  requirement: string;
  modules: ProjectModule[];
  files: Record<string, string>;
  acceptance: AcceptanceCheck[];
}
export interface ModuleDefinition {
  name: string;
  description: string;
  dependsOn?: string[];
  skeleton: string;
  smoke: string;
}
interface Definition {
  id: string;
  title: string;
  goal: string;
  refs: Record<string, string>;
  modules: ModuleDefinition[];
  jointSmoke: string;
  acceptance: AcceptanceCheck[];
}
const header = "import assert from 'node:assert/strict';\n";
export function defineTask(d: Definition): ProjectTask {
  const modules = d.modules.map((m) => ({
    name: m.name,
    path: m.name + ".mjs",
    description: m.description,
    dependsOn: m.dependsOn ?? [],
  }));
  const requirement =
    [
      "# " + d.title,
      "",
      d.goal,
      "",
      "Implement the named ES module exports using Node.js built-ins. Functions are synchronous. Only the following production files may be changed.",
      "",
      ...modules.map((m) => "- " + m.path + " (dependencies: " +
        (m.dependsOn.join(", ") || "none") + ") — " + m.description),
      "",
      "Reference modules in refs/ and public tests in tests/ are read-only. Additional grading covers the same specified behavior. Do not install dependencies.",
    ].join("\n") + "\n";
  const files: Record<string, string> = { "SPEC.md": requirement, ...d.refs };
  for (const m of d.modules) {
    files[m.name + ".mjs"] = m.skeleton.trim() + "\n";
    files["tests/" + m.name + ".mjs"] = header + m.smoke.trim() + "\n";
  }
  files["tests/check.mjs"] =
    [
      "import { execFileSync } from 'node:child_process';",
      ...modules.map(
        (m) =>
          'execFileSync(process.execPath, ["--check", ' +
          JSON.stringify(m.path) +
          '], {stdio:"inherit"});',
      ),
    ].join("\n") + "\n";
  files["tests/all.mjs"] =
    header +
    d.modules.map((m) => "await import('./" + m.name + ".mjs');").join("\n") +
    "\n" +
    d.jointSmoke.trim() +
    "\n";
  return {
    id: d.id,
    title: d.title,
    requirement,
    modules,
    files,
    acceptance: d.acceptance,
  };
}
