/** Retrieval evidence is immutable; workspaceFiles are read live by the agents. */
export interface WorkspaceTranslationContext {
  id: string;
  kind: "source" | "interface" | "call-chain" | "configuration" | "dependency" | "summary";
  content: string;
  path?: string;
  repository?: string;
  revision?: string;
}

/**
 * A read-only history revision this run may query on demand. The trusted host
 * derives these from the selected module scope; a page never supplies them.
 */
export interface WorkspaceEvidenceScope {
  repositoryId: string;
  analysisRevision: string;
  projectId?: string;
}

/**
 * Host-created, read-only snapshot of the selected history module.  The
 * absolute root is an internal hand-off between the trusted extension host
 * and the local adaptation service; it is never accepted from the webview.
 * Only the listed repository-relative files may be copied into an Agent
 * staging workspace.
 */
export const MAX_SELECTED_HISTORY_MODULES = 3;

/** One selected module within a merged direct-read history view. */
export interface WorkspaceHistoryCandidate {
  /** Directory under history-view/source, e.g. candidate-1. */
  prefix: string;
  repositoryId: string;
  analysisRevision: string;
  projectId?: string;
  moduleId: string;
  name?: string;
  language?: string;
}

export interface WorkspaceHistoryView {
  root: string;
  files: string[];
  repositoryId: string;
  analysisRevision: string;
  projectId?: string;
  moduleId: string;
  manifestHash: string;
  /** Host-created manifest identity for the direct-read history hand-off. */
  runId?: string;
  generatedAt?: string;
  /** Multi-module views retain primary identity above for single-view callers. */
  candidates?: WorkspaceHistoryCandidate[];
}

/** Shared ceiling for revision-scoped history evidence queries. */
export const MAX_RETRIEVAL_SCOPES = 64;

/** How the host asks the workspace Agent to implement a translation. */
export type WorkspaceTranslationMode = "analyzer-translator" | "direct-translator";

export interface WorkspaceTranslationRequest {
  spec: string;
  sourceLanguage: string;
  targetLanguage: string;
  context: WorkspaceTranslationContext[];
  /** Exact workspace-relative paths available for live reads. */
  workspaceFiles: string[];
  /** Exact workspace-relative files that this task may create or update. */
  writeFiles: string[];
  /**
   * Bounded history revisions the legacy tool-loop agent may query through the
   * read-only semantic index. The Codex workspace runtime uses historyView
   * direct reads and never exposes query_evidence.
   */
  evidenceScopes?: WorkspaceEvidenceScope[];
  /** Optional host-created source snapshot for direct Agent inspection. */
  historyView?: WorkspaceHistoryView;
  /** Host-selected fallback when no usable historical implementation exists. */
  translationMode?: WorkspaceTranslationMode;
}

/** One on-demand evidence query, recorded so the run stays auditable. */
export interface WorkspaceEvidenceQuery {
  at: string;
  requirement: string;
  repositoryIds: string[];
  excerptCount: number;
  characters: number;
  error?: string;
}

export interface WorkspaceTranslationPlan {
  summary: string;
  mappings: Array<{ source: string; targetPath: string; targetSymbol: string }>;
  dependencies: Array<{ name: string; strategy: "reuse" | "replace" | "adapt" | "translate"; detail: string }>;
  steps: Array<{ id: string; description: string; files: string[]; dependsOn: string[] }>;
}

/** Host-observed verifier feedback handed back to the same Translator run. */
export interface WorkspaceVerificationFeedback {
  attempt: number;
  status: "failure";
  reason?: string;
  issue?: { kind: "translation" | "test" | "environment" | "unknown"; description: string };
  functions?: Array<{
    source?: { path: string; name: string; signature?: string };
    target: { path: string; name: string; signature?: string };
    status: "passed" | "unverified";
    executed: boolean;
    lineCoverage: number | null;
    branchCoverage: number | null;
    reason?: string;
  }>;
  unmatchedFunctions?: Array<{ path: string; name: string; signature?: string }>;
}

