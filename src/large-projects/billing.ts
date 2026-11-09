import { readFile } from "node:fs/promises";
import type { MeterCall, MeterUsage } from "./meter.ts";

export const RATE_CARD = {
  asOf: "2026-11-09",
  usdToRmb: 6.7188,
  openaiStandardUsdPerMillion: {
    "gpt-6-luna": { input: 0.1, read: 0.01, output: 0.5 },
    "gpt-6.1-sol": { input: 2, read: 0.1, output: 10 },
  },
  openaiLongThreshold: 272_000,
  openaiWrite30mMultiplier: 1.25,
  openaiWrite12hMultiplier: 2.5,
  deepSeekOffPeakRmbPerMillion: { input: 1, read: 0.02, output: 4 },
  deepSeekPeakMultiplier: 2,
  fxSource:
    "https://www.safe.gov.cn/AppStructured/hlw/RMBQuery.do?startDate=2026-11-09&endDate=2026-11-09&queryYN=true",
  openaiPrices: "https://developers.openai.com/api/docs/pricing",
  openaiCache: "https://developers.openai.com/api/docs/guides/prompt-caching",
  openaiCosts:
    "https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs",
  deepSeekPrices: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
  deepSeekBalance: "https://api-docs.deepseek.com/api/get-user-balance/",
  holidaySource:
    "https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm",
} as const;
const million = 1_000_000;
const usdRates = RATE_CARD.openaiStandardUsdPerMillion;
const longThreshold = RATE_CARD.openaiLongThreshold;

type Usage = MeterUsage & { cacheReadReported?: boolean };
type Call = Omit<MeterCall, "usage"> & {
  usage: Usage | null;
  requestedCacheTtl?: "30m" | "12h" | "mixed";
};
type RequestPrice = {
  knownRmb: number;
  upperRmb: number | null;
  tariff: string;
  note: string | null;
};
const unavailable = (note: string): RequestPrice => ({
  knownRmb: 0,
  upperRmb: null,
  tariff: "unpriced",
  note,
});
const count = (value: number) => Number.isSafeInteger(value) && value >= 0;

// Official 2026 holiday periods in local time. Weekends, including makeup
// workdays, stay off peak: DeepSeek explicitly limits peak prices to Mon–Fri.
const holidays2026 = [
  [101, 103],
  [215, 223],
  [404, 406],
  [501, 505],
  [619, 621],
  [925, 927],
  [1001, 1007],
];
export function deepSeekTier(iso: string): "peak" | "off-peak" | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const cn = new Date(ms + 8 * 3600 * 1000);
  if (cn.getUTCFullYear() !== 2026) return null;
  const day = cn.getUTCDay(),
    hour = cn.getUTCHours(),
    date = (cn.getUTCMonth() + 1) * 100 + cn.getUTCDate();
  const holiday = holidays2026.some(
    ([first, last]) => date >= first && date <= last,
  );
  return day >= 1 &&
    day <= 5 &&
    !holiday &&
    ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
    ? "peak"
    : "off-peak";
}

function deepSeekPrice(u: Usage, startedAt: string): RequestPrice {
  const period = deepSeekTier(startedAt);
  if (!period)
    return unavailable("No applicable 2026 Asia/Shanghai tariff period");
  const multiplier = period === "peak" ? RATE_CARD.deepSeekPeakMultiplier : 1;
  const cachedKnown = u.cacheReadReported !== false;
  const cached = cachedKnown ? u.cachedInputTokens : 0;
  const rates = RATE_CARD.deepSeekOffPeakRmbPerMillion;
  const output = rates.output * u.outputTokens;
  const upper =
    output + cached * rates.read + (u.inputTokens - cached) * rates.input;
  const lower = cachedKnown ? upper : output + u.inputTokens * rates.read;
  return {
    knownRmb: (lower * multiplier) / million,
    upperRmb: (upper * multiplier) / million,
    tariff: period,
    note: lower === upper ? null : "Cache-read tokens missing",
  };
}

function openaiPrice(
  model: keyof typeof usdRates,
  u: Usage,
  call: Call,
): RequestPrice {
  const tier = call.serviceTier ?? "default";
  const tierMultipliers: Record<string, number> = {
    default: 1,
    auto: 1,
    standard: 1,
    priority: 2,
    fast: 2,
    flex: 0.5,
    batch: 0.5,
  };
  if (model === "gpt-6.1-sol") tierMultipliers.ultrafast = 6;
  if (!Object.hasOwn(tierMultipliers, tier))
    return unavailable("No price for service tier " + tier);
  const long = u.inputTokens > longThreshold;
  const rates = usdRates[model];
  const miss = rates.input * (long ? 2 : 1),
    hit = rates.read * (long ? 2 : 1);
  const ttl = call.requestedCacheTtl ?? "30m";
  const write30 = u.cacheWrite30mTokens,
    write12 = u.cacheWrite12hTokens;
  const writeTotal =
    u.cacheWriteTokens ??
    (write30 !== undefined && write12 !== undefined
      ? write30 + write12
      : undefined);
  const reportedWrites = (write30 ?? 0) + (write12 ?? 0);
  const cachedKnown = u.cacheReadReported !== false;
  const cached = cachedKnown ? u.cachedInputTokens : 0;
  const assignedWrites = writeTotal ?? reportedWrites;
  if (
    assignedWrites < reportedWrites ||
    cached + assignedWrites > u.inputTokens ||
    (writeTotal !== undefined &&
      write30 !== undefined &&
      write12 !== undefined &&
      writeTotal !== reportedWrites)
  )
    return unavailable("Inconsistent provider cache counters");
  const unclassifiedWrites = assignedWrites - reportedWrites;
  const remaining = u.inputTokens - cached - assignedWrites;
  // If one TTL was reported and total writes is known, the remainder belongs
  // to the other TTL. Without TTL detail, the request default is 30 minutes.
  const shortPossible =
    write30 === undefined && (write12 !== undefined || ttl !== "12h");
  const longPossible =
    write12 === undefined && (write30 !== undefined || ttl !== "30m");
  const w30 = RATE_CARD.openaiWrite30mMultiplier,
    w12 = RATE_CARD.openaiWrite12hMultiplier;
  const minWrite = miss * (shortPossible ? w30 : w12);
  const maxWrite = miss * (longPossible ? w12 : w30);
  const fixed =
    cached * hit +
    (write30 ?? 0) * miss * w30 +
    (write12 ?? 0) * miss * w12 +
    u.outputTokens * rates.output * (long ? 1.5 : 1);
  const low =
    fixed +
    unclassifiedWrites * minWrite +
    remaining * (cachedKnown ? miss : hit);
  const high =
    fixed +
    unclassifiedWrites * maxWrite +
    remaining * (writeTotal === undefined ? Math.max(miss, maxWrite) : miss);
  const scale = (tierMultipliers[tier] * RATE_CARD.usdToRmb) / million;
  return {
    knownRmb: low * scale,
    upperRmb: high * scale,
    tariff: tier + "/" + (long ? "long" : "short"),
    note:
      low === high
        ? null
        : "Cache split missing; interval bounds the unclassified input",
  };
}

