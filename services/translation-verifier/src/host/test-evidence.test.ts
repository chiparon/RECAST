import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriteTargetTestTool } from "./tools/write-target-test.js";
import { createRunFunctionGroupTestsTool } from "./tools/run-function-group-tests.js";
import { createFinishFunctionGroupTool } from "./tools/finish-function-group.js";
import { createReportUncertainTool } from "./tools/report-uncertain.js";
import type { FunctionGroupTestRun, ToolContext } from "./tools/common.js";
import { hasUnresolvedTestFailures, testEvidence } from "./test-evidence.js";
import { parseJUnitTestCases, parseNodeTestCases, parseTrxTestCases } from "./coverage-reports.js";
import { createAgentHost } from "./runtime.js";
import { createFunctionGroupVerifier } from "../function-group-verify.js";
import { createRequirementFunctionGroupTask } from "../strategies/single-agent-function-group/strategy.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const target = { path: "src/Thing.ts", name: "run" };
function run(status: "passed" | "failed" | "skipped", id = "Suite#rejectsInvalidInput"): FunctionGroupTestRun {
  const passed = status === "passed";
  return { status: passed ? "success" : "failure", testPaths: ["tests/thing.test.ts"],
    tests: { executed: status === "skipped" ? 0 : 1, passed: passed ? 1 : 0, failed: status === "failed" ? 1 : 0, skipped: status === "skipped" ? 1 : 0 },
    testCases: [{ id, status, ...(status === "failed" ? { message: "expected rejection, received acceptance" } : {}) }],
    functions: [{ target, status: passed ? "passed" : "unverified", executed: true, lineCoverage: 100, branchCoverage: 100 }],
    failures: [], stdout: "", stderr: "", exitCode: passed ? 0 : 1, reason: passed ? "verified" : "test-failed" };
}
async function fixture(runs: FunctionGroupTestRun[]) {
  const root = await mkdtemp(join(tmpdir(), "verifier-evidence-")); roots.push(root);
  const group = { schemaVersion: "3.1" as const, mode: "requirement" as const,
    sourceLanguage: "TypeScript", targetLanguage: "TypeScript", targetProjectPath: root,
    requirement: "Reject invalid input. Return the count of accepted records.", functions: [{ target }] };
  const context: ToolContext = { state: {}, runtime: { sourceLanguage: "TypeScript", targetLanguage: "TypeScript",
    sourceProjectPath: root, targetProjectPath: root, sourcePath: target.path, targetPath: target.path, targetFunction: target,
    functionGroup: group, sourceDirectory: "src", targetDirectory: "src", testRoots: ["tests"], testRunner: "vitest", targetTest: { executable: "node", args: [] } },
    runner: { run: async () => { throw new Error("unused"); } }, functionGroupRunner: { run: async () => structuredClone(runs.shift()!) } };
  const write = createWriteTargetTestTool()(context), execute = createRunFunctionGroupTestsTool()(context), finish = createFinishFunctionGroupTool()(context);
  return { root, context, group, write: async (content: string, corrections?: unknown[]) => write.execute(write.parse({ path: "tests/thing.test.ts", content, ...(corrections ? { corrections } : {}) })),
    execute: () => execute.execute({ paths: ["tests/thing.test.ts"] }),
    finish: () => finish.execute(finish.parse({ testExecutionStatus: "success", translationStatus: "success" })) };
}

