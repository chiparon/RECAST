import { describe, it, expect } from "vitest";
import { parseJacocoReport, parseSurefireReport, parseCobertura, parseIstanbul, parseJUnit, parseNodeTests, parsePythonCoverage, parseTrx } from "./coverage-reports.js";
const loc = (start: number, end = start) => ({ start: { line: start, column: 0 }, end: { line: end, column: 20 } });
describe("framework coverage reports", () => {
  it("matches a qualified Java method without parameters and keeps overloads ambiguous", () => {
    const method = (desc: string) => `<method name="run" desc="${desc}"><counter type="METHOD" missed="0" covered="1"/></method>`;
    const xml = (methods: string) => `<report><package name="demo"><class name="demo/Service" sourcefilename="Service.java">${methods}</class><class name="demo/Other" sourcefilename="Service.java">${method("()V")}</class></package></report>`;
    const subject = { path: "Service.java", name: "run", signature: "Service.run" };
    expect(parseJacocoReport(xml(method("()V")), subject, "package demo;")).toMatchObject({ executed: true });
    expect(() => parseJacocoReport(xml(method("()V") + method("(I)V")), subject, "package demo;")).toThrow("2 matches");
    expect(parseJacocoReport(xml(method("()V") + method("(I)V")), { ...subject, signature: "Service.run(int value)" }, "package demo;").executed).toBe(true);
  });

  it("merges JUnit leaves without counting parent suites twice", () => {
    expect(parseJUnit('<testsuites><testsuite tests="99"><testsuite tests="3" failures="1" errors="0" skipped="1"/></testsuite><testsuite tests="1" failures="0" errors="1" skipped="0"/></testsuites>')).toEqual({ executed: 3, passed: 1, failed: 2, skipped: 1 });
    expect(() => parseJUnit('<testsuite tests="1" skipped="2"/>')).toThrow();
  });
  it("counts Node skipped tests and rejects malformed counters", () => {
    expect(parseNodeTests(JSON.stringify({ numTotalTests: 3, numFailedTests: 1, numPendingTests: 1 }))).toEqual({ executed: 2, passed: 1, failed: 1, skipped: 1 });
    expect(() => parseNodeTests('{"numTotalTests":-1,"numFailedTests":0}')).toThrow();
  });
  it("uses the selected Istanbul function, excluding nested functions", () => {
    const file = { fnMap: { 0: { name: "price", loc: loc(1, 10) }, 1: { name: "nested", loc: loc(5, 7) } }, f: { 0: 1, 1: 0 }, statementMap: { 0: loc(2), 1: loc(3), 2: loc(6), 3: loc(20) }, s: { 0: 1, 1: 0, 2: 0, 3: 0 }, branchMap: { 0: { loc: loc(2) }, 1: { loc: loc(6) } }, b: { 0: [1, 0], 1: [0, 0] } };
    const report = JSON.stringify({ "/project/price.js": file });
    expect(parseIstanbul(report, "/project", { path: "price.js", name: "price" })).toEqual({ name: "price", executed: true, lineCoverage: 50, branchCoverage: 50 });
    expect(() => parseIstanbul(report, "/project", { path: "other.js", name: "price" })).toThrow();
    file.fnMap[1].name = "price";
    expect(() => parseIstanbul(JSON.stringify({ "/project/price.js": file }), "/project", { path: "price.js", name: "price" })).toThrow();
  });
  it("does not treat executing a Python definition as invoking its body", () => {
    const subject = { path: "price.py", name: "price" };
    const functions = [{ name: "price", start: 1, bodyStart: 2, end: 4, nested: [] }];
    const report = JSON.stringify({ files: { "price.py": { executed_lines: [1, 20], missing_lines: [2, 3, 4], executed_branches: [], missing_branches: [[2, 3], [2, 4]] } } });
    expect(parsePythonCoverage(report, "/project", subject, functions)).toEqual({ name: "price", executed: false, lineCoverage: 0, branchCoverage: 0 });
    expect(() => parsePythonCoverage(report, "/project", subject, [...functions, ...functions])).toThrow();
    expect(() => parsePythonCoverage(report, "/project", subject, [{ ...functions[0], bodyStart: 1 }])).toThrow();
  });
  it("matches named arrow functions and class methods recorded as anonymous", () => {
    const file = { fnMap: { 0: { name: "(anonymous_0)", decl: { start: { line: 1, column: 14 } }, loc: loc(1) }, 1: { name: "(anonymous_1)", decl: { start: { line: 3, column: 2 } }, loc: loc(3, 5) } }, f: { 0: 1, 1: 0 }, statementMap: {}, s: {}, branchMap: {}, b: {} };
    const source = "const arrow = (value) => value * 2;\nclass Price {\n  calculate(value) {\n    return value * 2;\n  }\n}";
    const json = JSON.stringify({ "/project/price.js": file });
    expect(parseIstanbul(json, "/project", { path: "price.js", name: "arrow" }, source).executed).toBe(true);
    expect(parseIstanbul(json, "/project", { path: "price.js", name: "calculate" }, source).executed).toBe(false);
    expect(() => parseIstanbul(json, "/project", { path: "price.js", name: "calculate" })).toThrow();
  });
  it("uses TRX executed counts because xUnit notExecuted omits skipped cases", () => {
    expect(parseTrx('<TestRun><ResultSummary><Counters total="1" executed="0" passed="0" notExecuted="0"/></ResultSummary></TestRun>')).toEqual({ executed: 0, passed: 0, failed: 0, skipped: 1 });
  });
  it("counts non-passing TRX outcomes as failures", () => {
    expect(parseTrx('<TestRun><ResultSummary><Counters total="4" passed="1" failed="1" error="1" notExecuted="1"/></ResultSummary></TestRun>')).toEqual({ executed: 3, passed: 1, failed: 2, skipped: 1 });
  });
  it("reads Cobertura method sequence points and branch counts", () => {
    const xml = '<coverage><packages><package><classes><class filename="src/Price.cs"><methods><method name="Calculate" signature="int(int)"><lines><line number="3" hits="1" branch="True" condition-coverage="50% (1/2)"/><line number="4" hits="0"/></lines></method></methods></class></classes></package></packages></coverage>';
    expect(parseCobertura(xml, { path: "src/Price.cs", name: "Calculate" })).toEqual({ name: "Calculate", executed: true, lineCoverage: 50, branchCoverage: 50 });
    expect(parseCobertura(xml.replace('signature="int(int)"', 'signature="(System.Int32)"'), { path: "src/Price.cs", name: "Calculate", signature: "public int Calculate(int value)" }).executed).toBe(true);
    expect(() => parseCobertura(xml, { path: "other/Price.cs", name: "Calculate" })).toThrow();
    expect(() => parseCobertura(xml.replace('filename="src/Price.cs"', 'filename="vendor/src/Price.cs"'), { path: "src/Price.cs", name: "Calculate" }, "/project")).toThrow();
    expect(() => parseCobertura(xml.replace('1/2', '3/2'), { path: "src/Price.cs", name: "Calculate" })).toThrow();
  });
  it("uses a qualified C# API to disambiguate duplicate method names", () => {
    const xml = `<coverage><sources><source>/project/src</source></sources><packages><package><classes>
      <class name="A.OrderValidationPolicy" filename="Policies.cs"><methods><method name="Evaluate" signature="()"><lines><line number="1" hits="0" /></lines></method></methods></class>
      <class name="A.AttachmentValidationPipeline" filename="Policies.cs"><methods><method name="Evaluate" signature="()"><lines><line number="2" hits="1" /></lines></method></methods></class>
    </classes></package></packages></coverage>`;
    expect(parseCobertura(xml, { path: "Policies.cs", name: "Evaluate", signature: "OrderValidationPolicy.Evaluate" }, "/project/src").executed).toBe(false);
    expect(parseCobertura(xml, { path: "Policies.cs", name: "Evaluate", signature: "AttachmentValidationPipeline.Evaluate" }, "/project/src").executed).toBe(true);
  });
  it("accepts Coverlet namespace-qualified parameter types for source-level signatures", () => {
    const xml = `<coverage><sources><source>/project/src</source></sources><packages><package><classes>
      <class name="A.AttachmentValidationPipeline" filename="Policies.cs"><methods><method name="Evaluate" signature="(A.AttachmentInput)"><lines><line number="1" hits="1" /></lines></method></methods></class>
    </classes></package></packages></coverage>`;
    expect(parseCobertura(xml, { path: "Policies.cs", name: "Evaluate", signature: "AttachmentValidationPipeline.Evaluate(AttachmentInput attachment)" }, "/project/src").executed).toBe(true);
  });
  it("distinguishes covered and uncovered C# overloads including extension and default parameters", () => {
    const xml = `<coverage><packages><package><classes><class name="App.DomainExtensions" filename="Extensions.cs"><methods>
      <method name="StableFingerprint" signature="(App.OrderRequest)"><lines><line number="1" hits="1"/></lines></method>
      <method name="StableFingerprint" signature="(App.AttachmentInput,System.Int32)"><lines><line number="2" hits="0"/></lines></method>
    </methods></class></classes></package></packages></coverage>`;
    const subject = { path: "Extensions.cs", name: "StableFingerprint" };
    expect(() => parseCobertura(xml, { ...subject, signature: "DomainExtensions.StableFingerprint" })).toThrow("Cannot uniquely locate");
    expect(parseCobertura(xml, { ...subject, signature: "DomainExtensions.StableFingerprint(this OrderRequest order)" }).executed).toBe(true);
    expect(parseCobertura(xml, { ...subject, signature: "DomainExtensions.StableFingerprint(this AttachmentInput attachment, int limit = 4)" }).executed).toBe(false);
    expect(() => parseCobertura(xml, { ...subject, signature: "DomainExtensions.StableFingerprint(PluginInvocation invocation)" })).toThrow("Cannot uniquely locate");
  });
  it("attributes real Coverlet generic and nullable-reference overloads independently", () => {
    const xml = `<coverage><packages><package><classes><class name="AssetUpgradeGateway.Domain.ContentSignature" filename="Domain/AssetLifecycle.cs"><methods>
      <method name="Matches" signature="(System.ReadOnlySpan\`1&lt;System.Byte&gt;)"><lines><line number="1" hits="1"/><line number="2" hits="0"/></lines></method>
      <method name="Matches" signature="(System.String,System.ReadOnlySpan\`1&lt;System.Byte&gt;)"><lines><line number="3" hits="0"/></lines></method>
    </methods></class></classes></package></packages></coverage>`;
    const subject = { path: "Domain/AssetLifecycle.cs", name: "Matches" };
    expect(parseCobertura(xml, { ...subject, signature: "AssetUpgradeGateway.Domain.ContentSignature.Matches(ReadOnlySpan<byte> content)" })).toMatchObject({ executed: true, lineCoverage: 50 });
    expect(parseCobertura(xml, { ...subject, signature: "AssetUpgradeGateway.Domain.ContentSignature.Matches(string? fileName, ReadOnlySpan<byte> content)" })).toMatchObject({ executed: false, lineCoverage: 0 });
    expect(() => parseCobertura(xml, { ...subject, signature: "ContentSignature.Matches(ReadOnlySpan<int> content)" })).toThrow("0 matches");
    expect(() => parseCobertura(xml, { ...subject, signature: "ContentSignature.Matches" })).toThrow("2 matches");
  });
  it("matches nested generic arguments without confusing nullable values, array ranks or ref overloads", () => {
    const xml = `<coverage><packages><package><classes><class name="App.Parser" filename="Parser.cs"><methods>
      <method name="Read" signature="(System.Collections.Generic.Dictionary\`2&lt;System.String,System.Collections.Generic.List\`1&lt;System.Nullable\`1&lt;System.Int32&gt;[]&gt;&gt;,System.String)"><lines><line number="1" hits="1"/></lines></method>
      <method name="Read" signature="(System.Int32)"><lines><line number="2" hits="1"/></lines></method>
      <method name="Read" signature="(System.Nullable\`1&lt;System.Int32&gt;)"><lines><line number="3" hits="0"/></lines></method>
      <method name="Read" signature="(System.Int32&amp;)"><lines><line number="4" hits="0"/></lines></method>
    </methods></class></classes></package></packages></coverage>`;
    const subject = { path: "Parser.cs", name: "Read" };
    const parse = (params: string) => parseCobertura(xml, { ...subject, signature: `Parser.Read(${params})` });
    expect(parse('Dictionary<string, List<int?[]>> values, string? separator = "a,b"').executed).toBe(true);
    expect(parse("int value").executed).toBe(true);
    expect(parse("int? value").executed).toBe(false);
    expect(parse("ref int value").executed).toBe(false);
    expect(() => parse('Dictionary<string, List<int?[,]>> values, string separator')).toThrow("0 matches");
    expect(() => parse('Dictionary<string, List<byte?[]>> values, string separator')).toThrow("0 matches");
    expect(() => parse('Dictionary<string, List<int?[]> values, string separator')).toThrow("0 matches");
  });
  it("rejects ambiguous short generic type names and honors explicit namespaces", () => {
    const method = (owner: string, hits: number) => `<method name="Read" signature="(${owner}.Box\`1&lt;System.Byte&gt;)"><lines><line number="1" hits="${hits}"/></lines></method>`;
    const xml = `<coverage><packages><package><classes><class name="App.Parser" filename="Parser.cs"><methods>${method("First", 1)}${method("Second", 0)}</methods></class></classes></package></packages></coverage>`;
    const subject = { path: "Parser.cs", name: "Read" };
    expect(() => parseCobertura(xml, { ...subject, signature: "Parser.Read(Box<byte> value)" })).toThrow("2 matches");
    expect(parseCobertura(xml, { ...subject, signature: "Parser.Read(global::Second.Box<byte> value)" }).executed).toBe(false);
  });
  it("maps real Coverlet async state machines to their declaring method and rejects ambiguous overloads", () => {
    const state = (owner: string, ordinal: number) => `<class name="${owner}/&lt;SubmitAsync&gt;d__${ordinal}" filename="Service.cs"><methods><method name="MoveNext" signature="()"><lines><line number="5" hits="1"/></lines></method></methods></class>`;
    const report = (classes: string) => `<coverage><sources><source>/project</source></sources><packages><package><classes>${classes}</classes></package></packages></coverage>`;
    const subject = { path: "Service.cs", name: "SubmitAsync", signature: "AssetService.SubmitAsync" };
    expect(parseCobertura(report(state("App.AssetService", 1) + state("App.OrderService", 2)), subject, "/project")).toMatchObject({ executed: true, lineCoverage: 100 });
    expect(() => parseCobertura(report(state("App.AssetService", 1) + state("App.AssetService", 2)), subject, "/project")).toThrow("Cannot uniquely locate");
  });
});