/** Owned by the backend configuration, never by the model or HTTP payload. */
export interface WorkspaceCompileCommand {
  executable: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface WorkspaceCompilation {
  command: WorkspaceCompileCommand;
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  success: boolean;
  output: string;
  diagnostics: string[];
}

export type WorkspaceTranslationStatus =
  | "analyzing" | "translating" | "compiling" | "testing" | "completed"
  | "failed" | "cancelled" | "interrupted" | "rolling-back" | "rolled-back";

export interface WorkspaceTranslationChange {
  path: string;
  before: string | null;
  after: string;
  /** Recorded before writing so an interrupted write can be recovered. */
  applied: boolean;
  /** Last disk content while an update is journaled but not yet acknowledged. */
  pendingBefore?: string | null;
  rolledBack?: boolean;
}

export interface WorkspaceTranslationRun {
  id: string;
  workspaceRoot: string;
  status: WorkspaceTranslationStatus;
  request: WorkspaceTranslationRequest;
  createdAt: string;
  updatedAt: string;
  plan?: WorkspaceTranslationPlan;
  completedSteps: string[];
  changes: WorkspaceTranslationChange[];
  compilations: WorkspaceCompilation[];
  /** Every on-demand history query this run performed, in order. */
  evidenceQueries?: WorkspaceEvidenceQuery[];
  modelTurns: number;
  events?: WorkspaceTranslationEvent[];
  error?: string;
  /** A passing fixed test suite is evidence, not a proof of all behaviors. */
  acceptance: "compilation-only" | "behavior-verified";
  /** Latest host verifier failure awaiting repair by this same Translator. */
  latestVerificationFeedback?: WorkspaceVerificationFeedback;
  verificationRepairs?: Array<{
    at: string;
    attempt: number;
    feedback: WorkspaceVerificationFeedback;
    status: "requested" | "completed" | "failed";
    /** Host-observed distinction: a repaired test fixture is not a production-code repair. */
    disposition?: "production-code" | "test-environment";
  }>;
  verification?: {
    command: WorkspaceCompileCommand;
    criteria: Array<{ path: string; hash: string }>;
    runs: Array<WorkspaceCompilation & { sourceSnapshot: string; planHash: string; filesUnchanged: boolean }>;
  };
  /** Runtime provenance for audit/debugging; never contains prompts or source. */
  agent?: {
    kind: "codex" | "legacy-tool-loop";
    command: string;
    model?: string;
    startedAt: string;
    durationMs?: number;
    exitCode?: number | null;
    inputChars?: number;
    outputChars?: number;
    usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
    historyView?: { repositoryId: string; analysisRevision: string; moduleId: string; files: number; manifestHash: string; runId?: string; generatedAt?: string; candidates?: WorkspaceHistoryCandidate[] };
    /** Per-stage provenance. Prompts and source contents are intentionally omitted. */
    stages?: Array<{
      stage: "analyzer" | "translator";
      sandbox: "read-only" | "workspace-write";
      command: string;
      model?: string;
      startedAt: string;
      durationMs: number;
      exitCode?: number | null;
      inputChars?: number;
      outputChars?: number;
      usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
      readFiles?: string[];
      /** Bounded command metadata from Codex JSONL; command output is omitted. */
      commands?: Array<{ command: string; exitCode?: number | null }>;
      /** Bounded Analyzer final output retained for invalid-plan diagnosis. */
      analyzerOutput?: string;
      analyzerOutputTruncated?: boolean;
      analyzerOutputError?: string;
      /** How the host resolved the Analyzer stage. */
      analyzerStatus?: "accepted" | "fallback";
      analyzerFallbackReason?: string;
    }>;
    /** Number of changed source lines across the accepted diff. */
    incrementalLines?: number;
  };
}
export interface WorkspaceTranslationEvent { at: string; phase: WorkspaceTranslationStatus; message: string; }