describe("Host test failure evidence", () => {
  it("retains a failed assertion and immutable version after replacing it with a passing normal-path test", async () => {
    const f = await fixture([run("failed"), run("passed", "Suite#acceptsValidInput")]);
    await f.write("assertRejectsInvalidInput();"); await f.execute();
    const old = testEvidence(f.context).failures[0]!;
    await f.write("assertAcceptsValidInput();"); await f.execute();
    const result = await f.finish();
    expect(result.functionGroupTest.status).toBe("success");
    expect(result.translationStatus).toBe("failure");
    expect(result.issue?.kind).toBe("unknown");
    expect(result.testEvidence?.failures[0]).toMatchObject({ id: old.id, status: "unresolved" });
    expect(await readFile(join(f.root, old.versions[0]!.artifactPath), "utf8")).toBe("assertRejectsInvalidInput();");
    const verification = await createFunctionGroupVerifier({ run: async () => result })(f.group, "requirement-function-group", "verify");
    expect(verification).toMatchObject({ status: "failure", reason: "unresolved-test-failure", testEvidence: result.testEvidence });
  });

  it("does not trust an Agent correction claim even with a valid public requirement quote", async () => {
    const f = await fixture([run("failed"), run("passed")]);
    await f.write("assertRejectsInvalidInput();"); await f.execute();
    await f.write("assertAcceptsInvalidInput();", [{ failureId: testEvidence(f.context).failures[0]!.id, reason: "The current implementation accepts it.", requirementEvidence: "Reject invalid input." }]);
    await f.execute();
    expect((await f.finish()).translationStatus).toBe("failure");
    expect(testEvidence(f.context).revisions.at(-1)?.corrections?.[0].status).toBe("proposed");
  });

  it("resolves an independently reviewed wrong expectation only after the same case executes and passes", async () => {
    const f = await fixture([run("failed"), run("passed")]);
    f.context.reviewTestCorrection = async input => ({ confirmed: input.beforeContent === "assertCount(3);" && input.afterContent === "assertCount(2);",
      note: "The fixture contains exactly two accepted records; the public contract requires their count. The corrected assertion retains the same check." });
    await f.write("assertCount(3);"); await f.execute();
    await f.write("assertCount(2);", [{ failureId: testEvidence(f.context).failures[0]!.id, reason: "Fixture contains two accepted records, not three.", requirementEvidence: "Return the count of accepted records." }]);
    expect(hasUnresolvedTestFailures(testEvidence(f.context))).toBe(true);
    await f.execute();
    expect((await f.finish()).translationStatus).toBe("success");
    expect(testEvidence(f.context).failures[0]?.resolution).toMatchObject({ kind: "reviewed-test-correction", requirementEvidence: "Return the count of accepted records." });
  });

  it.each(["passed", "skipped"] as const)("cannot resolve by deleting/renaming a failed case even with a confirmed correction: %s", async status => {
    const f = await fixture([run("failed"), run(status, "Suite#differentCase")]);
    f.context.reviewTestCorrection = async () => ({ confirmed: true, note: "Reviewed fixture change." });
    await f.write("assertRejectsInvalidInput();"); await f.execute();
    await f.write("differentCase();", [{ failureId: testEvidence(f.context).failures[0]!.id, reason: "Changed fixture.", requirementEvidence: "Reject invalid input." }]);
    await f.execute();
    expect(hasUnresolvedTestFailures(testEvidence(f.context))).toBe(true);
  });

  it("does not turn a compile error with zero executed failures into a permanent requirement failure", async () => {
    const compile = { ...run("failed"), tests: { executed: 0, passed: 0, failed: 0, skipped: 0 }, testCases: [], stderr: "Syntax error" };
    const f = await fixture([compile, run("passed")]);
    await f.write("broken syntax"); await f.execute(); await f.write("valid test"); await f.execute();
    expect((await f.finish()).translationStatus).toBe("success");
    expect(testEvidence(f.context).failures).toEqual([]);
    expect(testEvidence(f.context).runs).toHaveLength(2);
  });

  it("resolves the same passing case only when all original test files are unchanged", async () => {
    const f = await fixture([run("failed"), run("passed")]);
    await f.write("original assertion"); await f.execute(); await f.execute();
    expect((await f.finish()).translationStatus).toBe("success");
    expect(testEvidence(f.context).failures[0]?.resolution?.kind).toBe("unchanged-test-replayed");
  });

  it("keeps failures across fresh verifier attempts and report_uncertain", async () => {
    const f = await fixture([run("failed"), run("passed", "Suite#differentCase")]);
    await f.write("original assertion"); await f.execute();
    const seed = structuredClone(testEvidence(f.context)); f.context.state = {};
    f.context.runtime.functionGroup!.testEvidence = seed;
    await f.write("replacement assertion"); await f.execute();
    const tool = createReportUncertainTool()(f.context);
    const result = await tool.execute(tool.parse({ issue: { kind: "unknown", description: "Unresolved assertion" } }));
    expect("testEvidence" in result && result.testEvidence?.failures[0]?.status).toBe("unresolved");
    expect(testEvidence(f.context).runs).toHaveLength(2);
  });

  it("accepts a passing replay of the exact failing file in a fresh Host test root", async () => {
    const f = await fixture([run("failed"), run("passed")]);
    await f.write("original assertion"); await f.execute();
    const seed = structuredClone(testEvidence(f.context)); f.context.state = {};
    f.context.runtime.functionGroup!.testEvidence = seed;
    f.context.runtime.testRoots = ["new-tests"];
    const writer = createWriteTargetTestTool()(f.context);
    await writer.execute({ path: "new-tests/thing.test.ts", content: "original assertion" });
    const runner = createRunFunctionGroupTestsTool()(f.context);
    await runner.execute({ paths: ["new-tests/thing.test.ts"] });
    expect(hasUnresolvedTestFailures(testEvidence(f.context))).toBe(false);
    expect(testEvidence(f.context).failures[0]?.resolution?.kind).toBe("unchanged-test-replayed");
  });

  it("retains unknown executed failures rather than resolving them from green aggregate counts", async () => {
    const f = await fixture([{ ...run("failed"), testCases: [] }, run("passed")]);
    await f.write("test"); await f.execute(); await f.execute();
    expect((await f.finish()).translationStatus).toBe("failure");
    expect(testEvidence(f.context).failures[0]?.testId).toMatch(/^unidentified:/);
  });

  it("preserves a currently failing production-defect report for the existing repair path", async () => {
    const f = await fixture([run("failed")]);
    await f.write("assertRejectsInvalidInput();"); await f.execute();
    const tool = createFinishFunctionGroupTool()(f.context);
    const terminal = await tool.execute(tool.parse({ testExecutionStatus: "failure", translationStatus: "failure",
      issue: { kind: "translation", description: "The public invalid-input rejection requirement is violated." } }));
    const result = await createFunctionGroupVerifier({ run: async () => terminal })(f.group, "requirement-function-group", "verify");
    expect(result).toMatchObject({ status: "failure", reason: "test-failed", issue: { kind: "translation" } });
    expect(result.testEvidence?.failures[0]?.status).toBe("unresolved");
  });

  it("requires current versions to run again after a later edit", async () => {
    const f = await fixture([run("passed")]);
    await f.write("assertRejectsInvalidInput();"); await f.execute(); await f.write("replacement();");
    await expect(f.finish()).rejects.toThrow("Tests changed after their last Host run");
  });

  it("cannot erase a failure by weakening an imported fixture while leaving the test file unchanged", async () => {
    const f = await fixture([run("failed"), run("passed")]);
    const writer = createWriteTargetTestTool()(f.context);
    await writer.execute({ path: "tests/fixture.ts", content: "invalidInput" });
    await f.write("assertRejects(fixture);"); await f.execute();
    await writer.execute({ path: "tests/fixture.ts", content: "validInput" }); await f.execute();
    expect((await f.finish()).translationStatus).toBe("failure");
    expect(testEvidence(f.context).revisions.at(-1)).toMatchObject({ path: "tests/fixture.ts" });
  });

  it("cannot confirm a correction with invented requirement evidence", async () => {
    const f = await fixture([run("failed"), run("passed")]);
    let called = false;
    f.context.reviewTestCorrection = async () => { called = true; return { confirmed: true, note: "confirmed" }; };
    await f.write("failed"); await f.execute();
    await f.write("fixed", [{ failureId: testEvidence(f.context).failures[0]!.id, reason: "Wrong expectation", requirementEvidence: "Invalid inputs must be accepted." }]);
    await f.execute();
    expect(called).toBe(false);
    expect((await f.finish()).translationStatus).toBe("failure");
    expect(testEvidence(f.context).revisions.at(-1)?.corrections?.[0].status).toBe("unconfirmed");
  });

  it("retains the failure when independent correction review is unavailable", async () => {
    const f = await fixture([run("failed"), run("passed")]);
    f.context.reviewTestCorrection = async () => { throw new Error("review offline"); };
    await f.write("failed"); await f.execute();
    await f.write("fixed", [{ failureId: testEvidence(f.context).failures[0]!.id, reason: "Wrong fixture", requirementEvidence: "Reject invalid input." }]);
    await f.execute();
    expect((await f.finish()).translationStatus).toBe("failure");
    expect(testEvidence(f.context).revisions.at(-1)?.corrections?.[0]).toMatchObject({ status: "unconfirmed", reviewNote: "Correction review unavailable: review offline" });
  });

  it("attaches retained facts to an Agent budget exception", async () => {
    const f = await fixture([]);
    const seed = { runs: [], revisions: [], failures: [{ id: "f", runId: "r", testId: "case", message: "failed", versions: [], status: "unresolved" as const }] };
    const host = createAgentHost({ modelClient: { complete: async () => ({ content: "no tool" }) }, limits: { maxTurns: 1 },
      resolveToolContext: async () => f.context.runtime });
    await expect(host.run(createRequirementFunctionGroupTask({ ...f.group, testEvidence: seed }))).rejects.toMatchObject({ testEvidence: seed });
  });
});

