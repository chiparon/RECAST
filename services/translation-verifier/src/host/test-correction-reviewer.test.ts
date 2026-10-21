import { describe, expect, it } from "vitest";
import { createAgentRunBudget, DEFAULT_AGENT_RUN_LIMITS } from "./agent.js";
import { createModelTestCorrectionReviewer } from "./test-correction-reviewer.js";
import type { AgentCompletion } from "./model.js";

const input = {
  failure: { id: "failure", testId: "Suite#count", runId: "run", message: "Expected 3, received 2", versions: [], status: "unresolved" as const },
  correction: { failureId: "failure", reason: "Fixture contains two records.", requirementEvidence: "Return the count." },
  requirement: "Return the count.", beforeContent: "assertCount(3);", afterContent: "assertCount(2);",
  testCases: [{ id: "Suite#count", status: "passed" as const }],
};
describe("independent test correction reviewer", () => {
  it.each<AgentCompletion>([
    { content: "not JSON" },
    { content: '{"confirmed":true,"note":"looks good","replacementTestIds":[]}' },
    { content: '{"confirmed":"true","note":"looks good","replacementTestIds":["Suite#count"]}' },
    { toolCalls: [{ id: "exec", name: "run", arguments: "{}" }] },
  ])("rejects a malformed or unsupported decision: %j", async completion => {
    const budget = createAgentRunBudget();
    try {
      await expect(createModelTestCorrectionReviewer({ complete: async () => completion }, budget, DEFAULT_AGENT_RUN_LIMITS)(input)).rejects.toThrow(/review/i);
    } finally { budget.dispose(); }
  });
  it("shares the verification turn limit and never starts a second request beyond it", async () => {
    const budget = createAgentRunBudget({ maxTurns: 1 });
    let calls = 0;
    const reviewer = createModelTestCorrectionReviewer({ complete: async () => {
      calls++;
      return { content: '{"confirmed":true,"note":"Corrected count for the same fixture.","replacementTestIds":["Suite#count"]}' };
    } }, budget, DEFAULT_AGENT_RUN_LIMITS);
    try {
      expect(await reviewer(input)).toMatchObject({ confirmed: true });
      await expect(reviewer(input)).rejects.toThrow("turn budget");
      expect(calls).toBe(1);
    } finally { budget.dispose(); }
  });
  it("respects cancellation and the enclosing context budget", async () => {
    const controller = new AbortController();
    const budget = createAgentRunBudget({}, Date.now(), controller.signal);
    let calls = 0;
    const client = { complete: async () => { calls++; return { content: "{}" }; } };
    try {
      await expect(createModelTestCorrectionReviewer(client, budget, { ...DEFAULT_AGENT_RUN_LIMITS, maxContextCharacters: 1 })(input)).rejects.toThrow("context budget");
      controller.abort(new Error("cancel review"));
      await expect(createModelTestCorrectionReviewer(client, budget, DEFAULT_AGENT_RUN_LIMITS)(input)).rejects.toThrow("cancel review");
      expect(calls).toBe(0);
    } finally { budget.dispose(); }
  });
});
