import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { StructuralSag2JevJudge } from "../../weichai/services/code-intelligence-service/src/sag2-jev.ts";
const model = "gpt-6-luna";
async function call(endpoint: string, body: object, signal?: AbortSignal) {
  const keyFile = process.env.RECAST_KEY_FILE;
  if (!keyFile) throw new Error("Set RECAST_KEY_FILE to the path of your OpenAI key file.");
  const key = (await readFile(keyFile, "utf8")).trim();
  for (let retry = 0; ; retry++) {
    let r: Response;
    try {
      r = await fetch("https://api.openai.com/v1/" + endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, ...body }),
        signal: AbortSignal.any([
          AbortSignal.timeout(90000),
          ...(signal ? [signal] : []),
        ]),
      });
    } catch (error) {
      if (retry >= 2 || signal?.aborted) throw error;
      await delay(1000 * 2 ** retry);
      continue;
    }
    if (r.ok) return r.json();
    const detail = await r.json().catch(() => ({}));
    if (
      retry >= 3 ||
      ![429, 500, 502, 503, 504].includes(r.status) ||
      detail.error?.code === "insufficient_quota"
    )
      throw Error(
        "OpenAI " +
          endpoint +
          " HTTP " +
          r.status +
          " " +
          (detail.error?.message ?? "").replace(/sk-[^\s"]+/g, "[redacted]"),
      );
    await delay(
      Math.min(
        30000,
        Math.max(
          1000 * 2 ** retry,
          Number(r.headers.get("retry-after")) * 1000,
        ),
      ),
    );
  }
}
export function agentClient(trace: any[]) {
  return {
    async complete(messages, tools, signal) {
      const input = messages.flatMap((m) => {
        if (m.role === "tool")
          return [
            {
              type: "function_call_output",
              call_id: m.toolCallId,
              output: m.content,
            },
          ];
        return [
          ...(m.content ? [{ role: m.role, content: m.content }] : []),
          ...(m.toolCalls ?? []).map((t) => ({
            type: "function_call",
            call_id: t.id,
            name: t.name,
            arguments: t.arguments,
          })),
        ];
      });
      const start = performance.now();
      const r = await call(
        "responses",
        {
          input,
          store: false,
          reasoning: { effort: "low" },
          tools: tools.map((t) => ({
            type: "function",
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
            strict: false,
          })),
        },
        signal,
      );
      const toolCalls = r.output
        .filter((x) => x.type === "function_call")
        .map((x) => ({ id: x.call_id, name: x.name, arguments: x.arguments }));
      trace.push({
        ms: performance.now() - start,
        model: r.model,
        usage: r.usage,
        responseId: r.id,
        tools: toolCalls.map((x) => x.name),
      });
      return {
        toolCalls,
        content: r.output
          .flatMap((x) => x.content ?? [])
          .map((x) => x.text ?? "")
          .join(""),
      };
    },
  };
}
export function decisionJudge(trace: any[]) {
  const structural = new StructuralSag2JevJudge();
  return {
    async evaluate(input) {
      const result = await structural.evaluate(input);
      if (!input.candidates.length) return result;
      const questions = result.decisions.flatMap((_, i) =>
        result.responsibilities.map((r) => ({
          type: "predicate",
          name: "c" + i + "r" + r.index,
          instructions:
            "Does candidate " +
            i +
            " supply concrete implementation evidence for responsibility " +
            r.index +
            "? A mention, call to another component, UI, or label alone is insufficient.",
        })),
      );
      const start = performance.now();
      const r = await call(
        "decisions",
        {
          input: JSON.stringify({
            responsibilities: result.responsibilities.map((x) => ({
              index: x.index,
              text: x.label,
            })),
            candidates: input.candidates.map((x, i) => ({
              index: i,
              title: x.title,
              summary: x.summary,
              source: x.preview.slice(0, 4500),
            })),
          }),
          questions,
        },
        input.signal,
      );
      if (
        r.answers.length !== questions.length ||
        r.answers.some(
          (a, i) =>
            a.type !== "predicate" ||
            a.name !== questions[i].name ||
            !Number.isFinite(a.probability),
        )
      )
        throw Error("Incomplete Decisions API verdict");
      trace.push({
        ms: performance.now() - start,
        model: r.model,
        usage: r.usage,
        answers: r.answers,
      });
      const scores = new Map(r.answers.map((a) => [a.name, a.probability]));
      for (const [i, d] of result.decisions.entries()) {
        const probs = result.responsibilities.map((x) =>
          Number(scores.get("c" + i + "r" + x.index)),
        );
        d.covers = result.responsibilities
          .filter((_, j) => probs[j] >= 0.5)
          .map((x) => x.index);
        const best = Math.max(0, ...probs);
        d.score =
          0.75 * best +
          0.15 * d.score +
          (0.1 * d.covers.length) / Math.max(1, probs.length);
        d.verdict = d.covers.length
          ? "anchor"
          : best >= 0.2
            ? "supporting"
            : "irrelevant";
      }
      result.coveredIndices = [
        ...new Set(result.decisions.flatMap((d) => d.covers)),
      ].sort((a, b) => a - b);
      result.missingResponsibilities = result.responsibilities.filter(
        (x) => !result.coveredIndices.includes(x.index),
      );
      result.bridgeTerms = [
        ...new Set(
          result.decisions
            .filter((d) => d.verdict !== "irrelevant")
            .sort((a, b) => b.score - a.score)
            .flatMap((d) => d.bridgeTerms),
        ),
      ].slice(0, 20);
      result.hop2Queries = [];
      if (result.missingResponsibilities.length && result.bridgeTerms.length)
        result.hop2Queries.push({
          label: "sag2-hop2-associative-bridge",
          query: result.bridgeTerms.join(" "),
          weight: 1,
        });
      return result;
    },
  };
}
