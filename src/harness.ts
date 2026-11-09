import { searchModules } from "../../weichai/services/code-intelligence-service/src/module-matching.ts";
import { searchModulesWithSag2 } from "../../weichai/services/code-intelligence-service/src/sag2-retrieval.ts";
import { decisionJudge } from "./openai.ts";
import { target } from "./corpus.ts";
export const modes = [
  "no-history-direct",
  "standard-1hop",
  "sag2-1hop",
  "sag2-2hop",
] as const;
export async function retrieve(c, u, mode, signal) {
  let diagnostics = null;
  const judge = [];
  const request = {
    target: target(u),
    requirement: u.query,
    topK: 4,
    repositoryIds: c.scopes.map((s) => s.repositoryId),
  };
  const start = performance.now();
  const candidates =
    mode === "no-history-direct"
      ? []
      : mode === "standard-1hop"
        ? await searchModules(c.store, request, signal)
        : await searchModulesWithSag2(c.store, request, signal, {
            maxHops: mode === "sag2-1hop" ? 1 : 2,
            jevJudge: decisionJudge(judge),
            observeDiagnostics: (d) => {
              diagnostics = d;
            },
          });
  const retrievalMs =
    mode === "no-history-direct" ? null : performance.now() - start;
  return {
    candidates,
    trace: {
      unit: u.name,
      query: u.query,
      required: u.required,
      ranked: candidates.map((x) => ({
        id: x.sourceModule.moduleId,
        candidateId: x.id,
        repository: x.sourceModule.repositoryId,
        score: x.score.overall,
      })),
      diagnostics,
      judge,
      retrievalMs,
    },
  };
}
