import { asset, noise, type Scenario } from "./types.js";
export default {
  id: "s08-cross-repo-federation",
  assets: [
    asset(
      "breaker",
      "CircuitBreaker",
      "Circuit breaker when consecutive failures exceed limit",
      `export function CircuitBreaker(failures:number){return failures>=3;}`,
      { repo: 0 },
    ),
    asset(
      "replay",
      "ReplayGuard",
      "Idempotent replay detection",
      `def replay_guard(seen, key):\n    return key in seen\n`,
      { repo: 1, language: "Python" },
    ),
    asset(
      "delay",
      "DelayedQueue",
      "Delayed queue retry due calculation",
      `export function DelayedQueue(now:number,failures:number){return now+Math.min(8000,1000*2**failures);}`,
      { repo: 2 },
    ),
    ...noise(3, "resilience monitor").map((a, i) => ({ ...a, repo: i + 3 })),
  ],
  units: [
    {
      name: "ResilienceGateway",
      query: "circuit breaker；idempotent replay guard；delayed queue retry",
      contract:
        'Export run(id,seen,failures,now). seen is a string array. Replay takes precedence: return {state:"replay"} for a seen ID. At >=3 failures return {state:"open"}. Else return {state:"queued",due:now+min(8000,1000*2**failures)}.',
      required: ["breaker", "replay", "delay"],
      test: `assert.deepEqual(run('x',['x'],3,10),{state:'replay'});assert.deepEqual(run('x',[],3,10),{state:'open'});assert.deepEqual(run('x',[],2,100),{state:'queued',due:4100});`,
    },
  ],
} satisfies Scenario;
