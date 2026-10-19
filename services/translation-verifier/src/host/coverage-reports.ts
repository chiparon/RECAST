import { XMLParser, XMLValidator } from "fast-xml-parser";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { TargetFunctionCoverage, VerificationFunction, VerificationTestCase } from "../types.js";
import type { TestSummary } from "./tools/common.js";

function fileIdentity(root: string, path: string): string {
  const absolute = resolve(root, path);
  try { return realpathSync(absolute); } catch { return absolute; }
}

export function counter(value: unknown): number {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error("Invalid report counter.");
  return n;
}
export function percent(hits: readonly number[]): number | null {
  return hits.length === 0 ? null : Math.round(hits.filter(n => n > 0).length / hits.length * 10_000) / 100;
}
export function xmlReport(xml: string): any {
  if (Buffer.byteLength(xml) > 16_000_000 || XMLValidator.validate(xml) !== true) throw new Error("Invalid XML report.");
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", parseTagValue: false, processEntities: false,
    isArray: name => ["testsuite", "testcase", "class", "method", "line", "condition", "source", "package", "counter"].includes(name),
  }).parse(xml);
}
export function jsonReport(json: string): any {
  if (Buffer.byteLength(json) > 16_000_000) throw new Error("Report exceeds the size limit.");
  return JSON.parse(json);
}
export function summary(total: unknown, failed: unknown, skipped: unknown): TestSummary {
  const t = counter(total), f = counter(failed), s = counter(skipped);
  if (f + s > t) throw new Error("Inconsistent test counts.");
  return { executed: t - s, passed: t - s - f, failed: f, skipped: s };
}
export function parseJUnit(xml: string): TestSummary {
  const report = xmlReport(xml);
  const suites = report.testsuite ?? report.testsuites?.testsuite ?? [];
  const result = { executed: 0, passed: 0, failed: 0, skipped: 0 };
  const visit = (suite: any) => {
    if (suite.testsuite?.length) { suite.testsuite.forEach(visit); return; }
    const parsed = summary(suite.tests, counter(suite.failures ?? "0") + counter(suite.errors ?? "0"), suite.skipped ?? "0");
    for (const key of ["executed", "passed", "failed", "skipped"] as const) result[key] += parsed[key];
  };
  if (suites.length === 0) throw new Error("Missing test suites.");
  suites.forEach(visit);
  return result;
}
export function parseNodeTests(json: string): TestSummary {
  const report = jsonReport(json);
  return summary(report.numTotalTests, report.numFailedTests, counter(report.numPendingTests ?? 0) + counter(report.numTodoTests ?? 0));
}

function reportMessage(value: any): string | undefined {
  if (value === undefined) return undefined;
  const items = Array.isArray(value) ? value : [value];
  return items.map(item => typeof item === "string" ? item : [item.message, item["#text"]].filter(Boolean).join("\n")).filter(Boolean).join("\n").slice(0, 8000) || undefined;
}

export function parseJUnitTestCases(xml: string): VerificationTestCase[] {
  const report = xmlReport(xml);
  const result: VerificationTestCase[] = [];
  const visit = (suite: any) => {
    for (const test of suite.testcase ?? []) {
      if (typeof test.name !== "string") continue;
      const failed = test.failure !== undefined || test.error !== undefined;
      const message = reportMessage(test.failure ?? test.error);
      result.push({ id: `${test.classname ?? suite.name ?? ""}#${test.name}`,
        status: failed ? "failed" : test.skipped !== undefined ? "skipped" : "passed", ...(message ? { message } : {}) });
    }
    for (const child of suite.testsuite ?? []) visit(child);
  };
  for (const suite of report.testsuite ?? report.testsuites?.testsuite ?? []) visit(suite);
  return result;
}

