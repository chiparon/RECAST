import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodeIntelligenceHost } from "../../weichai/apps/vscode-extension/src/code-intelligence-host.ts";
import {
  createCodeIntelligenceRuntime,
  Sag2Bm25IndexStore,
  createSemanticQueryHttpServer,
} from "../../weichai/services/code-intelligence-service/src/index.ts";
import { HttpWorkspaceEvidencePort } from "../../weichai/services/adaptation-service/src/http-workspace-evidence-port.ts";
import { testHeader, type Scenario } from "./scenarios/types.ts";
import { indexScenarioHistory } from "./history-fixture.ts";
export { digest, target } from "./history-fixture.ts";
export async function corpus(s: Scenario, root: string) {
  const store = new Sag2Bm25IndexStore();
  const runtime = await createCodeIntelligenceRuntime({ store });
  const host = new CodeIntelligenceHost({
    runtimeFactory: async () => runtime,
  });
  const suite: Record<string, string> = {};
  const source = join(root, "skeleton");
  await mkdir(join(source, "tests"), { recursive: true });
  for (const u of s.units) {
    await writeFile(
      join(source, u.name + ".mjs"),
      "// " +
        u.contract +
        '\nexport function run(...args) { throw new Error("TODO"); }\n',
    );
    suite["tests/" + u.name + ".mjs"] =
      testHeader +
      "import {run} from '../" +
      u.name +
      ".mjs';\n" +
      u.test +
      "\n";
  }
  suite["tests/all.mjs"] =
    testHeader +
    s.units.map((u) => "await import('./" + u.name + ".mjs');").join("\n") +
    "\n" +
    (s.joint ?? "") +
    "\n";
  suite["tests/check.mjs"] =
    "import {execFileSync} from 'node:child_process';\n" +
    s.units
      .map(
        (u) =>
          "execFileSync(process.execPath,['--check'," +
          JSON.stringify(u.name + ".mjs") +
          "],{stdio:'inherit'});",
      )
      .join("\n");
  for (const [file, content] of Object.entries(suite))
    await writeFile(join(source, file), content);
  const { scopes, repos, catalog } = await indexScenarioHistory(
    s,
    root,
    runtime,
  );
  await host.synchronize({ repositories: repos, scan: false });
  const server = createSemanticQueryHttpServer({
    queryPort: runtime.queryPort,
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const evidence = new HttpWorkspaceEvidencePort({
    endpoint: "http://127.0.0.1:" + server.address().port,
  });
  return {
    s,
    source,
    suite,
    store,
    host,
    scopes,
    catalog,
    evidence,
    plan: store.bm25.explainQueryPlan(),
    close: async () => {
      await new Promise((ok) => server.close(ok));
      await host.dispose();
      await store.close();
    },
  };
}
