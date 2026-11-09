import test from "node:test";
import assert from "node:assert/strict";
import {
  deepSeekBalanceChange,
  deepSeekTier,
  priceRequest,
  priceRequests,
  RATE_CARD,
} from "./billing.ts";
import type { MeterCall } from "./meter.ts";

function call(
  model: MeterCall["model"],
  input: number,
  cached: number,
  output: number,
): MeterCall {
  return {
    model,
    servedModel: model,
    startedAt: "2026-11-09T13:00:00Z",
    serviceTier: "default",
    usage: {
      inputTokens: input,
      cachedInputTokens: cached,
      totalTokens: input + output,
      outputTokens: output,
      reasoningTokens: 0,
    },
    turn: 1,
    attempt: 1,
    status: "ok",
    elapsedMs: 50,
    tools: [],
  };
}
function near(a: number | null, b: number) {
  assert(a !== null && Math.abs(a - b) < 1e-10, `${a} != ${b}`);
}

test("OpenAI reads, short/long writes, uncached input and output are mutually exclusive", () => {
  const c = call("gpt-6.1-sol", 12000, 4000, 2000);
  Object.assign(c.usage!, {
    cacheWriteTokens: 7000,
    cacheWrite30mTokens: 3000,
    cacheWrite12hTokens: 4000,
    reasoningTokens: 1700,
  });
  const expected =
    ((1000 * 2 + 4000 * 0.1 + 3000 * 2.5 + 4000 * 5 + 2000 * 10) *
      RATE_CARD.usdToRmb) /
    1e6;
  const bill = priceRequest(c);
  near(bill.knownRmb, expected);
  near(bill.upperRmb, expected);
});

test("OpenAI long-context cutoff applies to the entire call, independently of task length", () => {
  for (const input of [272000, 272001]) {
    const c = call("gpt-6-luna", input, 10000, 500);
    c.usage!.cacheWriteTokens = 20000;
    const long = input > 272000;
    near(
      priceRequest(c).knownRmb,
      (RATE_CARD.usdToRmb *
        ((input - 30000) * 0.1 + 10000 * 0.01 + 20000 * 0.125) *
        (long ? 2 : 1)) /
        1e6 +
        (RATE_CARD.usdToRmb * 500 * 0.5 * (long ? 1.5 : 1)) / 1e6,
    );
    assert.equal(priceRequests([c, c]).complete, true);
  }
});

test("Missing cache buckets and missing provider usage yield honest bounds", () => {
  const c = call("gpt-6.1-sol", 1000, 100, 10);
  const price = priceRequests([c]);
  near(
    price.knownRmb,
    ((100 * 0.1 + 900 * 2 + 10 * 10) * RATE_CARD.usdToRmb) / 1e6,
  );
  near(
    price.upperRmb,
    ((100 * 0.1 + 900 * 2.5 + 10 * 10) * RATE_CARD.usdToRmb) / 1e6,
  );
  assert.equal(price.estimatedCalls, 1);
  assert.equal(price.complete, false);
  const missing = priceRequests([c, { ...c, status: "error", usage: null }]);
  near(missing.knownRmb, price.knownRmb);
  assert.equal(missing.upperRmb, null);
  assert.equal(missing.unpricedCalls, 1);
  Object.assign(c.usage!, { cacheReadReported: false });
  near(
    priceRequest(c).knownRmb,
    ((1000 * 0.1 + 10 * 10) * RATE_CARD.usdToRmb) / 1e6,
  );
});

test("DeepSeek peak / off-peak uses Beijing time, weekends and holidays", () => {
  const monday = "2026-11-09T";
  for (const [time, expected] of [
    ["00:59:59Z", "off-peak"],
    ["01:00:00Z", "peak"],
    ["03:59:59Z", "peak"],
    ["04:00:00Z", "off-peak"],
    ["06:00:00Z", "peak"],
    ["10:00:00Z", "off-peak"],
  ])
    assert.equal(deepSeekTier(monday + time), expected);
  assert.equal(deepSeekTier("2026-11-08T02:00Z"), "off-peak");
  assert.equal(deepSeekTier("2026-10-01T02:00Z"), "off-peak");
  const c = call("deepseek-flash", 1000, 750, 100);
  near(priceRequest(c).knownRmb, (750 * 0.02 + 250 + 400) / 1e6);
  near(
    priceRequest({ ...c, startedAt: monday + "02:00:01Z" }).knownRmb,
    (2 * (750 * 0.02 + 250 + 400)) / 1e6,
  );
});

test("Account reconciliation exports only CNY differences at wallet precision", () => {
  const from = {
    at: "2026-11-09T13:00:00Z",
    error: null,
    record: {
      currency: "CNY",
      total_balance: "9.001001",
      granted_balance: "0.011001",
      topped_up_balance: "8.99",
    },
  };
  const to = {
    at: "2026-11-09T13:01:00Z",
    error: null,
    record: {
      currency: "CNY",
      total_balance: "8.987123",
      granted_balance: "0",
      topped_up_balance: "8.987123",
    },
  };
  const delta = deepSeekBalanceChange(from, to);
  assert.equal(delta.totalRmb, 0.013878);
  assert.equal(delta.grantedRmb, 0.011001);
  assert.equal(delta.toppedUpRmb, 0.002877);
  assert(!JSON.stringify(delta).includes("9.001001"));
  assert.equal(
    deepSeekBalanceChange(from, { ...to, record: null, error: "unavailable" })
      .totalRmb,
    null,
  );
});