export function parseNodeTestCases(json: string): VerificationTestCase[] {
  return (jsonReport(json).testResults ?? []).flatMap((file: any) => (file.assertionResults ?? []).flatMap((test: any) => {
    const name = test.fullName ?? test.title;
    if (typeof name !== "string") return [];
    const status = test.status === "passed" ? "passed" : test.status === "failed" ? "failed" : "skipped";
    const message = reportMessage(test.failureMessages);
    return [{ id: `${file.name ?? ""}#${name}`, status, ...(message ? { message } : {}) }];
  }));
}

export function parseTrxTestCases(xml: string): VerificationTestCase[] {
  const report = xmlReport(xml).TestRun;
  const definitions = report?.TestDefinitions?.UnitTest;
  const units = Array.isArray(definitions) ? definitions : definitions ? [definitions] : [];
  const results = report?.Results?.UnitTestResult;
  return (Array.isArray(results) ? results : results ? [results] : []).flatMap((test: any) => {
    if (typeof test.testName !== "string") return [];
    const unit = units.find((item: any) => item.id === test.testId);
    const message = reportMessage(test.Output?.ErrorInfo?.Message);
    return [{ id: `${unit?.TestMethod?.className ?? ""}#${test.testName}`,
      status: test.outcome === "Passed" ? "passed" : test.outcome === "NotExecuted" ? "skipped" : "failed", ...(message ? { message } : {}) }];
  });
}

/** Istanbul's line metric groups statement start lines, just like its native reporter. */
export function parseIstanbul(json: string, root: string, subject: VerificationFunction, source?: string): TargetFunctionCoverage {
  const files = Object.entries(jsonReport(json)).filter(([path]) => fileIdentity(root, path) === fileIdentity(root, subject.path));
  if (files.length !== 1) throw new Error("Cannot uniquely locate target file in Istanbul report.");
  const file: any = files[0][1];
  const matches = Object.entries(file.fnMap ?? {}).filter(([, fn]: any) => {
    if (fn.name === subject.name) return true;
    if (!source || !/^\(anonymous_\d+\)$/.test(fn.name) || !fn.decl?.start) return false;
    const line = source.split(/\r?\n/)[fn.decl.start.line - 1] ?? "";
    const escaped = subject.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prefix = line.slice(0, fn.decl.start.column);
    const suffix = line.slice(fn.decl.start.column);
    return new RegExp(`^(?:${escaped})\\s*\\(`).test(suffix) ||
      new RegExp(`\\b${escaped}\\s*=\\s*(?:async\\s*)?$`).test(prefix);
  });
  if (matches.length !== 1) throw new Error(`Cannot uniquely locate target function ${subject.name} in Istanbul report.`);
  const [id, fn]: any = matches[0];
  const inside = (loc: any, range: any) => loc && range &&
    (loc.start.line > range.start.line || loc.start.line === range.start.line && loc.start.column >= range.start.column) &&
    (loc.end.line < range.end.line || loc.end.line === range.end.line && loc.end.column <= range.end.column);
  const nested: any[] = Object.entries(file.fnMap).filter(([key, value]: any) => key !== id && inside(value.loc, fn.loc)).map(([, value]) => value);
  const belongs = (loc: any) => inside(loc, fn.loc) && !nested.some(value => inside(loc, value.loc));
  const lines = new Map<number, number>();
  for (const [key, loc] of Object.entries(file.statementMap ?? {}) as [string, any][]) {
    if (belongs(loc)) lines.set(loc.start.line, Math.max(lines.get(loc.start.line) ?? 0, counter(file.s[key])));
  }
  const branches: number[] = [];
  for (const [key, branch] of Object.entries(file.branchMap ?? {}) as [string, any][]) {
    if (belongs(branch.loc)) branches.push(...file.b[key].map(counter));
  }
  return { name: subject.name, executed: counter(file.f[id]) > 0, lineCoverage: percent([...lines.values()]), branchCoverage: percent(branches) };
}

