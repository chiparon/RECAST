import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { VerificationTestCase, VerificationTestCorrection, VerificationTestEvidence, VerificationTestVersion } from "../types.js";
import { readProjectFile, type FunctionGroupTestRun, type ToolContext } from "./tools/common.js";

export type TestCorrectionReviewer = (input: {
  failure: VerificationTestEvidence["failures"][number];
  correction: VerificationTestCorrection;
  requirement: string;
  beforeContent: string;
  afterContent: string;
  testCases: VerificationTestCase[];
}) => Promise<{ confirmed: boolean; note: string; replacementTestIds?: string[] }>;

function originalTestVersion(failure: VerificationTestEvidence["failures"][number], path: string): VerificationTestVersion | undefined {
  const exact = failure.versions.find(version => version.path === path);
  if (exact) return exact;
  // A fresh Host harness has a different root. A single original test file is
  // also unambiguous when its replacement is renamed; review still compares
  // the immutable failing content with the executed replacement.
  if (failure.versions.length === 1) return failure.versions[0];
  const matches = failure.versions.filter(version => basename(version.path) === basename(path));
  return matches.length === 1 ? matches[0] : undefined;
}

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
  const evidence = testEvidence(context);
  const requirement = context.runtime.functionGroup?.requirement ?? "";
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  // Reject bad references before changing the file. The Agent can retry using
  // the real Host identity rather than orphaning the original failing version.
  for (const correction of corrections ?? []) {
    const failure = evidence.failures.find(item => item.id === correction.failureId && item.status === "unresolved");
    if (!failure) throw new Error(`Unknown unresolved failureId ${correction.failureId}. Copy an exact Host id from: ${JSON.stringify(evidence.failures.filter(item => item.status === "unresolved").map(item => ({ id: item.id, testId: item.testId })))}`);
    if (!normalize(correction.requirementEvidence) || !normalize(requirement).includes(normalize(correction.requirementEvidence))) {
      throw new Error(`Correction for ${failure.id} requires an exact public requirement excerpt in requirementEvidence.`);
    }
    if (!originalTestVersion(failure, path)) throw new Error(`Cannot identify the original failing test file for ${failure.id}; update its original path.`);
  }
  let before: VerificationTestVersion | undefined;
  try { before = await snapshotTest(context, path); }
  catch (error) {
    // readProjectFile reports ENOENT as a descriptive Error.
    if (!(error instanceof Error && error.message === `File does not exist: ${path}`)) throw error;
  }
  const after = await snapshotTest(context, path, content);
  const revision: VerificationTestEvidence["revisions"][number] = {
    path, ...(before ? { before } : {}), after,
    ...(corrections ? { corrections: corrections.map(item => ({ ...item, status: "proposed" as const })) } : {}),
  };
  evidence.revisions.push(revision);
}

