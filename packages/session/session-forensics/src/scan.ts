/**
 * Scanner: walk the dsh-cc sessions store and normalize events into records.
 *
 * Layout: `<sessionsRoot>/<projectKey>/<sessionId>/session.jsonl.zstd`.
 * Child sessions are separate directories; they are distinguished only by
 * the `type: "session"` header line (`origin`, `delegationDepth`,
 * `parentSession`), never by file naming.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  ApprovalPair,
  ForensicsOptions,
  SessionMeta,
  ToolRecord,
} from "./types.ts";

/** Event outcome strings observed on approval/decided events. */
export type ApprovalOutcome =
  | "allowed-once"
  | "rejected"
  | "cancelled"
  | "unavailable";

export const APPROVAL_OUTCOMES: readonly ApprovalOutcome[] = [
  "allowed-once",
  "rejected",
  "cancelled",
  "unavailable",
];

/** How much result text to keep on each record (analyzers only need signatures/anchors). */
const RESULT_TEXT_CAP = 4096;

/** Default zstd seam: shell out to the `zstd` CLI (precedent: scripts/audit-subagent-children.mjs). */
export function decompressJsonl(file: string): Promise<string> {
  const zstdBin = process.env.DSH_ZSTD_BIN ?? "zstd";
  return Promise.resolve(
    execFileSync(zstdBin, ["-d", "-c", file], {
      maxBuffer: 256 * 1024 * 1024,
    }).toString("utf8"),
  );
}

export interface ParsedStream {
  meta: SessionMeta;
  records: ToolRecord[];
  approvals: ApprovalPair[];
  linesParsed: number;
  corruptLinesSkipped: number;
  truncatedTail: boolean;
  headerTs?: number | undefined;
}

function toTs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Date.parse(value);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

function resultCharsOf(content: unknown): { chars: number; text: string } {
  let chars = 0;
  let text = "";
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        chars += block.text.length;
        if (text.length < RESULT_TEXT_CAP) text += block.text;
      }
    }
  }
  return { chars, text: text.slice(0, RESULT_TEXT_CAP) };
}

/**
 * Parse one decompressed JSONL session stream. Tolerant by design:
 * a JSON.parse failure on the LAST non-empty line is a truncated live tail
 * (ignored); failures anywhere else are skipped and counted, never thrown.
 */
