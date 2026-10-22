import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type {
  GlobalProtocol,
  GlobalProtocolPatch,
  ModuleProtocol,
  ProtocolBoundary,
  ProtocolInvariant,
  ProtocolOpenQuestion,
  ProtocolSharedContract,
  ProtocolSource,
  ProtocolStatus,
} from "@forexplore/contracts";
import { emptyGlobalProtocol } from "@forexplore/contracts";

/**
 * Protocol is an optional sidecar.  Callers should use the best-effort
 * functions below so a missing, stale, or unwritable sidecar never prevents a
 * normal module translation from running.
 */
const protocolFileName = "global-protocol.json";
const maxTextLength = 2_000;
const maxEntriesPerSection = 256;
const maxProtocolBytes = 64 * 1024;
const sourceValues = new Set<ProtocolSource>(["requirement", "skeleton", "observed", "module-confirmed"]);
const statusValues = new Set<ProtocolStatus>(["fixed", "verified", "proposed", "ambiguous", "conflict"]);
const sourceFallback: ProtocolSource = "observed";
const statusFallback: ProtocolStatus = "ambiguous";

export interface ProtocolTaskIdentityInput {
  taskId?: string;
  outputPath?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
}

export interface ProtocolLoadResult {
  path: string;
  protocol: GlobalProtocol;
  /** Present only when the sidecar could not be read or parsed. */
  error?: string;
}

export interface ProtocolEnsureResult extends ProtocolLoadResult {
  created: boolean;
  persisted: boolean;
}