describe("structured test case observations", () => {
  it("records JUnit failure/error/skipped cases with stable names and diagnostics", () => {
    expect(parseJUnitTestCases('<testsuites><testsuite name="Suite"><testcase name="ok"/><testcase name="bad" classname="Thing"><failure message="expected no effect">trace</failure></testcase><testcase name="error"><error/></testcase><testcase name="skip"><skipped/></testcase></testsuite></testsuites>')).toEqual([
      { id: "Suite#ok", status: "passed" }, { id: "Thing#bad", status: "failed", message: "expected no effect\ntrace" },
      { id: "Suite#error", status: "failed" }, { id: "Suite#skip", status: "skipped" },
    ]);
  });
  it("records Jest/Vitest assertions without inferring them from suite counters", () => {
    expect(parseNodeTestCases(JSON.stringify({ testResults: [{ name: "tests/thing.ts", assertionResults: [
      { fullName: "Thing rejects invalid", status: "failed", failureMessages: ["assertion mismatch"] }, { fullName: "Thing skipped", status: "pending" },
    ] }] }))).toEqual([{ id: "tests/thing.ts#Thing rejects invalid", status: "failed", message: "assertion mismatch" }, { id: "tests/thing.ts#Thing skipped", status: "skipped" }]);
  });
  it("records TRX cases using declared class and names instead of random execution ids", () => {
    expect(parseTrxTestCases('<TestRun><TestDefinitions><UnitTest id="uuid"><TestMethod className="ThingTests"/></UnitTest></TestDefinitions><Results><UnitTestResult testId="uuid" testName="Reject" outcome="Failed"><Output><ErrorInfo><Message>failed</Message></ErrorInfo></Output></UnitTestResult></Results></TestRun>')).toEqual([{ id: "ThingTests#Reject", status: "failed", message: "failed" }]);
  });
});