export type PythonFunction = { name: string; start: number; end: number; bodyStart: number; nested: { start: number; end: number }[] };
export function parsePythonCoverage(json: string, root: string, subject: VerificationFunction, functions: PythonFunction[]): TargetFunctionCoverage {
  const report = jsonReport(json);
  const files = Object.entries(report.files ?? {}).filter(([path]) => fileIdentity(root, path) === fileIdentity(root, subject.path));
  if (files.length !== 1) throw new Error("Cannot uniquely locate target file in coverage.py report.");
  const matches = functions.filter(fn => fn.name === subject.name || fn.name.split(".").pop() === subject.name);
  if (matches.length !== 1) throw new Error(`Cannot uniquely locate target function ${subject.name} in Python source.`);
  const fn = matches[0], file: any = files[0][1];
  if (fn.bodyStart === fn.start) throw new Error("Single-line Python functions require function-level tracing.");
  const belongs = (line: number) => line >= fn.bodyStart && line <= fn.end && !fn.nested.some(n => line >= n.start && line <= n.end);
  const executed = (file.executed_lines ?? []).map(counter).filter(belongs);
  const missed = (file.missing_lines ?? []).map(counter).filter(belongs);
  const hitBranches = (file.executed_branches ?? []).filter(([line]: number[]) => belongs(line));
  const missingBranches = (file.missing_branches ?? []).filter(([line]: number[]) => belongs(line));
  return { name: subject.name, executed: executed.length > 0, lineCoverage: percent([...executed.map(() => 1), ...missed.map(() => 0)]),
    branchCoverage: percent([...hitBranches.map(() => 1), ...missingBranches.map(() => 0)]) };
}

export function parseTrx(xml: string): TestSummary {
  const counts = xmlReport(xml).TestRun?.ResultSummary?.Counters;
  if (!counts) throw new Error("Missing TRX counters.");
  // Outcomes other than passed/notExecuted are failures, including timeout/error/aborted.
  const total = counter(counts.total), passed = counter(counts.passed);
  // xUnit emits notExecuted=0 for skipped cases; executed is the reliable aggregate.
  const skipped = counts.executed !== undefined ? total - counter(counts.executed) : counter(counts.notExecuted);
  return summary(total, total - skipped - passed, skipped);
}
export function parseCobertura(xml: string, subject: VerificationFunction, root?: string): TargetFunctionCoverage {
  const report = xmlReport(xml).coverage;
  const packages = report?.packages?.package;
  const packageList = Array.isArray(packages) ? packages : packages ? [packages] : [];
  const methods: any[] = [];
  const declaringType = functionDeclaringType(subject);
  for (const pkg of packageList) for (const cls of pkg.classes?.class ?? []) {
    const className = String(cls.name ?? "").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
    // Coverlet attributes async/iterator bodies to the compiler-generated
    // state machine's MoveNext, rather than the source method. Use the
    // original declaring type and method encoded in that class identity.
    const stateMachine = className.match(/^(.*)\/<([^<>]+)>d__\d+$/);
    const path = String(cls.filename ?? "").replaceAll("\\", "/");
    if (root) {
      const sources: string[] = report.sources?.source ?? [];
      const candidates = isAbsolute(path) ? [path] : sources.length ? sources.map(source => resolve(source, path)) : [resolve(root, path)];
      if (!candidates.some(candidate => fileIdentity(root, candidate) === fileIdentity(root, subject.path))) continue;
    } else if (path !== subject.path) continue;
    if (declaringType) {
      const owner = stateMachine?.[1] ?? className;
      const simpleName = owner.split(/[.:/]/).filter(Boolean).at(-1) ?? owner;
      if (simpleName !== declaringType && owner !== declaringType) continue;
    }
    for (const method of cls.methods?.method ?? []) {
      if (stateMachine) {
        if (stateMachine[2] === subject.name && method.name === "MoveNext") methods.push(method);
      } else if (method.name === subject.name && (!subject.signature || matchesCsharpSignature(method.signature, subject.signature, subject.name))) methods.push(method);
    }
  }
  if (methods.length !== 1) throw new Error(`Cannot uniquely locate target function ${subject.name} in Cobertura report.`);
  const lines = methods[0].lines?.line ?? [];
  if (lines.length === 0) throw new Error("Missing method sequence points in Cobertura report.");
  const hits = lines.map((line: any) => counter(line.hits));
  let coveredBranches = 0, totalBranches = 0;
  for (const line of lines) if (String(line.branch).toLowerCase() === "true") {
    const match = String(line["condition-coverage"]).match(/\((\d+)\/(\d+)\)/);
    if (!match) throw new Error("Invalid Cobertura branch counter.");
    const covered = counter(match[1]), total = counter(match[2]);
    if (covered > total) throw new Error("Invalid Cobertura branch counter.");
    coveredBranches += covered;
    totalBranches += total;
  }
  return { name: subject.name, executed: hits.some((n: number) => n > 0), lineCoverage: percent(hits), branchCoverage: totalBranches === 0 ? null : Math.round(coveredBranches / totalBranches * 10_000) / 100 };
}

