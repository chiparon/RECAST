import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { priceRequests } from "./billing.ts";
import type { MeterCall } from "./meter.ts";

export interface CostRun {
  id: string;
  model: string;
  passed?: boolean;
  failureReason?: string | null;
  purpose?: string;
  calls: MeterCall[];
  balanceChange?: {
    totalRmb: number | null;
    from?: string;
    to?: string;
    toppedUpRmb?: number | null;
    grantedRmb?: number | null;
    error?: string | null;
  } | null;
}
interface CostFile {
  runs: CostRun[];
  note?: string;
}
interface PilotFile extends CostFile {
  batch: "large-v1" | "large-v2";
  wallets?: {
    cells: string[];
    closing: NonNullable<CostRun["balanceChange"]>;
    after30s: NonNullable<CostRun["balanceChange"]>;
  }[];
}
export async function loadSetup(): Promise<CostFile | null> {
  try {
    const data: CostFile = JSON.parse(
      await readFile(resolve("results", "large-setup.json"), "utf8"),
    );
    assert(Array.isArray(data.runs), "Malformed setup meter");
    return data;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
/** Omit worktree paths, response content, raw errors, tools, and wallet balances. */
export async function loadPilot(
  batch: "large-v1" | "large-v2" = "large-v1",
): Promise<PilotFile | null> {
  const network = batch === "large-v2";
  const dir = resolve("results", "large-project-bench", batch),
    archive = resolve(
      "results",
      network ? "large-v2-network.json" : "large-v1-pilot.json",
    );
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const records = entries.filter((p) => p.endsWith(".trial.json")).sort();
  if (!records.length) {
    try {
      return JSON.parse(await readFile(archive, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  assert(
    !entries.some((p) => p.endsWith(".lock")),
    "Wait for active pilot trials before freezing pilot costs",
  );
  const runs = await Promise.all(
    records.map(async (p) => {
      const row = JSON.parse(await readFile(join(dir, p), "utf8"));
      assert.equal(row.batch, batch);
      const calls: MeterCall[] = row.calls.map((c: MeterCall) => ({
        turn: c.turn,
        attempt: c.attempt,
        model: c.model,
        servedModel: c.servedModel,
        responseId: c.responseId,
        httpStatus: c.httpStatus,
        status: c.status,
        ...(network &&
          c.status === "error" && {
            error: c.httpStatus
              ? "HTTP " + c.httpStatus
              : "Transport failed before response",
          }),
        elapsedMs: c.elapsedMs,
        tools: [],
        startedAt: c.startedAt,
        serviceTier: c.serviceTier,
        requestedCacheTtl: c.requestedCacheTtl,
        usage: c.usage,
      }));
      const b = row.balanceChange;
      return {
        id: p.slice(0, -".trial.json".length),
        model: row.model,
        arm: row.arm,
        task: row.task,
        inputHash: row.inputHash,
        startedAt: row.startedAt,
        passed: row.passed,
        hadCommit: Boolean(row.commit),
        failedChecks:
          row.grade?.checks.filter((c) => !c.passed).map((c) => c.id) ?? [],
        failureReason: row.passed
          ? null
          : /EPERM/i.test(row.error ?? "")
            ? "Windows EPERM"
            : network &&
                /fetch failed|network|connect|socket|timed? ?out/i.test(
                  row.error ?? "",
                )
              ? "provider transport"
              : row.error
                ? "method failed"
                : "external acceptance",
        calls,
        balanceChange: b
          ? {
              from: b.from,
              to: b.to,
              totalRmb: b.totalRmb,
              toppedUpRmb: b.toppedUpRmb,
              grantedRmb: b.grantedRmb,
              error: b.error,
            }
          : null,
        price: priceRequests(calls),
      };
    }),
  );
  const out: PilotFile = {
    batch,
    note: network
      ? "两家供应商的连接同时出现故障后停止派发，保留已启动的试验及已知费用下界。"
      : "Windows 文件替换故障后停止派发新任务，保留当时已开始的试验。",
    runs,
    ...(network && {
      wallets: await Promise.all(
        entries
          .filter((p) => p.endsWith(".wallet.json"))
          .sort()
          .map(async (p) => JSON.parse(await readFile(join(dir, p), "utf8"))),
      ),
    }),
  };
  const canonical = JSON.stringify(out, null, 2) + "\n";
  try {
    assert.equal(
      await readFile(archive, "utf8"),
      canonical,
      "Frozen pilot ledger changed",
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    await writeFile(archive, canonical, { flag: "wx" });
  }
  return out;
}
export function costTotal(runs: CostRun[]) {
  const calls = runs.flatMap((r) => r.calls),
    price = priceRequests(calls);
  const windows = runs.flatMap((r) =>
    r.balanceChange?.totalRmb == null ? [] : [r.balanceChange.totalRmb],
  );
  return {
    runs: runs.length,
    requests: calls.length,
    tokens: calls.reduce((n, c) => n + (c.usage?.totalTokens ?? 0), 0),
    missingUsage: calls.filter((c) => !c.usage).length,
    lowerRmb: price.knownRmb,
    upperRmb: price.upperRmb,
    balanceWindows: windows.length,
    walletRmb: windows.length ? windows.reduce((a, b) => a + b, 0) : null,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const selected = process.argv[2] ?? "large-v1";
  assert(selected === "large-v1" || selected === "large-v2");
  const pilot = await loadPilot(selected);
  if (!pilot) throw Error("No completed " + selected + " pilot");
  console.log(JSON.stringify(costTotal(pilot.runs)));
}
