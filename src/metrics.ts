import type { RetrievalMetrics, DevelopmentVelocityMetrics } from "./schema.ts";
import { scenarios } from "./scenarios/index.ts";
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export function mean(xs: (number | null)[]) {
  const n = xs.filter((x): x is number => x != null);
  return n.length ? sum(n) / n.length : null;
}
export function percentile(values: number[], p: number) {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.ceil(s.length * p) - 1] : null;
}
export function retrievalMetrics(r): RetrievalMetrics[] {
  const s = scenarios.find((s) => s.id === r.scenario)!;
  return r.retrieval.map((t) => {
    const ranked = t.ranked.slice(0, 4),
      ids = ranked.map((x) => x.id),
      diag = t.diagnostics;
    const req = t.required,
      rank = ids.indexOf(req[0]),
      hit = req.filter((x) => ids.includes(x)).length;
    const selected = r.translations.find((x) => x.unit === t.unit)?.selected;
    const collab = req.slice(1);
    const dcg = sum(
      ids.map((x, i) => (req.includes(x) ? 1 / Math.log2(i + 2) : 0)),
    );
    const ideal = sum(req.slice(0, 4).map((_, i) => 1 / Math.log2(i + 2)));
    const disc = ranked.find((x) => x.id === s.bridge);
    const applicable = r.mode !== "no-history-direct";
    return {
      scenario: r.scenario,
      mode: r.mode,
      unit: t.unit,
      anchorHit1: applicable ? Number(rank === 0) : null,
      anchorHit4: applicable ? Number(rank >= 0) : null,
      mrr: applicable ? (rank < 0 ? 0 : 1 / (rank + 1)) : null,
      recall4: applicable ? hit / req.length : null,
      allRequiredHit4: applicable ? Number(hit === req.length) : null,
      ndcg4: applicable ? dcg / ideal : null,
      collaboratorRecall4:
        applicable && collab.length
          ? collab.filter((x) => ids.includes(x)).length / collab.length
          : null,
      hop2Discovery:
        diag && s.bridge && r.mode === "sag2-2hop"
          ? Number(
              !!disc &&
                !!selected?.includes(s.bridge) &&
                diag.hop2NewlyDiscoveredIds.includes(disc.candidateId),
            )
          : null,
      responsibilityCoverage: diag?.responsibilities.length
        ? diag.coveredIndices.length / diag.responsibilities.length
        : null,
      contextCompleteness: selected
        ? req.filter((x) => selected.includes(x)).length / req.length
        : null,
      distractorRejection: applicable
        ? Number(!ids.some((x) => x.startsWith("display-")))
        : null,
      earlyExit:
        s.early && r.mode === "sag2-2hop" && diag
          ? Number(diag.hopsExecuted === 1)
          : null,
      retrievalMs: t.retrievalMs,
    };
  });
}
export function velocityMetrics(r): DevelopmentVelocityMetrics {
  const records = r.translations.map((x) => x.record),
    agent = r.translations.flatMap((x) => x.api),
    judge = r.retrieval.flatMap((x) => x.judge);
  const tools = agent.flatMap((x) => x.tools),
    ev = records.flatMap((x) => x.evidenceQueries ?? []);
  const comp = records.flatMap((x) => x.compilations),
    tests = records.flatMap((x) => x.verification?.runs ?? []);
  const final = (r.project.validationHistory ?? []).flatMap((v) =>
    [v.compilation, v.verification].filter(Boolean),
  );
  const childMs = sum([...comp, ...tests].map((x) => x.durationMs));
  const first = (runs) =>
    runs.length && runs.every((x) => x.length)
      ? Number(runs.every((x) => x[0].success))
      : null;
  return {
    scenario: r.scenario,
    mode: r.mode,
    delivered: Number(r.e2eDeliveryMs != null),
    elapsedMs: r.elapsedMs,
    e2eDeliveryMs: r.e2eDeliveryMs,
    retrievalMs:
      r.mode === "no-history-direct"
        ? null
        : sum(r.retrieval.map((x) => x.retrievalMs)),
    scopePrepMs: r.scopePrepMs,
    agentLoopMs: r.loopWallMs - childMs,
    compileAndVerifyMs: childMs + sum(final.map((x) => x.durationMs)),
    modelTurns: sum(records.map((x) => x.modelTurns)),
    toolCallCount: tools.length,
    evidenceQueryCount: ev.length,
    evidenceCharsPulled: sum(ev.map((x) => x.characters)),
    planRevisions: tools.filter((x) => x === "revise_plan").length,
    compileAttempts: comp.length,
    testAttempts: tests.length,
    firstPassCompileSuccess: first(records.map((x) => x.compilations)),
    firstPassVerifySuccess: first(
      records.map((x) => x.verification?.runs ?? []),
    ),
    integrationRepairCount: r.project.modules.filter((x) =>
      x.id.startsWith("pipeline-integration-repair"),
    ).length,
    agentInputTokens: sum(agent.map((x) => x.usage.input_tokens)),
    agentOutputTokens: sum(agent.map((x) => x.usage.output_tokens)),
    judgeInputTokens: sum(judge.map((x) => x.usage.input_tokens)),
    judgeOutputTokens: sum(judge.map((x) => x.usage.output_tokens)),
    contextChars: sum(
      records.flatMap((x) => x.request.context.map((y) => y.content.length)),
    ),
    timeSpeedupVsDirect: null,
    timeSpeedupVsStandard: null,
    turnsSpeedupVsDirect: null,
    turnsSpeedupVsStandard: null,
  };
}
export function pair(rows) {
  for (const r of rows)
    for (const [mode, suffix] of [
      ["no-history-direct", "Direct"],
      ["standard-1hop", "Standard"],
    ]) {
      const b = rows.find((x) => x.scenario === r.scenario && x.mode === mode);
      if (r.delivered && b?.delivered) {
        r["timeSpeedupVs" + suffix] = b.e2eDeliveryMs / r.e2eDeliveryMs;
        r["turnsSpeedupVs" + suffix] = b.modelTurns / r.modelTurns;
      }
    }
  return rows;
}
