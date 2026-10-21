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
    await expect(f.write("fixed", [{ failureId: testEvidence(f.context).failures[0]!.id, reason: "Wrong expectation", requirementEvidence: "Invalid inputs must be accepted." }])).rejects.toThrow("exact public requirement excerpt");
    expect(await readFile(join(f.root, "tests/thing.test.ts"), "utf8")).toBe("failed");
    await f.write("fixed");
    await f.execute();
    expect(called).toBe(false);
    expect((await f.finish()).translationStatus).toBe("failure");
  });

  it("rejects a mistyped failure id before writing and permits retry with the actual Host id", async () => {
    const f = await fixture([run("failed"), run("passed")]);
    f.context.reviewTestCorrection = async () => ({ confirmed: true, note: "The corrected fixture preserves the requirement." });
    await f.write("failed fixture"); await f.execute();
    const failure = testEvidence(f.context).failures[0]!;
    await expect(f.write("corrected fixture", [{ failureId: "CS0103", reason: "Wrong fixture", requirementEvidence: "Reject invalid input." }])).rejects.toThrow(failure.id);
    expect(await readFile(join(f.root, "tests/thing.test.ts"), "utf8")).toBe("failed fixture");
    expect(testEvidence(f.context).revisions).toHaveLength(1);
    await f.write("corrected fixture", [{ failureId: failure.id, reason: "Wrong fixture", requirementEvidence: "Reject invalid input." }]);
    await f.execute();
    expect((await f.finish()).translationStatus).toBe("success");
  });

  it("reviews the immutable failing version after intermediate edits, only once the replacement executes", async () => {
    const f = await fixture([run("failed"), run("passed")]);
    const reviewed: string[] = [];
    f.context.reviewTestCorrection = async input => {
      reviewed.push(input.beforeContent);
      expect(input.afterContent).toBe("corrected fixture");
      expect(input.testCases[0]?.status).toBe("passed");
      return { confirmed: true, note: "Original fixture, not an intermediate edit, was reviewed." };
    };
    await f.write("original failed fixture"); await f.execute();
    await f.write("intermediate edit");
    await f.write("corrected fixture", [{ failureId: testEvidence(f.context).failures[0]!.id, reason: "Wrong fixture", requirementEvidence: "Reject invalid input." }]);
    expect(reviewed).toEqual([]);
    expect(hasUnresolvedTestFailures(testEvidence(f.context))).toBe(true);
    await f.execute();
    expect(reviewed).toEqual(["original failed fixture"]);
    expect((await f.finish()).translationStatus).toBe("success");
  });

  it("resolves a renamed replacement in a fresh harness only with explicit review and a passing Host identity", async () => {
    const f = await fixture([run("failed"), run("passed", "Suite#correctedRejectionScenario")]);
    await f.write("original failing scenario"); await f.execute();
    const failure = testEvidence(f.context).failures[0]!;
    f.context.runtime.functionGroup!.testEvidence = structuredClone(testEvidence(f.context));
    f.context.state = {};
    f.context.runtime.testRoots = ["fresh-tests"];
    f.context.reviewTestCorrection = async input => {
      expect(input.beforeContent).toBe("original failing scenario");
      return { confirmed: true, note: "The renamed case retains the invalid-input scenario and assertion.", replacementTestIds: ["Suite#correctedRejectionScenario"] };
    };
    const writer = createWriteTargetTestTool()(f.context), runner = createRunFunctionGroupTestsTool()(f.context);
    await writer.execute({ path: "fresh-tests/renamed.test.ts", content: "same scenario with corrected fixture", corrections: [{ failureId: failure.id, reason: "Wrong fixture", requirementEvidence: "Reject invalid input." }] });
    await runner.execute({ paths: ["fresh-tests/renamed.test.ts"] });
    expect(hasUnresolvedTestFailures(testEvidence(f.context))).toBe(false);
    expect(testEvidence(f.context).failures[0]?.resolution).toMatchObject({ kind: "reviewed-test-correction", replacementTestIds: ["Suite#correctedRejectionScenario"] });
  });

  it.each(["missing", "skipped"])("does not close a failure when a review references a %s replacement", async status => {
    const passing = run("passed", "Suite#otherCase");
    if (status === "skipped") passing.testCases!.push({ id: "Suite#replacement", status: "skipped" });
    const f = await fixture([run("failed"), passing]);
    f.context.reviewTestCorrection = async () => ({ confirmed: true, note: "Proposed replacement.", replacementTestIds: ["Suite#replacement"] });
    await f.write("original"); await f.execute();
    await f.write("replacement", [{ failureId: testEvidence(f.context).failures[0]!.id, reason: "Wrong fixture", requirementEvidence: "Reject invalid input." }]);
    await f.execute();
    expect((await f.finish()).translationStatus).toBe("failure");
    expect(testEvidence(f.context).revisions.at(-1)?.corrections?.[0].reviewNote).toContain("No approved replacement case actually passed");
  });

  it("retains a valid requirement failure when the independent review rejects a weakened assertion", async () => {
    const f = await fixture([run("failed"), run("passed")]);
    f.context.reviewTestCorrection = async () => ({ confirmed: false, note: "Accepting invalid inputs contradicts the requirement.", replacementTestIds: [] });
    await f.write("assertRejectsInvalidInput();"); await f.execute();
    await f.write("assertAcceptsInvalidInput();", [{ failureId: testEvidence(f.context).failures[0]!.id, reason: "Implementation accepts it", requirementEvidence: "Reject invalid input." }]);
    await f.execute();
    expect((await f.finish()).translationStatus).toBe("failure");
    expect(testEvidence(f.context).revisions.at(-1)?.corrections?.[0].status).toBe("unconfirmed");
  });

  it("uses the default Host reviewer in an isolated conversation and closes a corrected failure through the verifier entry point", async () => {
    const f = await fixture([run("failed"), run("passed")]);
    let step = 0, reviews = 0;
    const host = createAgentHost({ resolveToolContext: async () => f.context.runtime, modelClient: { complete: async (messages, tools, signal) => {
      expect(signal?.aborted).toBe(false);
      if (!tools.length) {
        reviews++;
        expect(messages.map(item => item.role)).toEqual(["system", "user"]);
        const evidence = JSON.parse(messages[1]!.content);
        expect(evidence.originalFailingTest).toBe("assertCount(3);");
        expect(evidence.executedCurrentTest).toBe("assertCount(2);");
        expect(evidence.observedTestCases[0].status).toBe("passed");
        return { content: JSON.stringify({ confirmed: true, note: "The fixture has two accepted records; the same meaningful count assertion remains.", replacementTestIds: ["Suite#rejectsInvalidInput"] }) };
      }
      const call = (name: string, args: unknown) => ({ toolCalls: [{ id: `call-${step}`, name, arguments: JSON.stringify(args) }] });
      switch (step++) {
        case 0: return call("write_target_test", { path: "tests/thing.test.ts", content: "assertCount(3);" });
        case 1: return call("run_function_group_tests", { paths: ["tests/thing.test.ts"] });
        case 2: {
          const observed = JSON.parse(messages.findLast(item => item.role === "tool")!.content);
          return call("write_target_test", { path: "tests/thing.test.ts", content: "assertCount(2);", corrections: [{ failureId: observed.testEvidence.unresolvedFailures[0].id, reason: "The fixture contains two accepted records.", requirementEvidence: "Return the count of accepted records." }] });
        }
        case 3: return call("run_function_group_tests", { paths: ["tests/thing.test.ts"] });
        default: return call("finish_function_group", { testExecutionStatus: "success", translationStatus: "success" });
      }
    } } });
    // Exercise real Host write/run/finish tools while controlling only the test process observations.
    const entry = createRequirementFunctionGroupTask(f.group);
    const result = await createFunctionGroupVerifier({ run: () => host.run({ ...entry, tools: entry.tools.map(factory => context => {
      context.functionGroupRunner = f.context.functionGroupRunner;
      return factory(context);
    }) }) as any })(f.group, "requirement-function-group", "verify");
    expect(result.status).toBe("success");
    expect(result.testEvidence?.failures[0]?.status).toBe("resolved");
    expect(reviews).toBe(1);
    expect(step).toBe(5);
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
