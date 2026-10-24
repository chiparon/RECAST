import { describe, expect, it } from "vitest";
import type { ProjectModule } from "@forexplore/contracts";
import { buildModuleFunctionMapping, callableApiName, discoverExecutableFunctions, expandClassLevelFunctions } from "./module-function-mapping.js";

const target = (coreApis: string[], sourceFiles = ["src/OrderService.cs", "src/PriceRule.cs"]): ProjectModule => ({
  id: "target", name: "Orders", kind: "feature", description: "orders", sourceFiles, coreApis,
  symbolKeys: [], dependsOn: [], evidenceIds: [],
});

describe("module function mapping", () => {
  it('discovers native public callables and gives overloads distinct identities', () => {
    const functions = discoverExecutableFunctions({
      'price.hxx': 'class Price { int hidden() {return 0;} public: int run(int x) {return x;} double run(double x) {return x;} protected: int helper() {return 1;} };',
      'price.c': 'static int helper(void) {return 1;}\nint run(void) {return helper();}',
    });
    expect(functions.map(fn => fn.name)).toEqual(['run', 'run', 'run']);
    expect(new Set(functions.map(fn => fn.signature)).size).toBe(3);
    expect(functions.every(fn => fn.startLine !== undefined)).toBe(true);
  });
  it('retains both const and non-const C++ overloads through pipeline API mapping', () => {
    const contents = { 'price.hpp': 'struct Price {\nint run() {return 1;}\nint run() const {return 2;}\n};' };
    const functions = discoverExecutableFunctions(contents);
    expect(functions.map(fn => fn.signature)).toEqual(['Price.run()', 'Price.run() const']);
    const result = buildModuleFunctionMapping({ ...target([], ['price.hpp']) }, undefined, contents, functions);
    expect(result.unmatchedFunctions).toEqual(functions);
  });
  it("discovers new concrete services independently of stale interface APIs", () => {
    const functions = discoverExecutableFunctions({
      "Attachment.java": `public interface Attachment { void scan(); }
        class Intake { @Deprecated public void accept(String tenant) {} private void helper() {} }
        class Delivery { public void dispatch(String key) {} public void dispatch(String key, boolean retry) {} }
        abstract class Policy { public abstract void check(); }`,
    });
    expect(functions).toEqual([
      { path: "Attachment.java", name: "accept", signature: "Intake.accept" },
      { path: "Attachment.java", name: "dispatch", signature: "Delivery.dispatch(String key)" },
      { path: "Attachment.java", name: "dispatch", signature: "Delivery.dispatch(String key, boolean retry)" },
    ]);
  });

  it("uses existing grammars for C# expression bodies and TypeScript public methods", () => {
    expect(discoverExecutableFunctions({
      "Price.cs": "public class Price { public int Calculate(int value) => value; private void Hidden() {} }",
      "retry.ts": "export function retry() { return true; } export class Queue { deliver() {} private hidden() {} }",
    }).map(fn => fn.signature)).toEqual(["Price.Calculate", "retry", "Queue.deliver"]);
  });

  it("keeps discovered file ownership and executable interface default methods", () => {
    const contents = { "First.java": "interface First { default void run() {} }",
      "Second.java": "interface Second { default void run() {} }" };
    const functions = discoverExecutableFunctions(contents);
    const mapping = buildModuleFunctionMapping(target(["Stale"], Object.keys(contents)), undefined, contents, functions);
    expect(mapping.unmatchedFunctions).toEqual(functions);
    expect(mapping.nonExecutableFunctions).toEqual([]);
    expect(mapping.unmatchedFunctions.map(fn => fn.path)).toEqual(["First.java", "Second.java"]);
  });

  it("expands class-level C# APIs to coverage-addressable methods", () => {
    const result = expandClassLevelFunctions(
      [{ path: "src/Telemetry.cs", name: "TraceFactory" }],
      () => `public sealed class TraceFactory { public TraceScope Start(string traceId, string operation) { return null; } }`,
    );
    expect(result).toEqual([{
      path: "src/Telemetry.cs",
      name: "Start",
      signature: "TraceFactory.Start",
    }]);
  });

  it("preserves an incomplete qualified signature so coverage can select the declaring class", () => {
    expect(expandClassLevelFunctions(
      [{ path: "src/Telemetry.cs", name: "CheckAsync", signature: "AssetUpgradeGateway.Telemetry.MetricsHealthProbe.CheckAsync" }],
      () => undefined,
    )).toEqual([{ path: "src/Telemetry.cs", name: "CheckAsync", signature: "AssetUpgradeGateway.Telemetry.MetricsHealthProbe.CheckAsync" }]);
  });

  it("expands incomplete method identities into every overload of the declaring class", () => {
    const source = `public class AssetAggregate {
      public EventEnvelope MarkDelivered(EventEnvelope envelope, DateTimeOffset now) { return envelope; }
      public AssetEvent MarkDelivered(AssetEvent assetEvent, DateTimeOffset now) { return assetEvent; }
      public class Nested { public void MarkDelivered(string ignored) {} }
      // public void MarkDelivered(bool commentedOut) {}
    }
    public class Other { public void MarkDelivered(int unrelated) {} }`;
    expect(expandClassLevelFunctions([
      { path: "Domain.cs", name: "MarkDelivered", signature: "Namespace.AssetAggregate.MarkDelivered" },
    ], () => source)).toEqual([
      { path: "Domain.cs", name: "MarkDelivered", signature: "AssetAggregate.MarkDelivered(EventEnvelope envelope, DateTimeOffset now)" },
      { path: "Domain.cs", name: "MarkDelivered", signature: "AssetAggregate.MarkDelivered(AssetEvent assetEvent, DateTimeOffset now)" },
    ]);
    const precise = { path: "Domain.cs", name: "MarkDelivered", signature: "AssetAggregate.MarkDelivered(EventEnvelope envelope, DateTimeOffset now)" };
    expect(expandClassLevelFunctions([precise], () => source)).toEqual([precise]);
  });

  it("expands overloaded extension methods with their source parameter signatures", () => {
    expect(expandClassLevelFunctions([
      { path: "Extensions.cs", name: "StableFingerprint", signature: "DomainExtensions.StableFingerprint" },
    ], () => `public static class DomainExtensions {
      public static string StableFingerprint(this OrderRequest order) => "x";
      public static string StableFingerprint(this AttachmentInput attachment, int limit = 4) => "y";
    }`)).toEqual([
      { path: "Extensions.cs", name: "StableFingerprint", signature: "DomainExtensions.StableFingerprint(this OrderRequest order)" },
      { path: "Extensions.cs", name: "StableFingerprint", signature: "DomainExtensions.StableFingerprint(this AttachmentInput attachment, int limit = 4)" },
    ]);
  });

  it("normalizes signatures and maps every unique API", () => {
    expect(callableApiName("public decimal OrderService::CalculatePrice(decimal amount)")).toBe("CalculatePrice");
    const result = buildModuleFunctionMapping(
      target(["OrderService.CalculatePrice(decimal)", "PriceRule.Apply(Order)"]),
      { sourceFiles: ["src/OrderService.cs", "src/PriceRule.cs"], coreApis: ["CalculatePrice(decimal)", "Apply(Order)"] },
    );
    expect(result.functions.map(({ target: item }) => item.name)).toEqual(["CalculatePrice", "Apply"]);
    expect(result.functions.map(({ target: item }) => item.path)).toEqual(["src/OrderService.cs", "src/PriceRule.cs"]);
    expect(result.unmatchedFunctions).toEqual([]);
  });

  it("keeps missing and ambiguous target APIs unmatched", () => {
    const result = buildModuleFunctionMapping(
      target(["OrderService.CalculatePrice", "OrderService.Missing", "PriceRule.Apply", "Other.Apply"]),
      { sourceFiles: ["src/OrderService.cs", "src/PriceRule.cs"], coreApis: ["CalculatePrice", "Apply"] },
    );
    expect(result.functions.map(({ target: item }) => item.name)).toEqual(["CalculatePrice"]);
    expect(result.unmatchedFunctions.map((item) => item.name)).toEqual(["Missing", "Apply", "Apply"]);
    expect(result.diagnostics.map((item) => item.reason)).toEqual(["no-source-api", "ambiguous-target-api", "ambiguous-target-api"]);
  });

  it("does not guess a file when several files are unrelated to the API qualifier", () => {
    const result = buildModuleFunctionMapping(
      target(["CalculatePrice"]),
      { sourceFiles: ["src/OrderService.cs", "src/PriceRule.cs"], coreApis: ["CalculatePrice"] },
    );
    expect(result.functions).toEqual([]);
    expect(result.unmatchedFunctions[0]?.path).toBe("src/OrderService.cs");
    expect(result.diagnostics[0]?.reason).toBe("source-file-ambiguous");
  });

  it("resolves target APIs to the file that declares their class", () => {
    const result = buildModuleFunctionMapping(
      target(["TenantQuotaPolicy.Evaluate", "TenantQuotaPolicy.IsWithin", "AttachmentValidationPipeline.Evaluate"], [
        "src/AttachmentPolicies.cs", "src/AuthorizationAndQuotaPolicies.cs",
      ]),
      undefined,
      {
        "src/AttachmentPolicies.cs": "public sealed class AttachmentValidationPipeline { public PolicyResult Evaluate() => throw null; }",
        "src/AuthorizationAndQuotaPolicies.cs": "public sealed class TenantQuotaPolicy { public PolicyResult Evaluate() => throw null; public bool IsWithin() => false; }",
      },
    );
    expect(result.unmatchedFunctions.map((item) => item.path)).toEqual([
      "src/AuthorizationAndQuotaPolicies.cs", "src/AuthorizationAndQuotaPolicies.cs", "src/AttachmentPolicies.cs",
    ]);
  });

  it("does not send interface and enum declarations to executable coverage", () => {
    const result = buildModuleFunctionMapping(
      target(["AssetKind", "IWorkflowDispatcher.DispatchAsync", "ConcreteService.Run"] , ["src/Contracts.cs", "src/Service.cs"]),
      undefined,
      {
        "src/Contracts.cs": "public enum AssetKind { Unknown } public interface IWorkflowDispatcher { Task DispatchAsync(); }",
        "src/Service.cs": "public sealed class ConcreteService { public void Run() {} }",
      },
    );
    expect(result.nonExecutableFunctions.map((item) => item.name)).toEqual(["AssetKind", "DispatchAsync"]);
    expect(result.unmatchedFunctions.map((item) => item.name)).toEqual(["Run"]);
  });

  it("resolves qualified types and expands generic methods without default parameter mismatches", () => {
    const contents = { "src/Contracts.cs": "public enum AssetKind { Unknown } public record AssetEvent(string Id);",
      "src/Domain.cs": "public static class DomainExtensions { public static T Resolve<T>(this IEnumerable<T> values) => default; public static string StableFingerprint(string value, int limit = 4) => value; }" };
    const mapping = buildModuleFunctionMapping(target([
      "AssetUpgradeGateway.Domain.AssetKind", "AssetUpgradeGateway.AssetEvent", "AssetUpgradeGateway.Domain.DomainExtensions",
    ], Object.keys(contents)), undefined, contents);
    expect(mapping.nonExecutableFunctions.map(fn => fn.name)).toEqual(["AssetKind", "AssetEvent"]);
    expect(expandClassLevelFunctions(mapping.unmatchedFunctions, path => contents[path as keyof typeof contents])).toEqual([
      { path: "src/Domain.cs", name: "Resolve", signature: "DomainExtensions.Resolve" },
      { path: "src/Domain.cs", name: "StableFingerprint", signature: "DomainExtensions.StableFingerprint" },
    ]);
  });
});
