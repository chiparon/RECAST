import { describe, expect, it } from "vitest";
import type { ProjectModule } from "@forexplore/contracts";
import { buildModuleFunctionMapping, callableApiName, expandClassLevelFunctions } from "./module-function-mapping.js";

const target = (coreApis: string[], sourceFiles = ["src/OrderService.cs", "src/PriceRule.cs"]): ProjectModule => ({
  id: "target", name: "Orders", kind: "feature", description: "orders", sourceFiles, coreApis,
  symbolKeys: [], dependsOn: [], evidenceIds: [],
});

describe("module function mapping", () => {
  it("expands class-level C# APIs to coverage-addressable methods", () => {
    const result = expandClassLevelFunctions(
      [{ path: "src/Telemetry.cs", name: "TraceFactory" }],
      () => `public sealed class TraceFactory { public TraceScope Start(string traceId, string operation) { return null; } }`,
    );
    expect(result).toEqual([{
      path: "src/Telemetry.cs",
      name: "Start",
      signature: "TraceFactory.Start(string traceId, string operation)",
    }]);
  });

  it("drops an incomplete qualified signature so coverage can match the method", () => {
    expect(expandClassLevelFunctions(
      [{ path: "src/Telemetry.cs", name: "CheckAsync", signature: "AssetUpgradeGateway.Telemetry.MetricsHealthProbe.CheckAsync" }],
      () => undefined,
    )).toEqual([{ path: "src/Telemetry.cs", name: "CheckAsync" }]);
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
});
