import { afterEach, expect, it, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { ScriptedChatModel } from "../../../test-support/scripted-chat-model.js";
import { modelTestChangeReviewer, type TestChangeReview } from "./test-history.js";

type Payload = {
  requirement: string;
  failures: Array<{ test: string; original: string[] }>;
  current: string[];
  production: string[];
  files: Array<{ id: string; path: string; content: string }>;
};
afterEach(() => vi.unstubAllEnvs());
const input = (count: number, shared = false): TestChangeReview => ({
  requirement: "Reject expired tenants and preserve cross-module audit behavior.",
  failures: Array.from({ length: count }, (_, i) => ({ test: `Test${i}#expired`, message: "expected rejection",
    original: [{ path: shared ? "tests/Shared.java" : `tests/Test${i}.java`, content: `original-${shared ? 0 : i} ${"x".repeat(28_000)}` }] })),
  current: [{ path: "tests/Corrected.java", content: "assertRejected(); assertAuditRecorded();" }],
  production: [{ path: "src/Target.java", content: "rejectExpiredTenant(); recordAudit();" }],
});
const approved = () => new AIMessage({ content: JSON.stringify({ approved: true, note: "The corrected fixture retains rejection and audit assertions." }) });
function model(script: ConstructorParameters<typeof ScriptedChatModel>[0]) {
  const result = new ScriptedChatModel(script);
  // Deterministic local estimate: these tests never download tokenizer data.
  vi.spyOn(result, "getNumTokens").mockImplementation(async content => Math.ceil(String(content).length / 4));
  return result;
}
const payloads = (m: ScriptedChatModel) => m.observations.map(messages => JSON.parse(String(messages[1]!.content)) as Payload);

it("deduplicates repeated file versions so a raw input over 160k needs only one review", async () => {
  const evidence = input(12, true);
  expect(JSON.stringify(evidence).length).toBeGreaterThan(160_000);
  const reviewer = model([approved]);
  expect(await modelTestChangeReviewer(reviewer, new AbortController().signal)(evidence)).toMatchObject({ approved: true });
  const [batch] = payloads(reviewer);
  expect(batch!.files).toHaveLength(3);
  expect(new Set(batch!.failures.flatMap(failure => failure.original)).size).toBe(1);
  expect(batch!.failures).toHaveLength(12);
  expect(JSON.stringify(batch).length).toBeLessThan(JSON.stringify(evidence).length / 10);
});

it("reviews all independent failures in model-sized batches with full shared context", async () => {
  const evidence = input(8);
  const reviewer = model(Array.from({ length: 8 }, () => approved));
  const decision = await modelTestChangeReviewer(reviewer, new AbortController().signal, { contextTokens: 26_000 })(evidence);
  expect(decision.approved).toBe(true);
  const batches = payloads(reviewer);
  expect(batches.length).toBeGreaterThan(1);
  expect(batches.flatMap(batch => batch.failures.map(failure => failure.test)).sort()).toEqual(evidence.failures.map(failure => failure.test).sort());
  for (const batch of batches) {
    expect(batch.requirement).toBe(evidence.requirement);
    expect(batch.current.map(id => batch.files.find(file => file.id === id)!.content)).toEqual(evidence.current.map(file => file.content));
    expect(batch.production.map(id => batch.files.find(file => file.id === id)!.content)).toEqual(evidence.production.map(file => file.content));
    const referenced = new Set([...batch.current, ...batch.production, ...batch.failures.flatMap(failure => failure.original)]);
    expect(new Set(batch.files.map(file => file.id))).toEqual(referenced);
    expect(JSON.stringify(batch).length / 4 + 1000).toBeLessThan(26_000 * 0.9 - 4096 - 256);
  }
});

it("splits on a real provider context rejection when its profile estimate is too large", async () => {
  const reviewer = model([
    () => { throw Object.assign(new Error("request exceeds provider context"), { code: "context_length_exceeded" }); },
    approved, approved,
  ]);
  const result = await modelTestChangeReviewer(reviewer, new AbortController().signal, { contextTokens: 200_000 })(input(2));
  expect(result.approved).toBe(true);
  expect(payloads(reviewer).map(batch => batch.failures.length)).toEqual([2, 1, 1]);
});

it("does not reject or truncate a single large correction based on a local estimate", async () => {
  const evidence = input(1);
  evidence.failures[0]!.original[0]!.content = "original assertion " + "x".repeat(180_000);
  const reviewer = model([approved]);
  expect((await modelTestChangeReviewer(reviewer, new AbortController().signal, { contextTokens: 4096 })(evidence)).approved).toBe(true);
  expect(payloads(reviewer)[0]!.files.some(file => file.content === evidence.failures[0]!.original[0]!.content)).toBe(true);
});

it("keeps failures sharing the same original files together instead of repeating a large review", async () => {
  const evidence = input(12, true);
  for (const failure of evidence.failures) failure.original[0]!.content = "shared original " + "x".repeat(180_000);
  const reviewer = model([approved]);
  expect((await modelTestChangeReviewer(reviewer, new AbortController().signal, { contextTokens: 26_000 })(evidence)).approved).toBe(true);
  expect(reviewer.observations).toHaveLength(1);
  expect(payloads(reviewer)[0]!.failures).toHaveLength(12);
});

it("keeps a weakened batch rejected rather than retrying it for a favorable answer", async () => {
  const reviewer = model([approved, () => new AIMessage({ content: JSON.stringify({ approved: false, note: "Required rejection assertion was removed." }) })]);
  const result = await modelTestChangeReviewer(reviewer, new AbortController().signal, { contextTokens: 26_000 })(input(4));
  expect(result).toEqual({ approved: false, note: "Required rejection assertion was removed." });
  expect(reviewer.observations).toHaveLength(2);
});

it("preserves evidence when even one correction exceeds the provider context", async () => {
  const reviewer = model([() => { throw Object.assign(new Error("context length exceeded"), { code: "context_length_exceeded" }); }]);
  const decision = await modelTestChangeReviewer(reviewer, new AbortController().signal)(input(1));
  expect(decision).toMatchObject({ approved: false, note: expect.stringContaining("no evidence was truncated") });
  expect(reviewer.observations).toHaveLength(1);
});

it("does not split on unrelated errors or continue after cancellation", async () => {
  const failure = model([() => { throw Object.assign(new Error("rate limited"), { status: 429 }); }]);
  await expect(modelTestChangeReviewer(failure, new AbortController().signal)(input(2))).rejects.toThrow("rate limited");
  expect(failure.observations).toHaveLength(1);
  const controller = new AbortController();
  const cancelled = model([() => { controller.abort(new Error("cancel review")); return approved(); }, approved]);
  await expect(modelTestChangeReviewer(cancelled, controller.signal, { contextTokens: 26_000 })(input(4))).rejects.toThrow("cancel review");
  expect(cancelled.observations).toHaveLength(1);
});

it.each(["profile", "environment", "host option"])("uses the %s context budget for batching", async source => {
  const reviewer = model(Array.from({ length: 4 }, () => approved));
  Object.defineProperty(reviewer, "profile", { get: () => ({ maxInputTokens: source === "profile" ? 26_000 : 200_000 }) });
  vi.stubEnv("TRANSLATION_VERIFIER_REVIEW_CONTEXT_TOKENS", source === "environment" ? "26000" : source === "host option" ? "200000" : undefined);
  const decision = await modelTestChangeReviewer(reviewer, new AbortController().signal,
    source === "host option" ? { contextTokens: 26_000 } : {})(input(4));
  expect(decision.approved).toBe(true);
  expect(reviewer.observations.length).toBeGreaterThan(1);
});

it("reports invalid context configuration instead of silently accepting it", async () => {
  vi.stubEnv("TRANSLATION_VERIFIER_REVIEW_CONTEXT_TOKENS", "invalid");
  const reviewer = model([approved]);
  await expect(modelTestChangeReviewer(reviewer, new AbortController().signal)(input(1))).rejects.toThrow("positive integer");
  expect(reviewer.observations).toHaveLength(0);
});