function functionDeclaringType(subject: VerificationFunction): string | undefined {
  let signature = subject.signature?.trim();
  if (!signature) return undefined;
  const open = signature.indexOf("(");
  if (open >= 0) signature = signature.slice(0, open);
  const dot = signature.lastIndexOf(".");
  const colon = signature.lastIndexOf("::");
  const separator = Math.max(dot, colon);
  if (separator <= 0) return undefined;
  const offset = separator === colon ? 2 : 1;
  const method = signature.slice(separator + offset).trim();
  if (method !== subject.name) return undefined;
  return signature.slice(0, separator).trim().split(/[.:]/).filter(Boolean).at(-1);
}

function matchesCsharpSignature(actual: string, requested: string, name: string): boolean {
  if (actual === requested) return true;
  if (!requested.includes("(")) return true;
  const aliases: Record<string, string> = { int: "System.Int32", long: "System.Int64", short: "System.Int16", byte: "System.Byte", bool: "System.Boolean", string: "System.String", char: "System.Char", double: "System.Double", float: "System.Single", decimal: "System.Decimal", object: "System.Object" };
  const start = requested.indexOf(`${name}(`);
  if (start < 0 || !actual.startsWith("(")) return false;
  const params = requested.slice(start + name.length + 1).split(")")[0];
  if (/[<>]/.test(params)) return false;
  const wanted = params.trim() ? params.split(",").map(param => {
    const type = param.split("=", 1)[0]!.trim()
      .replace(/^(?:(?:this|params|ref|out|in)\s+)+/, "")
      .replace(/\s+[\w]+$/, "").trim();
    const base = type.replace(/\[\]$/, "");
    return (aliases[base] ?? base) + (type.endsWith("[]") ? "[]" : "");
  }) : [];
  const actualTypes = actual.startsWith("(") && actual.endsWith(")")
    ? actual.slice(1, -1).split(",").filter(Boolean)
    : [];
  if (actualTypes.length !== wanted.length) return false;
  return wanted.every((requestedType, index) => {
    const actualType = actualTypes[index]!;
    if (actualType === requestedType) return true;
    // Coverlet writes fully-qualified parameter types while the indexer often
    // records the source-level short name. Accept that namespace decoration
    // only when the requested type itself is unqualified.
    return !requestedType.includes(".") && actualType.endsWith(`.${requestedType}`);
  });
}

type XmlNode = Record<string, any>;
export function parseSurefireReport(xml: string): TestSummary {
  const suites: XmlNode[] = xmlReport(xml).testsuite ?? [];
  if (suites.length !== 1) throw new Error("Expected one Surefire test suite.");
  const suite = suites[0];
  const total = counter(suite.tests);
  const skipped = counter(suite.skipped);
  const failed = counter(suite.failures) + counter(suite.errors);
  if (skipped + failed > total) throw new Error("Inconsistent test counts.");
  return { executed: total - skipped, passed: total - skipped - failed, failed, skipped };
}