const subject = { path: "src/main/java/example/Order.java", name: "calculatePrice", signature: "public int calculatePrice(int quantity)" };
const source = "package example; public class Order {}";
function method(descriptor = "(I)I", executed = true, branches = true): string {
  return `<method name="calculatePrice" desc="${descriptor}"><counter type="METHOD" missed="${executed ? 0 : 1}" covered="${executed ? 1 : 0}"/><counter type="LINE" missed="${executed ? 2 : 8}" covered="${executed ? 6 : 0}"/>${branches ? '<counter type="BRANCH" missed="1" covered="3"/>' : ''}</method>`;
}
function report(methods = method()): string {
  return `<report name="test"><package name="example"><class name="example/Order" sourcefilename="Order.java">${methods}</class></package></report>`;
}

describe("JaCoCo and Surefire reports", () => {
  it("extracts method counters, not the class-wide counters", () => {
    expect(parseJacocoReport(report(), subject, source)).toEqual({
      name: "calculatePrice", executed: true, lineCoverage: 75, branchCoverage: 75,
    });
  });
  it("distinguishes an unexecuted method and a method with no branches", () => {
    expect(parseJacocoReport(report(method("(I)I", false, false)), subject, source)).toEqual({
      name: "calculatePrice", executed: false, lineCoverage: 0, branchCoverage: null,
    });
  });
  it("uses the signature to distinguish overloads and refuses ambiguous identities", () => {
    const xml = report(method() + method("(Ljava/lang/String;)I"));
    expect(parseJacocoReport(xml, subject, source).executed).toBe(true);
    expect(() => parseJacocoReport(xml, { ...subject, signature: undefined }, source)).toThrow("uniquely locate");
    expect(() => parseJacocoReport(xml, { ...subject, signature: "int calculatePrice(boolean value)" }, source)).toThrow("0 matches");
  });
  it("matches arrays, reference types and explicit JVM signatures", () => {
    const xml = report(method("([Ljava/lang/String;I)I"));
    expect(parseJacocoReport(xml, { ...subject, signature: "int calculatePrice(String[] values, int count)" }, source).executed).toBe(true);
    expect(parseJacocoReport(xml, { ...subject, signature: "([Ljava/lang/String;I)I" }, source).executed).toBe(true);
  });
  it.each([
    ["java.util.Map<String, java.util.List<? extends Number>> values, int count", "(Ljava/util/Map;I)I"],
    ["final java.util.Map<String, java.util.List<Integer>>[][] values, int count", "([[Ljava/util/Map;I)I"],
    ["int count, Map<String, List<? super Integer>>... values", "(I[Ljava/util/Map;)I"],
  ])("matches erased nested Java generic parameter types without splitting their commas: %s", (parameters, desc) => {
    expect(parseJacocoReport(report(method(desc)), { ...subject, signature: `Order.calculatePrice(${parameters})` }, source).executed).toBe(true);
  });
  it("keeps generic and non-generic overload coverage separate, including uncovered generic methods", () => {
    const xml = report(method("(Ljava/util/List;)I", false) + method("(Ljava/lang/String;)I", true));
    expect(parseJacocoReport(xml, { ...subject, signature: "Order.calculatePrice(List<String> values)" }, source)).toMatchObject({ executed: false, lineCoverage: 0 });
    expect(parseJacocoReport(xml, { ...subject, signature: "Order.calculatePrice(String value)" }, source).executed).toBe(true);
    expect(() => parseJacocoReport(xml, { ...subject, signature: "Order.calculatePrice" }, source)).toThrow("2 matches");
    expect(() => parseJacocoReport(xml, { ...subject, signature: "Order.calculatePrice(Set<String> values)" }, source)).toThrow("0 matches");
  });
  it("rejects malformed generic lists and keeps duplicate erased descriptors ambiguous", () => {
    const xml = report(method("(Ljava/util/Map;)I"));
    for (const parameters of ["Map<String, Integer values", "Map<String>> values"]) {
      expect(() => parseJacocoReport(xml, { ...subject, signature: `Order.calculatePrice(${parameters})` }, source)).toThrow("0 matches");
    }
    expect(() => parseJacocoReport(report(method("(Ljava/util/List;)I") + method("(Ljava/util/List;)I")),
      { ...subject, signature: "Order.calculatePrice(List<String> values)" }, source)).toThrow("2 matches");
  });
  it("refuses other source files, packages, malformed XML and invalid counters", () => {
    expect(() => parseJacocoReport(report(), { ...subject, path: "src/Other.java" }, source)).toThrow("0 matches");
    expect(() => parseJacocoReport(report(), subject, "package other;")).toThrow("0 matches");
    expect(() => parseJacocoReport("<report>", subject, source)).toThrow("Invalid XML");
    expect(() => parseJacocoReport(report().replace('covered="6"', 'covered="NaN"'), subject, source)).toThrow("Invalid report counter");
  });
  it("does not count skipped tests as executed and includes execution errors as failures", () => {
    expect(parseSurefireReport('<testsuite tests="5" failures="1" errors="1" skipped="1"/>')).toEqual({
      executed: 4, passed: 2, failed: 2, skipped: 1,
    });
    expect(() => parseSurefireReport('<testsuite tests="1" failures="2" errors="0" skipped="0"/>')).toThrow("Inconsistent");
  });
});