export function parseStream(
  project: string,
  sessionId: string,
  text: string,
): ParsedStream {
  const meta: SessionMeta = { project, sessionId, policyNever: false };
  let headerTs: number | undefined;
  const records: ToolRecord[] = [];
  const approvals: ApprovalPair[] = [];
  const pending = new Map<string, ToolRecord>();
  const lines = text.split("\n").filter((line) => line.length > 0);
  const stats = { linesParsed: 0, corruptLinesSkipped: 0, truncatedTail: false };

  for (const [i, line] of lines.entries()) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      if (i === lines.length - 1) stats.truncatedTail = true;
      else stats.corruptLinesSkipped++;
      continue;
    }
    stats.linesParsed++;
    const type = entry?.type;
    const data = entry?.data;

    if (type === "session" && meta.origin === undefined) {
      if (typeof data?.origin === "string") meta.origin = data.origin;
      if (typeof data?.delegationDepth === "number")
        meta.delegationDepth = data.delegationDepth;
      headerTs = toTs(entry.ts ?? entry.timestamp);
      continue;
    }
    if (type === "approval/policy") {
      if (data?.policy === "never") meta.policyNever = true;
      continue;
    }
    if (type === "approval/asked") {
      if (typeof data?.id === "string") {
        // Decided may already have arrived (out-of-order streams): merge.
        let pair = approvals.find((a) => a.id === data.id);
        if (pair === undefined) {
          pair = { project, sessionId, id: data.id };
          approvals.push(pair);
        }
        if (typeof data.toolName === "string") pair.toolName = data.toolName;
        if (typeof data.callId === "string") pair.callId = data.callId;
        if (typeof data.reason === "string") pair.reason = data.reason;
      }
      continue;
    }
    if (type === "approval/decided") {
      if (typeof data?.id === "string") {
        let pair = approvals.find((a) => a.id === data.id);
        if (pair === undefined) {
          pair = { project, sessionId, id: data.id };
          approvals.push(pair);
        }
        if (typeof data.outcome === "string") pair.outcome = data.outcome;
      }
      continue;
    }
    if (type === "tool/call") {
      const name = typeof data?.name === "string" ? data.name : "";
      if (name === "") continue;
      const argsRaw =
        typeof data?.arguments === "string" ? data.arguments : undefined;
      let args: unknown = null;
      if (argsRaw !== undefined) {
        try {
          args = JSON.parse(argsRaw);
        } catch {
          args = null;
        }
      }
      const record: ToolRecord = {
        project,
        sessionId,
        origin: meta.origin,
        delegationDepth: meta.delegationDepth,
        turn: typeof data?.turn === "number" ? data.turn : undefined,
        step: typeof data?.step === "number" ? data.step : undefined,
        name,
        argsRaw,
        args,
        resultChars: 0,
        resultText: "",
        isError: false,
        ts: toTs(entry.ts ?? entry.timestamp),
      };
      records.push(record);
      if (typeof data?.callId === "string") pending.set(data.callId, record);
      continue;
    }
    if (type === "tool/result") {
      const callId = data?.message?.source?.callId;
      const record =
        typeof callId === "string" ? pending.get(callId) : undefined;
      if (record === undefined) continue;
      const payload = Array.isArray(data?.message?.content)
        ? data.message.content[0]
        : undefined;
      if (payload?.type !== "tool-result") continue;
      const { chars, text: resultText } = resultCharsOf(payload.content);
      record.resultChars = chars;
      record.resultText = resultText;
      record.isError = payload.isError === true;
      continue;
    }
  }

  return {
    meta,
    records,
    approvals,
    headerTs,
    ...stats,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Walk the sessions root and return every in-window stream's parsed form.
 * Recency: directory mtime is primary; when missing/unreasonable the header
 * timestamp is used instead. Each stream is decompressed at most once.
 */
export async function scanSessions(
  sessionsRoot: string,
  options: ForensicsOptions & {
    decompress?: (file: string) => Promise<string>;
  } = {},
): Promise<{
  sessions: Array<{ meta: SessionMeta; records: ToolRecord[] }>;
  approvals: ApprovalPair[];
  linesParsed: number;
  corruptLinesSkipped: number;
  truncatedTails: number;
  sessionsScanned: number;
}> {
  const decompress = options.decompress ?? decompressJsonl;
  const days = options.days ?? 14;
  const cutoff = Date.now() - days * DAY_MS;
  const sessions: Array<{ meta: SessionMeta; records: ToolRecord[] }> = [];
  const approvals: ApprovalPair[] = [];
  let linesParsed = 0;
  let corruptLinesSkipped = 0;
  let truncatedTails = 0;

  let projectKeys: string[];
  try {
    projectKeys = readdirSync(sessionsRoot);
  } catch {
    // Missing/empty sessions root: zero findings, no throw.
    projectKeys = [];
  }
  for (const projectKey of projectKeys) {
    if (options.project !== undefined && projectKey !== options.project) continue;
    const projectDir = join(sessionsRoot, projectKey);
    for (const sessionId of readdirSync(projectDir)) {
      const dir = join(projectDir, sessionId);
      const file = join(dir, "session.jsonl.zstd");
      let mtimeMs: number | undefined;
      try {
        mtimeMs = statSync(dir).mtimeMs;
      } catch {
        mtimeMs = undefined;
      }
      const mtimeReasonable =
        mtimeMs !== undefined && Number.isFinite(mtimeMs) && mtimeMs > 0;
      if (mtimeReasonable && (mtimeMs as number) < cutoff) continue; // mtime out of window: skip without decompressing
      let text: string;
      try {
        text = await decompress(file);
      } catch {
        continue;
      }
      const parsed = parseStream(projectKey, sessionId, text);
      // mtime unreliable (or absent): fall back to the header timestamp.
      const headerTs = parsed.headerTs;
      if (!mtimeReasonable && headerTs !== undefined && headerTs < cutoff)
        continue;
      sessions.push({ meta: parsed.meta, records: parsed.records });
      approvals.push(...parsed.approvals);
      linesParsed += parsed.linesParsed;
      corruptLinesSkipped += parsed.corruptLinesSkipped;
      if (parsed.truncatedTail) truncatedTails++;
    }
  }
  return {
    sessions,
    approvals,
    sessionsScanned: sessions.length,
    linesParsed,
    corruptLinesSkipped,
    truncatedTails,
  };
}
