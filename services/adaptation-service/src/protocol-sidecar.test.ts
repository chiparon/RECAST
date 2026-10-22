import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureGlobalProtocol,
  mergeGlobalProtocol,
  normaliseGlobalProtocol,
  persistGlobalProtocol,
  projectModuleProtocol,
  recordProtocolChecks,
  protocolTaskIdentity,
} from "./protocol-sidecar";

describe("protocol sidecar", () => {
  it("normalises unknown source/status safely and strips unrelated fields", () => {
    const protocol = normaliseGlobalProtocol({
      evaluator: "must never be retained",
      invariants: [{ id: "scan", rule: "scan first", source: "evaluator", status: "maybe", secret: "x" }],
      boundaries: [{ id: "attachment", module: "attachments", responsibility: "owns state", source: "requirement", status: "fixed" }],
      sharedContracts: [{ id: "tenant", name: "TenantId", source: "skeleton", status: "fixed" }],
      openQuestions: [{ id: "q", question: "when to emit?", source: "observed", status: "unknown" }],
    }, "task-a");
    expect(protocol.invariants[0]).toMatchObject({ source: "observed", status: "ambiguous" });
    expect(JSON.stringify(protocol)).not.toContain("evaluator");
    expect(JSON.stringify(protocol)).not.toContain("secret");
    expect(protocol.openQuestions[0]?.status).toBe("ambiguous");
  });

  it("generates deterministic task identities and preserves conflicts during merge", () => {
    expect(protocolTaskIdentity({ taskId: "a", targetLanguage: "C#" }))
      .toBe(protocolTaskIdentity({ taskId: "a", targetLanguage: "C#" }));
    const first = normaliseGlobalProtocol({ invariants: [{ id: "same", rule: "one", source: "requirement", status: "fixed" }] });
    const merged = mergeGlobalProtocol(first, { invariants: [{ id: "same", rule: "two", source: "observed", status: "proposed" }] }, "task-a");
    expect(merged.invariants).toHaveLength(2);
    expect(merged.invariants.find(item => item.id === "same")?.status).toBe("fixed");
    expect(merged.invariants.some(item => item.status === "conflict")).toBe(true);
  });

  it("projects global rules by direct module scope with a bounded deterministic view", () => {
    const protocol = normaliseGlobalProtocol({
      invariants: [
        { id: "global", rule: "tenant isolation", source: "requirement", status: "fixed" },
        { id: "other", rule: "unrelated", source: "requirement", status: "fixed", scope: ["orders"] },
      ],
      boundaries: [
        { id: "attachment", module: "attachments", responsibility: "owns state", source: "skeleton", status: "fixed" },
        { id: "order", module: "orders", responsibility: "owns orders", source: "skeleton", status: "fixed" },
      ],
      sharedContracts: [{ id: "tenant-id", name: "TenantId", source: "skeleton", status: "fixed", scope: ["attachments"] }],
    });
    const view = projectModuleProtocol(protocol, { moduleId: "attachments", maxEntries: 3 });
    expect(view.moduleId).toBe("attachments");
    expect(view.invariants.map(item => item.id)).toEqual(["global"]);
    expect(view.boundaries.map(item => item.id)).toEqual(["attachment"]);
    expect(view.sharedContracts.map(item => item.id)).toEqual(["tenant-id"]);
    expect(projectModuleProtocol(protocol, { moduleId: "attachments", maxEntries: 3 })).toEqual(view);
  });

  it("retains failed feedback on the same rule without rewriting its original fact", () => {
    const base = normaliseGlobalProtocol({ invariants: [{ id: "state", rule: "validate before publish", scope: ["producer", "consumer"], source: "requirement", status: "fixed" }] });
    const patch = { invariants: [{ rule: "validate before publish", scope: ["producer", "consumer"], source: "observed", status: "conflict", note: "public call published before validation" }] };
    const merged = mergeGlobalProtocol(base, patch, "feedback-task");
    expect(merged.invariants).toHaveLength(2);
    expect(merged.invariants.find(entry => entry.id === "state")?.status).toBe("fixed");
    expect(merged.invariants.find(entry => entry.status === "conflict")?.note).toContain("before validation");
    expect(mergeGlobalProtocol(merged, patch, "feedback-task")).toEqual(merged);
  });

  it("does not match unrelated module IDs through a shared prefix or word", () => {
    const protocol = normaliseGlobalProtocol({ invariants: [
      { id: "upload", rule: "validate before storage", scope: ["lang-upload"], source: "requirement", status: "fixed" },
      { id: "global", rule: "preserve public contracts", scope: ["all modules"], source: "requirement", status: "fixed" },
    ] });
    expect(projectModuleProtocol(protocol, { moduleId: "lang-delivery", moduleName: "Delivery module" }).invariants.map(entry => entry.id)).toEqual(["global"]);
    expect(projectModuleProtocol(protocol, { moduleId: "lang-app", relatedModules: ["lang-upload"] }).invariants.map(entry => entry.id)).toContain("upload");
  });

  it("routes verifier feedback by original section and preserves contract metadata", () => {
    const base = normaliseGlobalProtocol({
      invariants: [{ id: "gate", rule: "validate before publish", source: "observed", status: "proposed" }],
      boundaries: [{ id: "owner", module: "producer", responsibility: "owns shared state", source: "skeleton", status: "fixed", scope: ["producer", "consumer"] }],
      sharedContracts: [{ id: "shared", name: "ItemIdentity", fields: ["tenant", "id"], rule: "preserve identity", source: "observed", status: "proposed", scope: ["producer", "consumer"] }],
    });
    const passed = recordProtocolChecks(base, [
      { ruleId: "shared", status: "passed", testName: "public identity roundtrip" },
      { ruleId: "owner", status: "failed", note: "consumer uses separate state" },
      { ruleId: "gate", status: "passed" },
    ], "consumer");
    expect(passed.invariants).toHaveLength(1);
    expect(passed.invariants[0]).toMatchObject({ id: "gate", status: "verified" });
    expect(passed.invariants[0].scope).toBeUndefined();
    expect(passed.sharedContracts).toHaveLength(1);
    expect(passed.sharedContracts[0]).toMatchObject({ id: "shared", name: "ItemIdentity", fields: ["tenant", "id"], rule: "preserve identity", status: "verified", scope: ["producer", "consumer"] });
    expect(passed.boundaries).toHaveLength(2);
    expect(passed.boundaries.find(entry => entry.status === "conflict")?.responsibility).toBe("owns shared state");
    const failed = recordProtocolChecks(passed, [{ ruleId: "shared", status: "failed", note: "identity mismatch" }], "consumer");
    expect(failed.sharedContracts).toHaveLength(2);
    expect(failed.sharedContracts.find(entry => entry.status === "conflict")).toMatchObject({ name: "ItemIdentity", fields: ["tenant", "id"], rule: "preserve identity", scope: ["producer", "consumer"] });
    expect(failed.invariants).toHaveLength(1);
    expect(recordProtocolChecks(failed, [{ ruleId: "shared", status: "failed", note: "identity mismatch" }], "consumer")).toEqual(failed);
    expect(recordProtocolChecks(base, undefined, "consumer")).toBe(base);
    expect(recordProtocolChecks(base, [{ ruleId: "unknown", status: "passed" }, { ruleId: "shared", status: "not-applicable" }], "consumer")).toEqual(base);
  });

  it("keeps handoffs, shared state and questions visible among many invariants", () => {
    const protocol = normaliseGlobalProtocol({
      invariants: Array.from({ length: 30 }, (_, index) => ({ id: `rule-${index}`, rule: `rule ${index}`, scope: ["producer"], source: "requirement", status: "fixed" })),
      boundaries: [{ id: "handoff", module: "producer", interface: "ReadyItem", responsibility: "publishes to consumer", scope: ["producer", "consumer"], source: "skeleton", status: "fixed" }],
      sharedContracts: [{ id: "state", name: "ReadyItem", rule: "consumer requires ready state", scope: ["producer", "consumer"], source: "requirement", status: "fixed" }],
      openQuestions: [{ id: "order", question: "which side owns retry after persistence failure?", scope: ["producer", "consumer"], source: "observed", status: "open" }],
    });
    const producer = projectModuleProtocol(protocol, { moduleId: "producer" });
    expect(producer.invariants.length + producer.boundaries.length + producer.sharedContracts.length + producer.openQuestions.length).toBe(10);
    expect(producer.boundaries.map(entry => entry.id)).toEqual(["handoff"]);
    expect(producer.sharedContracts.map(entry => entry.id)).toEqual(["state"]);
    expect(producer.openQuestions.map(entry => entry.id)).toEqual(["order"]);
    const consumer = projectModuleProtocol(protocol, { moduleId: "consumer" });
    expect(consumer.invariants).toEqual([]);
    expect(consumer.boundaries.map(entry => entry.id)).toEqual(["handoff"]);
    expect(consumer.sharedContracts.map(entry => entry.id)).toEqual(["state"]);
    expect(projectModuleProtocol(protocol, { moduleId: "producer", maxEntries: 0 }).invariants).toEqual([]);
  });

  it("initialises and writes best-effort task output without blocking callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "protocol-sidecar-"));
    try {
      const initial = await ensureGlobalProtocol(root, "task-a");
      expect(initial.created).toBe(true);
      expect(initial.persisted).toBe(true);
      expect(JSON.parse(await readFile(join(root, "global-protocol.json"), "utf8"))).toEqual({
        version: 1, invariants: [], boundaries: [], sharedContracts: [], openQuestions: [],
      });
      expect(await persistGlobalProtocol(join(root, "global-protocol.json"), {
        ...initial.protocol,
        invariants: [{ id: "x", rule: "r", source: "requirement", status: "fixed" }],
      })).toBe(true);
      const loaded = await ensureGlobalProtocol(root, "task-a");
      expect(loaded.created).toBe(false);
      expect(loaded.protocol.invariants[0]?.id).toBe("x");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
