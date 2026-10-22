import { describe, expect, it, vi } from "vitest";
import { HttpWorkspaceEvidencePort } from "./http-workspace-evidence-port";

const scope = { repositoryId: "history-1", analysisRevision: "revision-1", projectId: "project-1" };

function hit(id: string) {
  return {
    repositoryId: scope.repositoryId,
    analysisRevision: scope.analysisRevision,
    evidenceId: id,
    relativePath: "src/AssetPolicy.cs",
    value: {
      name: id,
      relativePath: "src/AssetPolicy.cs",
      sourceRange: { startLine: 1, startColumn: 1, endLine: 3, endColumn: 1 },
    },
  };
}

describe("HttpWorkspaceEvidencePort", () => {
  it("splits natural-language requirements into concrete symbol searches", async () => {
    const requests: Array<{ url: string; body: any }> = [];
    const fetcher = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      requests.push({ url: String(url), body });
      if (String(url).endsWith("/searchSymbols")) {
        return new Response(JSON.stringify({ symbols: body.query === "AssetAggregate" ? [hit("asset-1")] : [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ excerpt: { ...hit("asset-1"), value: { text: "class AssetAggregate {}", truncated: false } } }), { status: 200 });
    });
    const port = new HttpWorkspaceEvidencePort({ endpoint: "http://127.0.0.1:8790", fetch: fetcher as unknown as typeof fetch });

    const result = await port.query({ requirement: "AssetAggregate tenant retry behavior", limit: 1, scopes: [scope] });

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.content).toContain("AssetAggregate");
    const searchBodies = requests.filter((request) => request.url.endsWith("/searchSymbols")).map((request) => request.body);
    expect(searchBodies.length).toBeGreaterThan(0);
    expect(searchBodies.every((body) => body.query !== "AssetAggregate tenant retry behavior")).toBe(true);
    expect(searchBodies.some((body) => body.query === "AssetAggregate")).toBe(true);
    expect(searchBodies[0]!.projectIds).toEqual(["project-1"]);
  });

  it("returns an explicit no-match note instead of an empty ambiguous result", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ symbols: [] }), { status: 200 }));
    const port = new HttpWorkspaceEvidencePort({ endpoint: "http://127.0.0.1:8790", fetch: fetcher as unknown as typeof fetch });

    const result = await port.query({ requirement: "missing symbol behavior", limit: 2, scopes: [scope] });

    expect(result.evidence).toEqual([]);
    expect(result.notes?.some((note) => note.startsWith("NO_MATCHING_HISTORY_SYMBOLS:"))).toBe(true);
  });
});