export interface ModuleProtocolProjectionRequest {
  moduleId: string;
  moduleName?: string;
  /** Names of modules and interfaces directly touched by this module. */
  relatedModules?: string[];
  relatedInterfaces?: string[];
  sharedTypes?: string[];
  ownedFiles?: string[];
  /** Maximum total entries in the projected view. Defaults to ten. */
  maxEntries?: number;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const stringValue = (value: unknown, max = maxTextLength): string | undefined => {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result ? result.slice(0, max) : undefined;
};

const stringList = (value: unknown, max = 32): string[] => {
  if (!Array.isArray(value)) return [];
  const values: string[] = [];
  for (const item of value) {
    const text = stringValue(item, 300);
    if (text && !values.includes(text)) values.push(text);
    if (values.length >= max) break;
  }
  return values;
};

const sourceValue = (value: unknown): ProtocolSource =>
  typeof value === "string" && sourceValues.has(value as ProtocolSource) ? value as ProtocolSource : sourceFallback;

const statusValue = (value: unknown): ProtocolStatus =>
  typeof value === "string" && statusValues.has(value as ProtocolStatus) ? value as ProtocolStatus : statusFallback;

const questionStatus = (value: unknown): ProtocolOpenQuestion["status"] =>
  value === "open" || value === "resolved" || value === "ambiguous" || value === "conflict" ? value : "ambiguous";

function stableId(taskIdentity: string, category: string, value: unknown): string {
  const digest = createHash("sha256")
    .update(`${taskIdentity}\n${category}\n${JSON.stringify(value)}`)
    .digest("hex")
    .slice(0, 16);
  return `${category}-${digest}`;
}

/** A stable task identity suitable for generated protocol entry IDs. */
export function protocolTaskIdentity(input: string | ProtocolTaskIdentityInput): string {
  const raw = typeof input === "string"
    ? input.trim()
    : [input.taskId, input.outputPath, input.sourceLanguage, input.targetLanguage]
      .filter(value => typeof value === "string" && value.trim())
      .map(value => value!.trim())
      .join("|");
  return `task-${createHash("sha256").update(raw || "unnamed-task").digest("hex").slice(0, 16)}`;
}

function normaliseInvariant(value: unknown, index: number, identity: string): ProtocolInvariant | null {
  const item = asRecord(value);
  const rule = stringValue(item?.rule);
  if (!rule) return null;
  const scope = stringList(item?.scope);
  return {
    id: stringValue(item?.id, 200) ?? stableId(identity, "invariant", { rule, scope, index }),
    rule,
    source: sourceValue(item?.source),
    status: statusValue(item?.status),
    ...(scope.length ? { scope } : {}),
    ...(stringValue(item?.note) ? { note: stringValue(item?.note) } : {}),
  };
}

function normaliseBoundary(value: unknown, index: number, identity: string): ProtocolBoundary | null {
  const item = asRecord(value);
  const module = stringValue(item?.module, 300);
  const responsibility = stringValue(item?.responsibility);
  if (!module || !responsibility) return null;
  const scope = stringList(item?.scope);
  return {
    id: stringValue(item?.id, 200) ?? stableId(identity, "boundary", { module, responsibility, index }),
    module,
    responsibility,
    ...(stringValue(item?.interface, 300) ? { interface: stringValue(item?.interface, 300) } : {}),
    source: sourceValue(item?.source),
    status: statusValue(item?.status),
    ...(scope.length ? { scope } : {}),
    ...(stringValue(item?.note) ? { note: stringValue(item?.note) } : {}),
  };
}

function normaliseContract(value: unknown, index: number, identity: string): ProtocolSharedContract | null {
  const item = asRecord(value);
  const name = stringValue(item?.name, 300);
  if (!name) return null;
  const fields = stringList(item?.fields, 64);
  const rule = stringValue(item?.rule);
  const scope = stringList(item?.scope);
  return {
    id: stringValue(item?.id, 200) ?? stableId(identity, "contract", { name, fields, rule, scope, index }),
    name,
    ...(fields.length ? { fields } : {}),
    ...(rule ? { rule } : {}),
    source: sourceValue(item?.source),
    status: statusValue(item?.status),
    ...(scope.length ? { scope } : {}),
    ...(stringValue(item?.note) ? { note: stringValue(item?.note) } : {}),
  };
}

function normaliseQuestion(value: unknown, index: number, identity: string): ProtocolOpenQuestion | null {
  const item = asRecord(value);
  const question = stringValue(item?.question);
  if (!question) return null;
  const scope = stringList(item?.scope);
  return {
    id: stringValue(item?.id, 200) ?? stableId(identity, "question", { question, scope, index }),
    question,
    source: sourceValue(item?.source),
    status: questionStatus(item?.status),
    ...(scope.length ? { scope } : {}),
    ...(stringValue(item?.note) ? { note: stringValue(item?.note) } : {}),
  };
}

function bounded<T>(values: T[], max = maxEntriesPerSection): T[] {
  return values.slice(0, Math.max(0, Math.min(maxEntriesPerSection, Math.floor(max))));
}

/** Parse and sanitise untrusted JSON while retaining only the protocol schema. */
export function normaliseGlobalProtocol(value: unknown, taskIdentity = "unnamed-task"): GlobalProtocol {
  const item = asRecord(value);
  const identity = protocolTaskIdentity(taskIdentity);
  const protocol: GlobalProtocol = {
    version: 1,
    invariants: bounded((Array.isArray(item?.invariants) ? item.invariants : [])
      .map((entry, index) => normaliseInvariant(entry, index, identity)).filter((entry): entry is ProtocolInvariant => Boolean(entry))),
    boundaries: bounded((Array.isArray(item?.boundaries) ? item.boundaries : [])
      .map((entry, index) => normaliseBoundary(entry, index, identity)).filter((entry): entry is ProtocolBoundary => Boolean(entry))),
    sharedContracts: bounded((Array.isArray(item?.sharedContracts) ? item.sharedContracts : [])
      .map((entry, index) => normaliseContract(entry, index, identity)).filter((entry): entry is ProtocolSharedContract => Boolean(entry))),
    openQuestions: bounded((Array.isArray(item?.openQuestions) ? item.openQuestions : [])
      .map((entry, index) => normaliseQuestion(entry, index, identity)).filter((entry): entry is ProtocolOpenQuestion => Boolean(entry))),
  };
  // A task protocol is intentionally small.  Drop the least recent entries
  // first if an untrusted sidecar is unexpectedly large.
  while (JSON.stringify(protocol).length > maxProtocolBytes) {
    const section = ["openQuestions", "sharedContracts", "boundaries", "invariants"]
      .map(name => ({ name, length: (protocol[name as keyof GlobalProtocol] as unknown[]).length }))
      .sort((a, b) => b.length - a.length)[0];
    if (!section?.length) break;
    (protocol[section.name as keyof GlobalProtocol] as unknown[]).pop();
  }
  return protocol;
}

const entryKey = (entry: unknown): string => JSON.stringify(entry);

function semanticEntryKey(category: string, entry: Record<string, unknown>): string {
  if (category === "invariant") return JSON.stringify([entry.rule, entry.scope ?? []]);
  if (category === "boundary") return JSON.stringify([entry.module, entry.responsibility, entry.interface ?? "", entry.scope ?? []]);
  if (category === "contract") return JSON.stringify([entry.name, entry.rule ?? "", entry.fields ?? [], entry.scope ?? []]);
  return JSON.stringify([entry.question, entry.scope ?? []]);
}

const statusRank: Record<string, number> = { conflict: 0, ambiguous: 1, proposed: 2, open: 2, observed: 2, resolved: 3, verified: 4, fixed: 5 };

function mergeEntries<T extends { id: string; status: string }>(
  existing: T[], incoming: T[], identity: string, category: string,
): T[] {
  const result = [...existing];
  for (const candidate of incoming) {
    const sameId = result.find(item => item.id === candidate.id);
    const candidateKey = semanticEntryKey(category, candidate as unknown as Record<string, unknown>);
    const sameSemantic = result.find(item => semanticEntryKey(category, item as unknown as Record<string, unknown>) === candidateKey);
    if (sameSemantic) {
      // A failed check describes the same rule, but contradicts its success
      // claim. Retain it beside the original instead of deduplicating it away.
      if (candidate.status === "conflict" && sameSemantic.status !== "conflict") {
        const conflict = { ...candidate, id: stableId(identity, `${category}-conflict`, candidate) } as T;
        if (!result.some(item => entryKey(item) === entryKey(conflict))) result.push(conflict);
        continue;
      }
      // A later verifier/translator may confirm an existing rule.  Upgrade
      // its status in place while preserving the original ID and source.
      if ((statusRank[candidate.status] ?? 0) > (statusRank[sameSemantic.status] ?? 0)) {
        (sameSemantic as T & { status: string }).status = candidate.status;
      }
      if (entryKey(sameSemantic) === entryKey(candidate) || sameSemantic === sameId) continue;
      continue;
    }
    if (!sameId) { result.push(candidate); continue; }
    if (entryKey(sameId) === entryKey(candidate)) continue;
    // Never overwrite an earlier fact.  Preserve the new observation as an
    // explicit conflict so the Integration Agent can decide later.
    const conflict = { ...candidate, id: stableId(identity, `${category}-conflict`, candidate), status: "conflict" } as T;
    if (!result.some(item => entryKey(item) === entryKey(conflict))) result.push(conflict);
  }
  return bounded(result);
}

/** Merge model/host updates without deleting or silently rewriting old facts. */
export function mergeGlobalProtocol(
  base: GlobalProtocol | unknown,
  patch: GlobalProtocolPatch | unknown,
  taskIdentity = "unnamed-task",
): GlobalProtocol {
  const identity = protocolTaskIdentity(taskIdentity);
  const current = normaliseGlobalProtocol(base, identity);
  const update = normaliseGlobalProtocol(patch, identity);
  return {
    version: 1,
    invariants: mergeEntries(current.invariants, update.invariants, identity, "invariant"),
    boundaries: mergeEntries(current.boundaries, update.boundaries, identity, "boundary"),
    sharedContracts: mergeEntries(current.sharedContracts, update.sharedContracts, identity, "contract"),
    openQuestions: mergeEntries(current.openQuestions, update.openQuestions, identity, "question"),
  };
}

/** The verifier's optional feedback shape; no dependency on verifier internals. */
export interface ModuleProtocolCheck {
  ruleId: string;
  status: "passed" | "failed" | "ambiguous" | "not-applicable";
  testName?: string;
  note?: string;
}

/** Retain each checked entry in its original section, with its identity and
 * scope. Shared contracts may contain rule, so field-based classification is
 * insufficient. Feedback stays advisory and never blocks translation. */
export function recordProtocolChecks(
  protocol: GlobalProtocol,
  checks: readonly ModuleProtocolCheck[] | undefined,
  moduleId: string,
): GlobalProtocol {
  if (!checks?.length) return protocol;
  const patch: GlobalProtocolPatch = { invariants: [], boundaries: [], sharedContracts: [], openQuestions: [] };
  for (const check of checks.slice(0, 3)) {
    if (check.status === "ambiguous") {
      patch.openQuestions!.push({
        id: stableId(protocolTaskIdentity(moduleId), "question", { ruleId: check.ruleId, moduleId }),
        question: `Protocol rule ${check.ruleId} could not be established through the module public API.`,
        scope: [moduleId], source: "observed", status: "ambiguous", note: check.note,
      });
      continue;
    }
    if (check.status !== "passed" && check.status !== "failed") continue;
    for (const section of ["invariants", "boundaries", "sharedContracts"] as const) {
      const existing = protocol[section].find(entry => entry.id === check.ruleId);
      if (!existing) continue;
      const update = {
        ...existing,
        source: check.status === "passed" ? "module-confirmed" as const : "observed" as const,
        status: check.status === "passed" ? "verified" as const : "conflict" as const,
        note: check.note ?? `Verifier ${check.status}${check.testName ? `: ${check.testName}` : ""}`,
      };
      // Dispatch by the section where the rule ID was found, never by whether
      // its payload happens to contain a rule or other optional field.
      if (section === "invariants") patch.invariants!.push(update as ProtocolInvariant);
      else if (section === "boundaries") patch.boundaries!.push(update as ProtocolBoundary);
      else patch.sharedContracts!.push(update as ProtocolSharedContract);
      break;
    }
  }
  return mergeGlobalProtocol(protocol, patch, protocolTaskIdentity(moduleId));
}

const norm = (value: string): string => value.trim().toLowerCase().replaceAll("\\", "/");

function projectionTokens(input: ModuleProtocolProjectionRequest): Set<string> {
  const values = [input.moduleId, input.moduleName, ...(input.relatedModules ?? []), ...(input.relatedInterfaces ?? []),
    ...(input.sharedTypes ?? []), ...(input.ownedFiles ?? [])]
    .filter((value): value is string => Boolean(value)).map(norm);
  const tokens = new Set(values);
  // IDs are opaque: shared language/package words do not establish relevance.
  // File stems can identify public types without splitting module IDs or names.
  for (const file of input.ownedFiles ?? []) {
    const path = norm(file);
    tokens.add(basename(path, extname(path)));
  }
  return tokens;
}

const globalScope = (value: string): boolean => ["*", "all", "all modules"].includes(norm(value));

function scopeMatches(scope: readonly string[] | undefined, tokens: Set<string>): boolean {
  if (!scope?.length) return true;
  return scope.some(value => globalScope(value) || tokens.has(norm(value)));
}

function score(status: string, direct: boolean, category: string): number {
  const categoryWeight = category === "invariant" ? 4 : category === "boundary" || category === "contract" ? 3 : 1;
  const statusWeight = status === "fixed" || status === "verified" ? 3 : status === "proposed" ? 2 : status === "ambiguous" ? 1 : 0;
  return categoryWeight + statusWeight + (direct ? 3 : 0);
}

/** Produce a small, deterministic module view.  This is advisory only. */
export function projectModuleProtocol(
  protocol: GlobalProtocol | unknown,
  input: ModuleProtocolProjectionRequest,
): ModuleProtocol {
  const identity = protocolTaskIdentity(input.moduleId);
  const global = normaliseGlobalProtocol(protocol, identity);
  const tokens = projectionTokens(input);
  const ownTokens = projectionTokens({ ...input, relatedModules: [] });
  const directlyScoped = (scope: string[] | undefined): boolean => Boolean(scope?.some(value => ownTokens.has(norm(value))));
  type Candidate = { category: "invariant" | "boundary" | "contract" | "question"; value: ProtocolInvariant | ProtocolBoundary | ProtocolSharedContract | ProtocolOpenQuestion; direct: boolean };
  const candidates: Candidate[] = [];
  for (const value of global.invariants) if (scopeMatches(value.scope, tokens)) candidates.push({ category: "invariant", value, direct: directlyScoped(value.scope) });
  for (const value of global.boundaries) {
    // A boundary belongs to its named module.  An omitted scope does not make
    // every module see every boundary (unlike a genuinely global invariant).
    const relevant = tokens.has(norm(value.module)) || Boolean(value.scope?.length && scopeMatches(value.scope, tokens));
    const direct = ownTokens.has(norm(value.module)) || directlyScoped(value.scope);
    if (relevant) candidates.push({ category: "boundary", value, direct });
  }
  for (const value of global.sharedContracts) if (scopeMatches(value.scope, tokens)) candidates.push({ category: "contract", value, direct: directlyScoped(value.scope) });
  for (const value of global.openQuestions) if (scopeMatches(value.scope, tokens)) candidates.push({ category: "question", value, direct: directlyScoped(value.scope) });
  const maxEntries = Number.isInteger(input.maxEntries) ? Math.max(0, Math.min(40, input.maxEntries!)) : 10;
  candidates.sort((a, b) => score(b.value.status, b.direct, b.category) - score(a.value.status, a.direct, a.category) ||
    `${a.category}:${a.value.id}`.localeCompare(`${b.category}:${b.value.id}`));
  // Reserve one slot per available section so a list of requirement rules
  // cannot crowd out the handoff, shared contract, or unresolved question.
  const selected: Candidate[] = [];
  for (const category of ["invariant", "boundary", "contract", "question"] as const) {
    const entry = candidates.find(candidate => candidate.category === category);
    if (entry && selected.length < maxEntries) selected.push(entry);
  }
  for (const entry of candidates) if (selected.length < maxEntries && !selected.includes(entry)) selected.push(entry);
  return {
    version: 1,
    moduleId: stringValue(input.moduleId, 300) ?? "unknown-module",
    sourceVersion: 1,
    invariants: selected.filter((entry): entry is Candidate & { value: ProtocolInvariant } => entry.category === "invariant").map(entry => entry.value),
    boundaries: selected.filter((entry): entry is Candidate & { value: ProtocolBoundary } => entry.category === "boundary").map(entry => entry.value),
    sharedContracts: selected.filter((entry): entry is Candidate & { value: ProtocolSharedContract } => entry.category === "contract").map(entry => entry.value),
    openQuestions: selected.filter((entry): entry is Candidate & { value: ProtocolOpenQuestion } => entry.category === "question").map(entry => entry.value),
  };
}

export async function loadGlobalProtocol(filePath: string, taskIdentity = "unnamed-task"): Promise<ProtocolLoadResult> {
  const path = resolve(filePath);
  try {
    const text = await readFile(path, "utf8");
    return { path, protocol: normaliseGlobalProtocol(JSON.parse(text), taskIdentity) };
  } catch (error) {
    return { path, protocol: emptyGlobalProtocol(), error: error instanceof Error ? error.message : String(error) };
  }
}

/** Best-effort atomic write.  A false result is deliberately non-fatal. */
export async function persistGlobalProtocol(filePath: string, protocol: GlobalProtocol): Promise<boolean> {
  const path = resolve(filePath);
  const temporary = `${path}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(normaliseGlobalProtocol(protocol), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    return true;
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    return false;
  }
}

/** Initialise task-output/global-protocol.json when possible, otherwise return an empty view. */
export async function ensureGlobalProtocol(taskOutput: string, taskIdentity = taskOutput): Promise<ProtocolEnsureResult> {
  const path = join(resolve(taskOutput), protocolFileName);
  const loaded = await loadGlobalProtocol(path, taskIdentity);
  let created = false;
  let persisted = !loaded.error;
  if (loaded.error) {
    try { await stat(path); } catch {
      created = true;
      persisted = await persistGlobalProtocol(path, loaded.protocol);
    }
  }
  return { ...loaded, created, persisted };
}

export { protocolFileName };
