import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { access, mkdir, readdir, readFile, writeFile, realpath, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { parseJacocoReport, parseSurefireReport, parseCobertura, parseIstanbul, parseJUnit, parseNodeTests, parsePythonCoverage, parseTrx, parseJUnitTestCases, parseNodeTestCases, parseTrxTestCases, jsonReport, type PythonFunction } from "./coverage-reports.js";
import { MAX_TEST_OUTPUT_CHARS, readProjectFile, resolveSafePath, type FunctionGroupTestRun, type FunctionGroupTestRunner, type ToolContext, type TargetTestResult, type TargetCoverageResult, type TestSummary } from "./tools/common.js";
import type { TargetFunctionCoverage, VerificationFunction, VerificationReason, VerificationTestCase } from "../types.js";

const JACOCO = "org.jacoco:jacoco-maven-plugin:0.8.13";
export const MAVEN_COVERAGE_GOALS = [`${JACOCO}:prepare-agent`, "test", `${JACOCO}:report`] as const;
const MAVEN_REPORT_PATH = "target/site/jacoco/jacoco.xml";
const MAVEN_TEST_REPORTS = "target/surefire-reports";
const LEGACY_MAVEN_COVERAGE = "target/translation-verifier-coverage";
type CoverageRun = {
  dataDirectory: string;
  args: string[];
  env?: Record<string, string>;
  pythonFunctions?: Array<{ path: string; functions: PythonFunction[] }>;
  surefireReportsDirectory?: string;
  jacocoReportPath?: string;
};
type RunnerContext = Omit<ToolContext, "runner" | "state">;
export type BoundTestRunner = {
  run(testPath: string): Promise<TargetTestResult>;
};

/** Bind the command and framework capabilities before exposing tools to the Agent. */
export function bindTestRunner(context: RunnerContext): BoundTestRunner {
  const boundContext: RunnerContext = {
    budget: context.budget,
    runtime: {
      ...context.runtime,
      targetFunction: { ...context.runtime.targetFunction },
      targetTest: { ...context.runtime.targetTest, args: [...context.runtime.targetTest.args] },
    },
  };
  return { run: (testPath) => runTests(boundContext, testPath) };
}

/** Bind the same Host-controlled runner to every target function in a group. */
export function bindFunctionGroupTestRunner(context: RunnerContext): FunctionGroupTestRunner {
  const functions = context.runtime.functionGroup?.functions ?? [];
  return {
    run: async (testPaths) => {
      if (functions.length === 0) throw new Error("Function-group verification requires at least one target function.");
      if (testPaths.length === 0) throw new Error("Function-group verification requires at least one test path.");
      const targetContext: RunnerContext = {
        ...context,
        runtime: {
          ...context.runtime,
          targetFunction: { ...functions[0]!.target },
        },
      };
      const result = await runTestsForSubjects(
        targetContext,
        [...testPaths],
        functions.map((mapping) => mapping.target),
      );
      const functionsResult = functions.map((mapping, index) => {
        const coverage = result.coverage[index];
        const executed = coverage?.status === "available" && coverage.targetFunction.executed;
        const reason: VerificationReason = result.status === "failure"
          ? "test-failed"
          : coverage?.status !== "available"
            ? "coverage-unavailable"
            : executed ? "verified" : "not-executed";
        const source = ("source" in mapping ? mapping.source : undefined) as VerificationFunction | undefined;
        return {
          ...(source ? { source: { ...source } } : {}),
          target: { ...mapping.target },
          status: executed && result.status === "success" && (result.tests?.executed ?? 0) > 0 ? "passed" as const : "unverified" as const,
          executed,
          lineCoverage: coverage?.status === "available" ? coverage.targetFunction.lineCoverage : null,
          branchCoverage: coverage?.status === "available" ? coverage.targetFunction.branchCoverage : null,
          reason,
          ...(coverage?.status === "unavailable" ? { coverageIssue: coverage.reason } : {}),
        };
      });
      return {
        status: result.status,
        testPaths: [...testPaths],
        tests: result.tests ?? { executed: 0, passed: 0, failed: 0, skipped: 0 },
        testCases: result.testCases,
        functions: functionsResult,
        failures: result.failures,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        reason: result.status === "failure" ? "test-failed" : functionsResult.some((item) => item.reason === "coverage-unavailable") ? "coverage-unavailable" : functionsResult.some((item) => item.reason === "not-executed") ? "not-executed" : "verified",
      } satisfies FunctionGroupTestRun;
    },
  };
}

async function runTests(context: RunnerContext, testPath: string): Promise<TargetTestResult> {
  context.budget?.assertActive();
  const coverageRun = await prepareCoverage(context, [testPath], [context.runtime.targetFunction]);
  try {
    const { executable } = context.runtime.targetTest;
    const args = [...context.runtime.targetTest.args, ...coverageRun.args];
    const timeoutMs = Math.min(
      context.runtime.targetTest.timeoutMs ?? 300_000,
      context.budget?.remainingMs() ?? Number.POSITIVE_INFINITY,
    );
    if (
      !executable ||
      executable.includes("\0") ||
      args.some((arg) => arg.includes("\0")) ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0
    ) {
      throw new Error("Host target test command is invalid.");
    }

    const startedAt = Date.now();
    const result = await new Promise<{
      exitCode: number | null;
      signal?: string;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    }>((resolve) => {
      const child = spawn(executable, args, {
        cwd: context.runtime.targetProjectPath,
        shell: false,
        env: { ...process.env, ...coverageRun.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const append = (current: string, chunk: Buffer | string): string => {
        const next = current + chunk.toString();
        return next.length <= MAX_TEST_OUTPUT_CHARS
          ? next
          : next.slice(0, MAX_TEST_OUTPUT_CHARS);
      };
      const finish = (value: { exitCode: number | null; signal?: string }) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve({ ...value, stdout, stderr, timedOut });
      };

      child.stdout?.on("data", (chunk) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr = append(stderr, chunk);
      });
      child.once("error", (error) => {
        stderr = append(stderr, error.message);
        finish({ exitCode: null });
      });
      child.once("close", (exitCode, signal) => {
        finish({ exitCode, signal: signal ?? undefined });
      });
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
    });

    const evidence = await collectCoverage(context, coverageRun, [context.runtime.targetFunction]);

    const targetCoverage = evidence.coverage[0] ?? { status: "unavailable" as const, reason: "No target coverage was produced." };
    return {
      ...evidence,
      coverage: targetCoverage,
      status: result.timedOut || result.exitCode !== 0 || ("tests" in evidence && (evidence.tests?.failed ?? 0) > 0) ? "failure" : "success",
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      ...(result.signal ? { signal: result.signal } : {}),
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await rm(coverageRun.dataDirectory, { recursive: true, force: true });
  }
}

async function runTestsForSubjects(
  context: RunnerContext,
  testPaths: readonly string[],
  subjects: readonly VerificationFunction[],
): Promise<{
  status: "success" | "failure";
  timedOut: boolean;
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  tests?: TestSummary;
  testCases?: VerificationTestCase[];
  coverage: TargetCoverageResult[];
  failures: Array<{ message: string; testPath?: string; suspectedFunctions: VerificationFunction[] }>;
}> {
  context.budget?.assertActive();
  const coverageRun = await prepareCoverage(context, testPaths, subjects);
  try {
    const { executable } = context.runtime.targetTest;
    const args = [...context.runtime.targetTest.args, ...coverageRun.args];
    const timeoutMs = Math.min(context.runtime.targetTest.timeoutMs ?? 300_000, context.budget?.remainingMs() ?? Number.POSITIVE_INFINITY);
    if (!executable || executable.includes("\0") || args.some((arg) => arg.includes("\0")) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Host target test command is invalid.");
    }
    const startedAt = Date.now();
    const processResult = await new Promise<{ exitCode: number | null; signal?: string; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
      const child = spawn(executable, args, { cwd: context.runtime.targetProjectPath, shell: false, env: { ...process.env, ...coverageRun.env }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", timedOut = false, settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const append = (current: string, chunk: Buffer | string) => {
        const next = current + chunk.toString();
        return next.length <= MAX_TEST_OUTPUT_CHARS ? next : next.slice(0, MAX_TEST_OUTPUT_CHARS);
      };
      const finish = (value: { exitCode: number | null; signal?: string }) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve({ ...value, stdout, stderr, timedOut });
      };
      child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
      child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
      child.once("error", (error) => { stderr = append(stderr, error.message); finish({ exitCode: null }); });
      child.once("close", (exitCode, signal) => { finish({ exitCode, signal: signal ?? undefined }); });
      timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    });
    const evidence = await collectCoverage(context, coverageRun, subjects);
    const status = processResult.timedOut || processResult.exitCode !== 0 || (evidence.tests?.failed ?? 0) > 0 ? "failure" as const : "success" as const;
    const failures = status === "failure" ? [{
      message: [processResult.stderr, processResult.stdout].filter(Boolean).join("\n") || "Target tests failed.",
      ...(testPaths.length === 1 ? { testPath: testPaths[0] } : {}),
      suspectedFunctions: subjects.filter((_, index) => evidence.coverage[index]?.status === "available" && evidence.coverage[index]!.targetFunction.executed).map((subject) => ({ ...subject })),
    }] : [];
    return {
      status,
      timedOut: processResult.timedOut,
      exitCode: processResult.exitCode,
      ...(processResult.signal ? { signal: processResult.signal } : {}),
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      durationMs: Date.now() - startedAt,
      ...(evidence.tests ? { tests: evidence.tests } : {}),
      testCases: evidence.testCases,
      coverage: evidence.coverage,
      failures,
    };
  } finally {
    await rm(coverageRun.dataDirectory, { recursive: true, force: true });
  }
}

const runFile = promisify(execFile);
const PYTHON_FUNCTIONS = `import ast,json,sys
source=open(sys.argv[1],encoding='utf-8').read()
tree=ast.parse(source)
result=[]
def visit(node,prefix=''):
 for child in ast.iter_child_nodes(node):
  if isinstance(child,(ast.FunctionDef,ast.AsyncFunctionDef)):
   name=prefix+child.name
   nested=[{'start':n.lineno,'end':n.end_lineno} for n in ast.walk(child) if n is not child and isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef))]
   result.append({'name':name,'start':child.lineno,'end':child.end_lineno,'bodyStart':child.body[0].lineno,'nested':nested})
   visit(child,name+'.')
  elif isinstance(child,ast.ClassDef):
   visit(child,prefix+child.name+'.')
  else:
   visit(child,prefix)
visit(tree)
print(json.dumps(result))
`;

async function prepareCoverage(context: RunnerContext, testPaths: readonly string[], subjects: readonly VerificationFunction[]): Promise<CoverageRun> {
  const { targetProjectPath: root, testRunner: runner } = context.runtime;
  const directory = runner === "maven" ? ".forexpore/translation-verifier-coverage" : ".translation-verifier-coverage";
  const dataDirectory = resolveSafePath(root, `${directory}/${randomUUID()}`);
  await mkdir(dataDirectory, { recursive: true });
  try {
    if (runner === "maven") {
      // New Maven runs write only to the Host-owned .forexpore directory. An
      // old report must not be mistaken for evidence if a project still has
      // the default output directories from a prior invocation.
      await Promise.all([
        rm(resolveSafePath(root, MAVEN_REPORT_PATH), { force: true }).catch(() => undefined),
        rm(resolveSafePath(root, MAVEN_TEST_REPORTS), { recursive: true, force: true }).catch(() => undefined),
        // Keep the legacy parent available for older integrations that inspect
        // its emptiness; failure here is harmless on a root-owned target.
        mkdir(resolveSafePath(root, LEGACY_MAVEN_COVERAGE), { recursive: true }).catch(() => undefined),
      ]);
    }
    return await configureRunnerCoverage(context, testPaths, subjects, dataDirectory);
  } catch (error) {
    await rm(dataDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function configureRunnerCoverage(context: RunnerContext, testPaths: readonly string[], subjects: readonly VerificationFunction[], dataDirectory: string): Promise<CoverageRun> {
  const { targetProjectPath: root, testRunner: runner } = context.runtime;
  const testPath = testPaths[0];
  if (!testPath) throw new Error("At least one test path is required.");
  // Unit fixtures may inject a direct Node process as a deterministic timeout
  // command. It is not a Jest/Vitest executable, so appending coverage flags
  // would make the process exit immediately and hide the timeout behavior.
  if (context.runtime.targetTest.executable === process.execPath && context.runtime.targetTest.args[0] === "-e") {
    return { dataDirectory, args: [] };
  }
  if (runner === "maven") {
    if (!/\.(?:java|kt)$/i.test(testPath)) throw new Error(`Java test selector requires a .java or .kt file: ${testPath}`);
    const classNames = testPaths.map((path) => path.slice(path.lastIndexOf("/") + 1).replace(/\.(?:java|kt)$/i, ""));
    const dataFile = join(dataDirectory, "jacoco.exec");
    return { dataDirectory, args: [
      `-Djacoco.destFile=${dataFile}`, `-Djacoco.dataFile=${dataFile}`,
      `-Dproject.build.directory=${join(dataDirectory, "maven-build")}`,
      `-Dproject.reporting.outputDirectory=${join(dataDirectory, "maven-reporting")}`,
      `-Dsurefire.reportsDirectory=${join(dataDirectory, "surefire-reports")}`,
      `-Djacoco.outputDirectory=${join(dataDirectory, "jacoco")}`,
      "-Djacoco.append=false", "-DfailIfNoTests=true", `-Dtest=${classNames.join(",")}`,
    ],
      surefireReportsDirectory: `${relative(root, dataDirectory).replaceAll("\\", "/")}/surefire-reports`,
      jacocoReportPath: `${relative(root, dataDirectory).replaceAll("\\", "/")}/jacoco/jacoco.xml`,
    };
  }
  const tests = join(dataDirectory, "tests.json");
  if (runner === "jest") return { dataDirectory, args: ["--runTestsByPath", ...testPaths, `--roots=${await realpath(root)}`, "--coverage", ...subjects.map((subject) => `--collectCoverageFrom=${subject.path}`), "--coverageReporters=json", `--coverageDirectory=${dataDirectory}`, "--json", `--outputFile=${tests}`] };
  if (runner === "vitest") return { dataDirectory, args: ["--run", ...testPaths, "--coverage", `--coverage.include=${subjects.map((subject) => subject.path).join(",")}`, "--coverage.reporter=json", `--coverage.reportsDirectory=${dataDirectory}`, "--reporter=json", `--outputFile=${tests}`] };
  if (runner === "pytest") {
    const pythonFunctions: Array<{ path: string; functions: PythonFunction[] }> = [];
    for (const subject of subjects) {
      const { stdout } = await runFile(context.runtime.targetTest.executable, ["-c", PYTHON_FUNCTIONS, resolveSafePath(root, subject.path)], { cwd: root, timeout: Math.min(10_000, context.budget?.remainingMs() ?? 10_000), maxBuffer: 1_000_000 });
      pythonFunctions.push({ path: subject.path, functions: jsonReport(stdout) });
    }
    return { dataDirectory, pythonFunctions, env: { COVERAGE_FILE: join(dataDirectory, ".coverage") },
      args: [...testPaths, `--cov=${root}`, "--cov-branch", `--cov-report=json:${join(dataDirectory, "coverage.json")}`, `--junitxml=${join(dataDirectory, "tests.xml")}`] };
  }
  if (runner === "gradle") {
    const script = join(dataDirectory, "coverage.gradle");
    const quoted = (path: string) => JSON.stringify(path);
    await writeFile(script, `allprojects { p ->
  p.afterEvaluate {
    if (p == rootProject && p.plugins.hasPlugin('java')) {
      p.apply plugin: 'jacoco'
      p.jacoco.toolVersion = '0.8.13'
      p.tasks.named('test') {
        jacoco.destinationFile = p.file(${quoted(join(dataDirectory, "jacoco.exec"))})
        reports.junitXml.outputLocation.set(p.file(${quoted(join(dataDirectory, "tests"))}))
      }
      p.tasks.named('jacocoTestReport') {
        executionData.setFrom(p.file(${quoted(join(dataDirectory, "jacoco.exec"))}))
        reports.xml.required.set(true)
        reports.xml.outputLocation.set(p.file(${quoted(join(dataDirectory, "jacoco.xml"))}))
        reports.html.required.set(false)
        reports.csv.required.set(false)
      }
    }
  }
}
`);
    if (!/\.(java|kt)$/.test(testPath)) throw new Error("Gradle selector requires a Java/Kotlin test file.");
    const names = testPaths.map((path) => path.split("/").pop()!.replace(/\.(java|kt)$/, ""));
    return { dataDirectory, args: names.flatMap((name) => ["--tests", `*.${name}`]).concat(["jacocoTestReport", "--init-script", script, "--rerun-tasks", "--no-build-cache"]) };
  }
  if (runner === "dotnet") {
    const projects = context.runtime.targetTest.args.filter(arg => arg.endsWith(".csproj"));
    if (projects.length !== 1 || testPaths.some((path) => !path.startsWith(`${projects[0].slice(0, projects[0].lastIndexOf("/"))}/`))) throw new Error("C# test file does not belong to the bound test project.");
    const classNames: string[] = [];
    for (const path of testPaths) {
      const source = await readProjectFile(root, path);
      const namespaces = [...source.matchAll(/\bnamespace\s+([\w.]+)/g)];
      const classes = [...source.matchAll(/\bclass\s+(\w+)/g)];
      if (classes.length === 0 || namespaces.length > 1) throw new Error("C# test selector requires a test class and at most one namespace.");
      // Test files commonly contain nested mocks or fixture classes. They
      // belong to the authorized file too and must not block test execution.
      for (const item of classes) classNames.push([namespaces[0]?.[1], item[1]].filter(Boolean).join("."));
    }
    // VSTest's FullyQualifiedName filter already performs a substring match.
    // Appending a literal trailing dot rejects valid classes when the Agent
    // omits a namespace (and made a repair loop report "no test matches" even
    // though the generated xUnit file compiled). Match the class identity
    // directly; the Host still binds the exact test paths and owns the runner.
    return { dataDirectory, args: ["--filter", classNames.map((name) => `FullyQualifiedName~${name}`).join("|"), "--collect:XPlat Code Coverage", "--results-directory", dataDirectory, "--logger", "trx;LogFileName=tests.trx"] };
  }
  throw new Error(`Unsupported coverage runner: ${runner}`);
}

async function report(path: string): Promise<string> {
  const bytes = await readFile(path);
  if (bytes.length > 16_000_000) throw new Error("Report exceeds the size limit.");
  return bytes.toString("utf8");
}
async function collectCoverage(context: RunnerContext, run: CoverageRun, subjects: readonly VerificationFunction[]): Promise<{ tests?: TestSummary; testCases: VerificationTestCase[]; coverage: TargetCoverageResult[] }> {
  let tests: TestSummary | undefined;
  const testCases: VerificationTestCase[] = [];
  const { testRunner: runner, targetProjectPath: root } = context.runtime;
  const canonicalRoot = await realpath(root);
  const reportDirectory = relative(canonicalRoot, run.dataDirectory);
  const read = (path: string) => report(resolveSafePath(root, `${reportDirectory}/${path}`));
  const parseSubjects = async (parse: (subject: VerificationFunction) => TargetFunctionCoverage | Promise<TargetFunctionCoverage>): Promise<TargetCoverageResult[]> => {
    const results: TargetCoverageResult[] = [];
    for (const subject of subjects) {
      try {
        results.push({ status: "available", targetFunction: await parse(subject) });
      } catch (error) {
        results.push({ status: "unavailable", reason: error instanceof Error ? error.message : "Could not locate target coverage." });
      }
    }
    return results;
  };
  try {
    let targetFunctions: TargetCoverageResult[] = [];
    if (runner === "jest" || runner === "vitest") {
      const testReport = await read("tests.json");
      tests = parseNodeTests(testReport);
      testCases.push(...parseNodeTestCases(testReport));
      const report = await read("coverage-final.json");
      targetFunctions = await parseSubjects(async subject => parseIstanbul(report, canonicalRoot, subject, await readProjectFile(root, subject.path)));
    } else if (runner === "pytest") {
      const testReport = await read("tests.xml");
      tests = parseJUnit(testReport);
      testCases.push(...parseJUnitTestCases(testReport));
      const report = await read("coverage.json");
      targetFunctions = await parseSubjects(subject => {
        const functions = run.pythonFunctions?.find((item) => item.path === subject.path)?.functions ?? [];
        return parsePythonCoverage(report, canonicalRoot, subject, functions);
      });
    } else if (runner === "maven" || runner === "gradle") {
      const primaryDirectory = runner === "maven" ? resolveSafePath(root, run.surefireReportsDirectory ?? MAVEN_TEST_REPORTS) : join(run.dataDirectory, "tests");
      const fallbackDirectory = runner === "maven" ? resolveSafePath(root, MAVEN_TEST_REPORTS) : undefined;
      let testDirectory = primaryDirectory;
      let names = (await readdir(testDirectory).catch(() => [] as string[])).filter(name => /^TEST-.*\.xml$/.test(name));
      if (names.length === 0 && fallbackDirectory && fallbackDirectory !== primaryDirectory) {
        testDirectory = fallbackDirectory;
        names = (await readdir(testDirectory).catch(() => [] as string[])).filter(name => /^TEST-.*\.xml$/.test(name));
      }
      if (names.length === 0) throw new Error(`Missing ${runner} test reports.`);
      tests = { executed: 0, passed: 0, failed: 0, skipped: 0 };
      for (const name of names) {
        const xml = runner === "maven" ? await report(join(testDirectory, name)) : await read(`tests/${name}`);
        const value = runner === "maven" ? parseSurefireReport(xml) : parseJUnit(xml);
        for (const key of ["executed", "passed", "failed", "skipped"] as const) tests[key] += value[key];
        testCases.push(...parseJUnitTestCases(xml));
      }
      const primaryCoverage = runner === "maven" ? resolveSafePath(root, run.jacocoReportPath ?? MAVEN_REPORT_PATH) : join(run.dataDirectory, "jacoco.xml");
      const fallbackCoverage = runner === "maven" ? resolveSafePath(root, MAVEN_REPORT_PATH) : undefined;
      let coveragePath = primaryCoverage;
      try { await access(coveragePath); } catch {
        if (fallbackCoverage) coveragePath = fallbackCoverage;
      }
      const xml = runner === "maven" ? await report(coveragePath) : await read("jacoco.xml");
      targetFunctions = await parseSubjects(async subject => parseJacocoReport(xml, subject, await readProjectFile(root, subject.path)));
    } else if (runner === "dotnet") {
      const testReport = await read("tests.trx");
      tests = parseTrx(testReport);
      testCases.push(...parseTrxTestCases(testReport));
      const names = await readdir(run.dataDirectory, { recursive: true });
      const coverage = names.filter(name => /^[0-9a-f-]{36}[\\/]coverage\.cobertura\.xml$/i.test(name));
      if (coverage.length !== 1) throw new Error("Expected one Coverlet Cobertura report in a VSTest run directory.");
      const report = await read(coverage[0]);
      targetFunctions = await parseSubjects(subject => parseCobertura(report, subject, canonicalRoot));
    } else throw new Error(`Unsupported coverage runner: ${runner}`);
    return { tests, testCases, coverage: targetFunctions };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Could not collect coverage.";
    return { ...(tests ? { tests } : {}), testCases, coverage: subjects.map(() => ({ status: "unavailable", reason })) };
  }
}