export function parseJacocoReport(
  xml: string, subject: VerificationFunction, source: string,
): TargetFunctionCoverage {
  const report = xmlReport(xml).report;
  if (!report) throw new Error("Missing JaCoCo report.");
  const packageName = source.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1]?.replaceAll(".", "/") ?? "";
  const candidates: XmlNode[] = [];
  for (const pkg of report.package ?? []) {
    if (pkg.name !== packageName) continue;
    for (const cls of pkg.class ?? []) {
      if (cls.sourcefilename !== basename(subject.path)) continue;
      const owner = functionDeclaringType(subject);
      if (owner && String(cls.name).split(/[/$]/).at(-1) !== owner) continue;
      for (const method of cls.method ?? []) {
        if (method.name === subject.name) candidates.push(method);
      }
    }
  }
  const matching = subject.signature
    ? candidates.filter((method) => matchesJavaSignature(method.desc, subject.signature!, subject.name))
    : candidates;
  if (matching.length !== 1) {
    throw new Error(`Cannot uniquely locate target function ${subject.name} in JaCoCo coverage (${matching.length} matches).`);
  }
  const counters: XmlNode[] = matching[0].counter ?? [];
  const method = counters.find((value) => value.type === "METHOD");
  if (!method || counter(method.covered) + counter(method.missed) !== 1) throw new Error("Missing or invalid method coverage counter.");
  return {
    name: subject.name,
    executed: counter(method.covered) === 1,
    lineCoverage: jacocoPercentage(counters, "LINE"),
    branchCoverage: jacocoPercentage(counters, "BRANCH"),
  };
}

function jacocoPercentage(counters: XmlNode[], type: string): number | null {
  const metric = counters.find((value) => value.type === type);
  if (!metric) return null;
  const covered = counter(metric.covered), missed = counter(metric.missed);
  return covered + missed === 0 ? null : Math.round(covered / (covered + missed) * 10_000) / 100;
}

/** Match JVM descriptors or ordinary Java signatures; ambiguous matches stay unavailable. */
function matchesJavaSignature(descriptor: string, signature: string, name: string): boolean {
  if (!signature.includes("(")) return true;
  if (signature.startsWith("(")) return descriptor === signature;
  const namePosition = signature.indexOf(`${name}(`);
  if (namePosition < 0) return false;
  const parameters = eraseJavaTypeArguments(signature.slice(namePosition + name.length + 1).split(")")[0]);
  if (parameters === undefined) return false;
  const requested = parameters.trim() === "" ? [] : parameters.split(",").map((value) =>
    value.trim().replace(/^final\s+/, "").replace(/\s+[\w$]+$/, "").replaceAll("...", "[]"),
  );
  const actual = descriptorParameters(descriptor);
  return requested.length === actual.length && requested.every((type, index) =>
    type === actual[index] || (!type.includes(".") && type === actual[index].split(".").pop()),
  );
}

/** JVM descriptors erase parameterized type arguments, including their commas. */
function eraseJavaTypeArguments(parameters: string): string | undefined {
  let depth = 0;
  let erased = "";
  for (const character of parameters) {
    if (character === "<") depth++;
    else if (character === ">") {
      if (depth === 0) return undefined;
      depth--;
    } else if (depth === 0) erased += character;
  }
  return depth === 0 ? erased : undefined;
}

function descriptorParameters(descriptor: string): string[] {
  const input = descriptor.slice(1, descriptor.indexOf(")"));
  const names: Record<string, string> = { B: "byte", C: "char", D: "double", F: "float", I: "int", J: "long", S: "short", Z: "boolean" };
  const result: string[] = [];
  for (let index = 0; index < input.length;) {
    let suffix = "";
    while (input[index] === "[") { suffix += "[]"; index++; }
    let type: string;
    if (input[index] === "L") {
      const end = input.indexOf(";", index);
      if (end < 0) throw new Error("Invalid JVM descriptor.");
      type = input.slice(index + 1, end).replaceAll("/", ".").replaceAll("$", ".");
      index = end + 1;
    } else {
      type = names[input[index++]];
      if (!type) throw new Error("Invalid JVM descriptor.");
    }
    result.push(type + suffix);
  }
  return result;
}
