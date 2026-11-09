import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Command, RealFixture } from "./types.ts";

const execute = promisify(execFile);
const assets = fileURLToPath(new URL("./case-two/", import.meta.url));
const upstream = {
  url: "https://github.com/nedbat/coveragepy.git",
  commit: "7e5373eadff4753bb9273dad43bdee98bff65af0",
};
const encoder = "coverage/html_context.py";
const viewer = "coverage/htmlfiles/context_view.js";
const requirement = `Restore the execution-context explorer in coverage.py HTML reports. Keep the existing report writer, templates and UI entry point compatible. Implement only coverage/html_context.py and coverage/htmlfiles/context_view.js.

The Python writer calls allocate_context_codes(line_contexts, encode_int) with an iterable of per-line context names and its existing HTML-safe integer encoder. Assign distinct names codes starting at zero, most frequent first and first encounter first for ties. Return a name-to-code dict. serialize_contexts(codes) returns None for an empty mapping or a JSON string mapping codes back to names. It is embedded in an inline script, so arbitrary Unicode names, including a literal closing script tag, must survive safely. encode_line(names, codes) returns an empty string for an empty list. Otherwise preserve the given order and concatenate the one-digit maximum code width followed by each code padded on the right with spaces to that width. The supplied integer encoder produces no spaces and practical report widths are one through nine.

The browser receives that dictionary as the contexts global. Implement coverage.expand_contexts(event) in the deferred context_view.js script loaded on source pages. Get the .ctxs span from the target's parent. On first click replace the compact payload with each decoded context name as a DOM text node followed by a br element, then mark the span expanded. Repeated clicks must preserve the rendered nodes. Never interpret context labels as HTML.

Public checks run with node bench-public/check.mjs and take no external dependencies. The integration check builds a source report through the real coverage.Coverage API and clicks its shipped browser handler. The production source package, including the C tracer, ships in the workspace. The tests use the native Python tracer and Node's JS engine.`;

function command(mode: string): Command {
  return { executable: process.execPath, args: ["bench-public/check.mjs", mode], timeoutMs: 30_000 };
}

export const fixture: RealFixture = {
  id: "coverage-html-contexts",
  title: "coverage.py HTML execution-context explorer",
  upstream,
  requirement,
  modules: [
    { name: "ContextEncoder", language: "Python", path: encoder, description: "Allocate, serialize and pack report contexts for source lines." },
    { name: "ContextViewer", language: "JavaScript", path: viewer, description: "Expand packed line contexts into safe browser DOM nodes.", dependsOn: ["ContextEncoder"] },
  ],
  references: ["coverage/html.py", "coverage/htmlfiles/pyfile.html", "coverage/htmlfiles/coverage_html.js", "coverage/templite.py", "coverage/data.py"],
  compile: command("compile"),
  test: command("all"),
  moduleTests: { ContextEncoder: command("encoder"), ContextViewer: command("viewer") },
  productionFiles: (path) => /^coverage\/.*\.(?:py|c|h|js|html|scss)$/.test(path),
  async prepare(root, variant) {
    await execute("python", ["-I", "-B", join(assets, "prepare.py"), root, variant, upstream.url, upstream.commit], { timeout: 180_000, windowsHide: true });
    await writeFile(join(root, "SPEC.md"), requirement + "\n");
  },
  async grade(root) {
    const checks = [];
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
      ["path", "systemroot", "windir", "temp", "tmp", "comspec", "pathext", "systemdrive"].includes(k.toLowerCase())));
    for (const mode of ["rank-and-pack", "inline-data", "wide-context-report", "plain-report"]) {
      try {
        await execute(process.execPath, [join(assets, "grade.mjs"), mode], {
          cwd: root, env, timeout: 30_000, windowsHide: true,
        });
        checks.push({ id: mode, passed: true });
      } catch (e) {
        checks.push({ id: mode, passed: false, error: String(e).slice(-1800) });
      }
    }
    return checks;
  },
};
