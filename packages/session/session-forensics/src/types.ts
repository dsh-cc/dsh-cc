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

export interface Finding {
  kind:
    | "path-correlation"
    | "env-fact"
    | "search-scope"
    | "permission-denial"
    | "large-file";
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
