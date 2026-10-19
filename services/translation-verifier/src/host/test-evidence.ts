import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { VerificationTestCorrection, VerificationTestEvidence, VerificationTestVersion } from "../types.js";
import { readProjectFile, type FunctionGroupTestRun, type ToolContext } from "./tools/common.js";

export type TestCorrectionReviewer = (input: {
  failure: VerificationTestEvidence["failures"][number];
  correction: VerificationTestCorrection;
  requirement: string;
  beforeContent: string;
  afterContent: string;
}) => Promise<{ confirmed: boolean; note: string }>;

export function testEvidence(context: ToolContext): VerificationTestEvidence {
  return context.state.testEvidence ??= structuredClone(
    context.runtime.functionGroup?.testEvidence ?? { runs: [], failures: [], revisions: [] },
  );
}

/** Agent writes cannot address this directory; harness cleanup does not remove it. */
export async function snapshotTest(context: ToolContext, path: string, content?: string): Promise<VerificationTestVersion> {
  const text = content ?? await readProjectFile(context.runtime.targetProjectPath, path);
  const sha256 = createHash("sha256").update(text).digest("hex");
  const artifactPath = `.forexplore/translation-verifier-evidence/${sha256}.txt`;
  const absolute = join(context.runtime.targetProjectPath, artifactPath);
  await mkdir(dirname(absolute), { recursive: true });
  try { await writeFile(absolute, text, { encoding: "utf8", flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return { path, sha256, artifactPath };
}

export async function recordTestRevision(context: ToolContext, path: string, content: string,
  corrections?: VerificationTestCorrection[]): Promise<void> {
  let before: VerificationTestVersion | undefined;
  try { before = await snapshotTest(context, path); }
  catch (error) {
    // readProjectFile reports ENOENT as a descriptive Error.
    if (!(error instanceof Error && error.message === `File does not exist: ${path}`)) throw error;
  }
  const after = await snapshotTest(context, path, content);
  const evidence = testEvidence(context);
  const revision: VerificationTestEvidence["revisions"][number] = {
    path, ...(before ? { before } : {}), after,
    ...(corrections ? { corrections: corrections.map(item => ({ ...item, status: "proposed" as const })) } : {}),
  };
  const requirement = context.runtime.functionGroup?.requirement ?? "";
  for (const correction of revision.corrections ?? []) {
    const failure = evidence.failures.find(item => item.id === correction.failureId && item.status === "unresolved");
    const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
    if (!failure || !before || !failure.versions.some(item => item.sha256 === before.sha256) ||
      !normalize(requirement).includes(normalize(correction.requirementEvidence))) {
      correction.status = "unconfirmed";
      correction.reviewNote = "Correction must reference an observed failure, its unchanged failing version, and an excerpt from the public requirement.";
      continue;
    }
    if (!context.reviewTestCorrection) continue;
    try {
      const review = await context.reviewTestCorrection({
        failure: structuredClone(failure), correction: { ...correction }, requirement,
        beforeContent: await readFile(join(context.runtime.targetProjectPath, before.artifactPath), "utf8"),
        afterContent: content,
      });
      correction.status = review.confirmed && Boolean(review.note.trim()) ? "confirmed" : "unconfirmed";
      correction.reviewNote = review.note.slice(0, 4000);
    } catch (error) {
      correction.status = "unconfirmed";
      correction.reviewNote = `Correction review unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000);
    }
  }
  evidence.revisions.push(revision);
}

export function recordTestRun(context: ToolContext, run: FunctionGroupTestRun, versions: VerificationTestVersion[]): void {
  const evidence = testEvidence(context);
  const id = randomUUID();
  const testCases = (run.testCases ?? []).map(item => ({ ...item, ...(item.message ? { message: item.message.slice(0, 8000) } : {}) }));
  evidence.runs.push({ id, status: run.status, tests: { ...run.tests }, testCases, versions, revisionCount: evidence.revisions.length });
  // A missing or skipped case cannot discharge an earlier observed failure.
  for (const failure of evidence.failures.filter(item => item.status === "unresolved")) {
    if (!testCases.some(item => item.id === failure.testId && item.status === "passed") ||
      testCases.some(item => item.id === failure.testId && item.status === "failed")) continue;
    const failedRun = evidence.runs.find(item => item.id === failure.runId);
    // Changing an imported helper can weaken an unchanged assertion too. Such
    // changes remain visible in revisions, and cannot be resolved from the main
    // test's unchanged hash or a review of that file alone.
    const auxiliaryChanged = failedRun?.revisionCount === undefined ||
      evidence.revisions.slice(failedRun.revisionCount).some(item =>
        !failure.versions.some(version => version.path === item.path || version.sha256 === item.after.sha256) && item.before?.sha256 !== item.after.sha256);
    if (auxiliaryChanged) continue;
    if (failure.versions.length > 0 && failure.versions.every(old => versions.some(next => next.sha256 === old.sha256))) {
      failure.status = "resolved";
      failure.resolution = { kind: "unchanged-test-replayed", runId: id, reason: "The same case passed with every original failing test file unchanged." };
      continue;
    }
    const revision = evidence.revisions.findLast(item => versions.some(version => version.sha256 === item.after.sha256) &&
      item.corrections?.some(correction => correction.failureId === failure.id && correction.status === "confirmed"));
    const correction = revision?.corrections?.find(item => item.failureId === failure.id && item.status === "confirmed");
    // Other test files used in the failing run must also remain unchanged.
    if (correction && revision?.before && failure.versions.every(old => old.sha256 === revision.before!.sha256 || versions.some(next => next.sha256 === old.sha256))) {
      failure.status = "resolved";
      failure.resolution = { kind: "reviewed-test-correction", runId: id, reason: correction.reason,
        requirementEvidence: correction.requirementEvidence, reviewNote: correction.reviewNote };
    }
  }
  const failed = testCases.filter(item => item.status === "failed");
  for (const test of failed) {
    evidence.failures.push({ id: randomUUID(), runId: id, testId: test.id,
      message: test.message ?? "Host reported a failed test case.", versions, status: "unresolved" });
  }
  // Execution failures without reliable case identities remain explicit; green counters alone cannot resolve them.
  if (run.tests.failed > failed.length) {
    evidence.failures.push({ id: randomUUID(), runId: id, testId: `unidentified:${id}`,
      message: `${run.tests.failed - failed.length} executed test failure(s) had no reliable case identity.`, versions, status: "unresolved" });
  }
  run.testEvidence = structuredClone(evidence);
}

export function hasUnresolvedTestFailures(evidence?: VerificationTestEvidence): boolean {
  return evidence?.failures.some(item => item.status === "unresolved") ?? false;
}
