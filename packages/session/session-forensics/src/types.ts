/**
 * Shared types for the session-forensics analysis library.
 */

/** One normalized tool call, paired with its result when present. */
export interface ToolRecord {
  project: string;
  sessionId: string;
  origin?: string | undefined;
  delegationDepth?: number | undefined;
  turn?: number | undefined;
  step?: number | undefined;
  /** Tool name as written in the event (lowercased copy is used for matching). */
  name: string;
  /** Raw JSON-encoded `arguments` string from the tool/call event. */
  argsRaw?: string | undefined;
  /** JSON.parse of argsRaw, or null when absent/unparseable. */
  args: unknown;
  /** Total length of text content in the paired tool result. */
  resultChars: number;
  /** First chunk of the paired result text (bounded) for gates/signatures. */
  resultText: string;
  isError: boolean;
  ts?: number | undefined;
}

/** An approval/asked event paired with its approval/decided outcome by `data.id`. */
export interface ApprovalPair {
  project: string;
  sessionId: string;
  id: string;
  toolName?: string | undefined;
  callId?: string | undefined;
  reason?: string | undefined;
  outcome?: string | undefined;
}

/** Per-session header facts the analyzers need. */
export interface SessionMeta {
  project: string;
  sessionId: string;
  origin?: string | undefined;
  delegationDepth?: number | undefined;
  /** True when the stream carried an `approval/policy` event with `policy: "never"`. */
  policyNever: boolean;
}

/** Outcome kinds carried by `turn/end` events (harness `agent.ts`). */
export type TurnEndKind = "completed" | "max-tokens" | "aborted" | "error";

/** One normalized `turn/end` outcome, captured tolerantly by the scanner. */
export interface TurnOutcome {
  project: string;
  sessionId: string;
  turn: number;
  kind: TurnEndKind;
  /** Only for `kind: "error"`: the error's `code` (e.g. an LlmError code or `UNKNOWN`). */
  errorCode?: string | undefined;
  /** Only for `kind: "error"`: truncated error message. */
  message?: string | undefined;
}

/**
 * Per-session error-retry stats. NOTE (stickiness, plan §1): a turn that hit
 * the model's output ceiling and then recovered STILL records
 * `reason.kind: "max-tokens"` in `turn/end` — the reason is sticky within the
 * turn. The max-tokens turn count therefore reads "touched the ceiling at
 * least once", NOT "ended truncated"; do not misread it during threshold
 * calibration.
 */
export interface SessionErrorStats {
  project: string;
  sessionId: string;
  totalErrorTurns: number;
  maxConsecutiveErrorTurns: number;
  maxTokensTurns: number;
}

/** Histogram buckets over sessions, keyed by each session's max streak. */
export type StreakBucket = "0" | "1" | "2" | "3" | "4-9" | "10-19" | "20-49" | "50+";

/** Output of the error-retry analyzer (also surfaced on `ForensicsResult`). */
export interface ErrorRetryResult {
  sessions: SessionErrorStats[];
  histogram: Record<StreakBucket, number>;
  findings: Finding[];
}

export interface Finding {
  kind:
    | "path-correlation"
    | "env-fact"
    | "search-scope"
    | "permission-denial"
    | "large-file"
    | "error-retry";
  title: string;
  detail: string;
  occurrences: number;
  /** Anchors of the form `session:<sessionId>#turn=<n>`. */
  evidence: string[];
}

export interface ScanStats {
  sessionsScanned: number;
  linesParsed: number;
  corruptLinesSkipped: number;
  truncatedTails: number;
  sessionsByPolicyNever: number;
}

export interface ForensicsResult {
  findings: Finding[];
  stats: ScanStats;
  errorRetry: ErrorRetryResult;
}

export interface ForensicsOptions {
  /** Only include sessions whose (mtime or header) timestamp is within the last N days. */
  days?: number | undefined;
  /** Restrict to one project key; omit for all projects. */
  project?: string | undefined;
  /** Drop findings seen fewer than this many times (default 2). */
  minOccurrences?: number | undefined;
}

/** Anchor string for evidence lists. */
export function anchor(sessionId: string, turn?: number): string {
  return turn === undefined
    ? `session:${sessionId}`
    : `session:${sessionId}#turn=${turn}`;
}
