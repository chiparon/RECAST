import { describe, expect, it } from "vitest";
import type { WorkspaceTranslationRequest } from "@forexplore/contracts";
import { parseWorkspaceTranslationPlan, validateWorkspaceTranslationRequest, workspaceAnalyzerTools } from "./workspace-translation-agent";

const request: WorkspaceTranslationRequest = {
  spec: "Implement the module.", sourceLanguage: "Java", targetLanguage: "C#", context: [],
  workspaceFiles: ["src/Contracts.cs", "src/Service.cs"], writeFiles: ["src/Contracts.cs", "src/Service.cs"],
};

describe("workspace Analyzer plan compatibility", () => {
  it("accepts a whole-project integration inventory without changing module limits", () => {
    const files = Array.from({ length: 250 }, (_, index) => `src/File${index}.java`);
    expect(() => validateWorkspaceTranslationRequest({ ...request, taskKind: "project-integration", workspaceFiles: files, writeFiles: files })).not.toThrow();
    expect(() => validateWorkspaceTranslationRequest({ ...request, workspaceFiles: files, writeFiles: files })).toThrow("Invalid workspace translation request");
  });
  it("accepts an implementation plan without historical symbol mappings", () => {
    const plan = parseWorkspaceTranslationPlan({
      summary: "Implement the behavior directly.", mappings: [], dependencies: [],
      steps: [{ id: "service", description: "Implement the service.", files: ["src/Service.cs"], dependsOn: [] }],
    }, request);
    expect(plan.mappings).toEqual([]);
  });

  it("accepts file-level mappings with an empty or null target symbol", () => {
    const plan = parseWorkspaceTranslationPlan({
      summary: "Implement the files.",
      mappings: [
        { source: "history module", targetPath: "src\\Contracts.cs", targetSymbol: null },
        { source: "requirement", targetPath: "./src/Service.cs", targetSymbol: "" },
      ], dependencies: [],
      steps: [{ id: "all", description: "Implement both files.", files: ["src/Contracts.cs", "src/Service.cs"], dependsOn: [] }],
    }, request);
    expect(plan.mappings).toMatchObject([
      { targetPath: "src/Contracts.cs", targetSymbol: "" },
      { targetPath: "src/Service.cs", targetSymbol: "" },
    ]);
  });

  it("topologically orders steps even when the model lists a consumer first", () => {
    const plan = parseWorkspaceTranslationPlan({
      summary: "Implement in dependency order.", mappings: [], dependencies: [],
      steps: [
        { id: "service", description: "Implement the service.", files: ["src/Service.cs"], dependsOn: ["contracts"] },
        { id: "contracts", description: "Implement contracts.", files: ["src/Contracts.cs"], dependsOn: [] },
      ],
    }, request);
    expect(plan.steps.map(step => step.id)).toEqual(["contracts", "service"]);
  });

  it("rejects dependency cycles but accepts path spelling variants", () => {
    expect(() => parseWorkspaceTranslationPlan({
      summary: "Cycle.", mappings: [], dependencies: [],
      steps: [
        { id: "a", description: "A", files: ["src/Service.cs"], dependsOn: ["b"] },
        { id: "b", description: "B", files: ["src/Contracts.cs"], dependsOn: ["a"] },
      ],
    }, request)).toThrow("acyclic dependency graph");
  });

  it("allows bounded analysis annotations while keeping core fields required", () => {
    const submit = workspaceAnalyzerTools.find(tool => tool.name === "submit_plan")!;
    const properties = submit.inputSchema.properties as Record<string, { type?: unknown }>;
    expect(properties.evidence).toBeDefined();
    expect(properties.risks).toBeDefined();
    expect(properties.coverage).toBeDefined();
    expect(properties.confidence).toBeDefined();
    expect(properties.notes).toBeDefined();
    expect(submit.inputSchema.required).toEqual(["summary", "mappings", "dependencies", "steps"]);
  });

  it("still validates request paths before accepting the relaxed plan", () => {
    expect(() => validateWorkspaceTranslationRequest({ ...request, writeFiles: ["../outside.cs"] })).toThrow("Invalid workspace-relative");
  });
});
