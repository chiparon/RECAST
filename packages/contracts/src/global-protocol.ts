/**
 * The small, task-local semantic sidecar shared by the module workflow.
 *
 * This deliberately contains facts and short rules only.  It has no field for
 * evaluator output, hidden tests, source code, or model traces.  Keeping the
 * contract here lets the host pass an empty sidecar through unchanged when the
 * feature is disabled or a sidecar cannot be read.
 */

export type ProtocolSource = "requirement" | "skeleton" | "observed" | "module-confirmed";
export type ProtocolStatus = "fixed" | "verified" | "proposed" | "ambiguous" | "conflict";

export interface ProtocolInvariant {
  id: string;
  rule: string;
  source: ProtocolSource;
  status: ProtocolStatus;
  scope?: string[];
  note?: string;
}

export interface ProtocolBoundary {
  id: string;
  module: string;
  responsibility: string;
  interface?: string;
  source: ProtocolSource;
  status: ProtocolStatus;
  scope?: string[];
  note?: string;
}

export interface ProtocolSharedContract {
  id: string;
  name: string;
  fields?: string[];
  rule?: string;
  source: ProtocolSource;
  status: ProtocolStatus;
  scope?: string[];
  note?: string;
}

export interface ProtocolOpenQuestion {
  id: string;
  question: string;
  source: ProtocolSource;
  status: "open" | "resolved" | "ambiguous" | "conflict";
  scope?: string[];
  note?: string;
}

/** The on-disk shape of task-output/global-protocol.json. */
export interface GlobalProtocol {
  version: 1;
  invariants: ProtocolInvariant[];
  boundaries: ProtocolBoundary[];
  sharedContracts: ProtocolSharedContract[];
  openQuestions: ProtocolOpenQuestion[];
}

/** A projected view carries no new facts; it only identifies its module. */
export interface ModuleProtocol extends GlobalProtocol {
  moduleId: string;
  sourceVersion: 1;
}

export type GlobalProtocolPatch = Partial<Pick<GlobalProtocol,
  "invariants" | "boundaries" | "sharedContracts" | "openQuestions">>;

export function emptyGlobalProtocol(): GlobalProtocol {
  return { version: 1, invariants: [], boundaries: [], sharedContracts: [], openQuestions: [] };
}
