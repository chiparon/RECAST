import { setTimeout as sleep } from "node:timers/promises";
import type { ProjectModel } from "../project-bench/providers.ts";

/** Probe only the service's public catalog, without an Authorization header. */
async function probe(
  model: ProjectModel,
  signal: AbortSignal,
): Promise<number> {
  const deepseek = model === "deepseek-flash";
  const endpoint = deepseek
    ? "https://api.deepseek.com/models"
    : "https://api.openai.com/v1/models";
  const res = await fetch(endpoint, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    redirect: "error",
    headers: { Accept: "application/json" },
  });
  // DeepSeek's governor currently returns this plain text response without a content type.
  const body = await res.text();
  if (
    res.status === 401 &&
    deepseek &&
    /^Authentication Fails(?:\s*\(governor\))?\s*$/i.test(body)
  )
    return 401;
  if (res.status === 200 || res.status === 401) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      /* Unexpected pages do not establish readiness. */
    }
    if (
      (res.status === 200 && Array.isArray(data?.data)) ||
      (res.status === 401 && data?.error && typeof data.error === "object")
    )
      return res.status;
  }
  throw Error("Unexpected catalog reply, HTTP " + res.status);
}

export async function waitForProvider(
  model: ProjectModel,
  signal?: AbortSignal,
) {
  const deadline = AbortSignal.timeout(15 * 60_000);
  const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const start = performance.now();
  let attempts = 0,
    consecutive = 0,
    failures = 0;
  try {
    for (;;) {
      active.throwIfAborted();
      attempts++;
      try {
        const status = await probe(model, active);
        if (++consecutive === 2) {
          const waitMs = Math.round(performance.now() - start);
          console.log(
            "ROUTE READY",
            model,
            "HTTP",
            status,
            attempts + " probes",
            waitMs + "ms",
          );
          return { attempts, waitMs, status };
        }
        failures = 0;
      } catch (error) {
        active.throwIfAborted();
        consecutive = 0;
        failures++;
        if (failures === 1 || failures % 5 === 0)
          console.log(
            "ROUTE WAIT",
            model,
            "probe",
            attempts,
            String(error).slice(0, 120),
          );
      }
      await sleep(
        consecutive ? 1000 : Math.min(30_000, failures * 5000),
        undefined,
        { signal: active },
      );
    }
  } catch (error) {
    if (deadline.aborted)
      throw Error(
        "Provider route did not become ready within 15 minutes: " + model,
      );
    throw error;
  }
}