export async function recordTestRun(context: ToolContext, run: FunctionGroupTestRun, versions: VerificationTestVersion[]): Promise<void> {
  const evidence = testEvidence(context);
  const id = randomUUID();
  const testCases = (run.testCases ?? []).map(item => ({ ...item, ...(item.message ? { message: item.message.slice(0, 8000) } : {}) }));
  evidence.runs.push({ id, status: run.status, tests: { ...run.tests }, testCases, versions, revisionCount: evidence.revisions.length });
  // Retain this run's failures before any review request can fail or time out.
  const failed = testCases.filter(item => item.status === "failed");
  for (const test of failed) {
    evidence.failures.push({ id: randomUUID(), runId: id, testId: test.id,
      message: test.message ?? "Host reported a failed test case.", versions, status: "unresolved" });
  }
  // Green aggregate counts cannot discharge failures lacking a reliable identity.
  if (run.tests.failed > failed.length) {
    evidence.failures.push({ id: randomUUID(), runId: id, testId: `unidentified:${id}`,
      message: `${run.tests.failed - failed.length} executed test failure(s) had no reliable case identity.`, versions, status: "unresolved" });
  }
  // A missing or skipped case cannot discharge an earlier observed failure.
  for (const failure of evidence.failures.filter(item => item.status === "unresolved")) {
    if (!testCases.some(item => item.status === "passed") || testCases.some(item => item.id === failure.testId && item.status === "failed")) continue;
    const sameCasePassed = testCases.some(item => item.id === failure.testId && item.status === "passed");
    const failedRun = evidence.runs.find(item => item.id === failure.runId);
    const revision = evidence.revisions.findLast(item => versions.some(version => version.sha256 === item.after.sha256) &&
      item.corrections?.some(correction => correction.failureId === failure.id));
    // Changing an imported helper can weaken an unchanged assertion too. Such
    // changes remain visible in revisions, and cannot be resolved from the main
    // test's unchanged hash or a review of that file alone.
    if (failedRun?.revisionCount === undefined) continue;
    const changedAuxiliary = evidence.revisions.slice(failedRun.revisionCount).filter(item =>
      !failure.versions.some(version => version.path === item.path || version.sha256 === item.after.sha256) && item.before?.sha256 !== item.after.sha256);
    if (!changedAuxiliary.length && sameCasePassed && failure.versions.length > 0 && failure.versions.every(old => versions.some(next => next.sha256 === old.sha256))) {
      failure.status = "resolved";
      failure.resolution = { kind: "unchanged-test-replayed", runId: id, reason: "The same case passed with every original failing test file unchanged." };
      continue;
    }
    const correction = revision?.corrections?.find(item => item.failureId === failure.id);
    const original = revision && originalTestVersion(failure, revision.path);
    // Other test files used in the failing run must also remain unchanged.
    if (!correction || !revision || !original || !failure.versions.every(old => old.sha256 === original.sha256 || versions.some(next => next.sha256 === old.sha256))) continue;
    if (changedAuxiliary.some(item => item.path !== revision.path)) continue;
    const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
    if (!normalize(correction.requirementEvidence) || !normalize(context.runtime.functionGroup?.requirement ?? "").includes(normalize(correction.requirementEvidence))) continue;
    if (correction.status !== "confirmed" && context.reviewTestCorrection) {
      try {
        const review = await context.reviewTestCorrection({
          failure: structuredClone(failure), correction: { ...correction }, requirement: context.runtime.functionGroup?.requirement ?? "",
          beforeContent: await readFile(join(context.runtime.targetProjectPath, original.artifactPath), "utf8"),
          afterContent: await readFile(join(context.runtime.targetProjectPath, revision.after.artifactPath), "utf8"),
          testCases: structuredClone(testCases),
        });
        const replacements = review.replacementTestIds;
        const witnessed = replacements === undefined ? sameCasePassed : replacements.length > 0 && replacements.every(testId =>
          testCases.some(item => item.id === testId && item.status === "passed") && !testCases.some(item => item.id === testId && item.status !== "passed"));
        correction.status = review.confirmed && Boolean(review.note.trim()) && witnessed ? "confirmed" : "unconfirmed";
        correction.reviewNote = (witnessed ? review.note : `${review.note} No approved replacement case actually passed.`).slice(0, 4000);
        if (correction.status === "confirmed" && replacements) correction.replacementTestIds = [...new Set(replacements)];
      } catch (error) {
        context.budget?.assertActive();
        correction.status = "unconfirmed";
        correction.reviewNote = `Correction review unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000);
      }
    }
    const approvedIds = correction.replacementTestIds ?? [failure.testId];
    if (correction.status === "confirmed" && approvedIds.length > 0 && approvedIds.every(testId =>
      testCases.some(item => item.id === testId && item.status === "passed") && !testCases.some(item => item.id === testId && item.status !== "passed"))) {
      failure.status = "resolved";
      failure.resolution = { kind: "reviewed-test-correction", runId: id, reason: correction.reason,
        requirementEvidence: correction.requirementEvidence, reviewNote: correction.reviewNote,
        ...(correction.replacementTestIds ? { replacementTestIds: [...correction.replacementTestIds] } : {}) };
    }
  }
  run.testEvidence = structuredClone(evidence);
}

export function hasUnresolvedTestFailures(evidence?: VerificationTestEvidence): boolean {
  return evidence?.failures.some(item => item.status === "unresolved") ?? false;
}
