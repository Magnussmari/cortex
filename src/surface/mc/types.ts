/**
 * Grove Mission Control v2 — shared TypeScript types.
 */

// --- Enum-like unions ---

export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";

export type AgentType = "head" | "hands";

export type AssignmentState =
  | "queued"
  | "dispatched"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type EndpointKind =
  | "local.process.controlled"
  | "local.observed"
  | "local.process.autonomous";

export type LogLevel = "debug" | "info" | "warn" | "error";

// --- Block reason tagged union ---

export interface BlockReasonPermission {
  kind: "permission.request";
  payload: {
    requested_action: string;
    target?: string;
    context?: string;
    risk_hint?: string;
  };
}

export interface BlockReasonToolError {
  kind: "tool.error";
  payload: {
    tool_name: string;
    error_message: string;
  };
}

export interface BlockReasonReviewCheckpoint {
  kind: "review.checkpoint";
  payload: {
    description: string;
  };
}

export type BlockReason =
  | BlockReasonPermission
  | BlockReasonToolError
  | BlockReasonReviewCheckpoint;

// --- Entity types ---

export type TaskSourceSystem = "github" | "internal";

// --- Provider / source-ref model (G-1113.B.1) ---

/**
 * The set of work-item providers Mission Control can normalize a task from.
 * `PROVIDERS` is the single source of truth — `Provider` is derived from it so
 * the union and the runtime guard never drift. Superset of the legacy
 * {@link TaskSourceSystem} (`github | internal`); the remaining members are
 * declared now (B.1, types only) and wired in later phases.
 */
export const PROVIDERS = [
  "internal",
  "github",
  "gitlab",
  "azure-devops",
  "jira",
  "linear",
  "bitbucket",
  "custom",
] as const;

export type Provider = (typeof PROVIDERS)[number];

/** Runtime guard for {@link Provider} — narrows untrusted input (config/API/wire). */
export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/**
 * Normalized reference to a task's origin in some provider, independent of the
 * provider's own object model. Provider-specific adapters (B.3+) produce this
 * shape so the rest of Mission Control never branches on `source=github`.
 *
 * `providerNativeType` preserves the provider's own object label
 * (e.g. `"issue"`, `"pull_request"`, `"merge_request"`) on the normalized
 * concept rather than forking the model per provider. This resolves the
 * design §11 open question in favour of **native-type-as-field**: a GitLab
 * merge request is a normalized PullRequest carrying
 * `providerNativeType: "merge_request"` — not a separate `ChangeRequest`
 * top-level concept. (The Git-object modelling that consumes this lands in
 * Phase C; B.1 only fixes the source-ref shape.)
 */
export interface SourceRef {
  provider: Provider;
  /** Provider-native id of the backing object (issue number, MR iid, …). Null for internal/manual. */
  externalId: string | null;
  /** Canonical URL to the backing object, when one exists. */
  url: string | null;
  /**
   * Provider-native object label preserved on the normalized concept
   * (e.g. `"issue"`, `"pull_request"`, `"merge_request"`). Null when not
   * applicable. Deliberately an opaque `string` at the source boundary — the
   * typed literal union (`"pull_request" | "merge_request" | …`) lives on the
   * Phase-C `PullRequest` Git concept, not here; don't narrow it in B.2/C.
   */
  providerNativeType: string | null;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  priority: number;
  principal_id: string;
  source_system: TaskSourceSystem;
  source_url: string | null;
  source_external_id: string | null;
  related_refs_json: string | null;
  status: TaskStatus;
  created_at: number;
  updated_at: number;
}

export interface Agent {
  id: string;
  name: string;
  type: AgentType;
  persistent: boolean;
  created_at: string;
}

export interface AgentTaskAssignment {
  id: string;
  agent_id: string;
  task_id: string;
  state: AssignmentState;
  block_reason: BlockReason | null;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  assignment_id: string;
  cc_session_id: string | null;
  endpoint_kind: EndpointKind;
  pid: number | null;
  started_at: string;
  ended_at: string | null;
}

export interface McEvent {
  id: string;
  session_id: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

// --- State machine ---

export type Action =
  | { type: "dispatch" }
  | { type: "start" }
  | { type: "block"; reason: BlockReason }
  | { type: "complete" }
  | { type: "fail"; error?: string }
  | { type: "resume" }
  | { type: "principal_requeue" }
  | { type: "cancel" };

export type ActionType = Action["type"];

export type TransitionResult =
  | { ok: true; state: AssignmentState; blockReason: BlockReason | null }
  | { ok: false; error: string };

// --- Config ---

export interface HooksConfig {
  rawEventsDir: string;
  cursorPath: string;
  pollInterval: number;
}

export interface Config {
  port: number;
  /** Bind address. Defaults to "127.0.0.1" — loopback only.
   *  NEVER set to "0.0.0.0" without auth; see CLAUDE.md security rule. */
  hostname: string;
  db: { path: string };
  log: { level: LogLevel };
  hooks: HooksConfig;
  ws: WsConfig;
}

export interface WsConfig {
  /** Max inbound WebSocket payload in bytes. Default 64 KB. */
  maxPayloadLength: number;
  /** Idle timeout in seconds — server closes connections with no activity. */
  idleTimeoutSec: number;
  /** Max concurrent WebSocket clients. 0 = unlimited. */
  maxClients: number;
}