export function priceRequest(call: Call): RequestPrice {
  const u = call.usage;
  if (!u) return unavailable("HTTP attempt has no provider usage");
  if (
    ![
      u.inputTokens,
      u.outputTokens,
      u.cachedInputTokens,
      u.reasoningTokens,
      u.totalTokens,
      ...[
        u.cacheWriteTokens,
        u.cacheWrite30mTokens,
        u.cacheWrite12hTokens,
      ].filter((x): x is number => x !== undefined),
    ].every(count) ||
    u.cachedInputTokens > u.inputTokens ||
    u.reasoningTokens > u.outputTokens ||
    u.totalTokens !== u.inputTokens + u.outputTokens
  )
    return unavailable("Inconsistent provider usage");
  if (
    call.servedModel &&
    call.servedModel !== call.model &&
    !call.servedModel.startsWith(call.model + "-")
  )
    return unavailable(
      "Returned model differs from the requested priced model",
    );
  return call.model === "deepseek-flash"
    ? deepSeekPrice(u, call.startedAt)
    : openaiPrice(call.model, u, call);
}

export function priceRequests(calls: readonly Call[]) {
  const requests = calls.map(priceRequest);
  const unpricedCalls = requests.filter((r) => r.upperRmb === null).length;
  const estimatedCalls = requests.filter(
    (r) => r.upperRmb !== null && r.knownRmb !== r.upperRmb,
  ).length;
  return {
    knownRmb: requests.reduce((n, r) => n + r.knownRmb, 0),
    upperRmb: unpricedCalls
      ? null
      : requests.reduce((n, r) => n + r.upperRmb!, 0),
    complete: !unpricedCalls && !estimatedCalls,
    estimatedCalls,
    unpricedCalls,
    requests,
  };
}

interface BalanceRecord {
  currency: string;
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}
// Only the difference is suitable for exporting. Keep both snapshots in
// process memory and require the CNY wallet used by this benchmark.
interface BalanceSnapshot {
  at: string;
  record: BalanceRecord | null;
  error: string | null;
}
export async function captureDeepSeekBalance(): Promise<BalanceSnapshot> {
  const at = new Date().toISOString();
  try {
    const path = process.env.DEEPSEEK_KEY_FILE;
    const key = (
      path ? await readFile(path, "utf8") : process.env.DEEPSEEK_API_KEY
    )?.trim();
    if (!key)
      return { at, record: null, error: "Missing DeepSeek API credentials" };
    const response = await fetch("https://api.deepseek.com/user/balance", {
      redirect: "error",
      headers: { Authorization: "Bearer " + key },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      return {
        at,
        record: null,
        error: "DeepSeek balance HTTP " + response.status,
      };
    const payload = (await response.json()) as {
      balance_infos?: BalanceRecord[];
    };
    const records = payload.balance_infos ?? [];
    if (records.length !== 1 || records[0].currency !== "CNY")
      return { at, record: null, error: "Expected one CNY balance wallet" };
    const record = records[0];
    for (const value of [
      record.total_balance,
      record.granted_balance,
      record.topped_up_balance,
    ])
      if (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value))
        return { at, record: null, error: "Malformed wallet balance" };
    return { at, record, error: null };
  } catch {
    return {
      at,
      record: null,
      error: "DeepSeek balance endpoint or credential unavailable",
    };
  }
}
function decimalDifference(a: string, b: string) {
  const digits = Math.max(
    a.split(".")[1]?.length ?? 0,
    b.split(".")[1]?.length ?? 0,
  );
  const fixed = (s: string) => {
    const [whole, frac = ""] = s.split(".");
    return BigInt(whole + frac.padEnd(digits, "0"));
  };
  return Number(fixed(a) - fixed(b)) / 10 ** digits;
}
export function deepSeekBalanceChange(
  before: BalanceSnapshot,
  after: BalanceSnapshot,
) {
  const a = before.record,
    b = after.record;
  return {
    source: "DeepSeek account balance change",
    currency: "CNY",
    from: before.at,
    to: after.at,
    totalRmb:
      a && b ? decimalDifference(a.total_balance, b.total_balance) : null,
    toppedUpRmb:
      a && b
        ? decimalDifference(a.topped_up_balance, b.topped_up_balance)
        : null,
    grantedRmb:
      a && b ? decimalDifference(a.granted_balance, b.granted_balance) : null,
    error: before.error ?? after.error,
  };
}
