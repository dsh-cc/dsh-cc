/**
 * Session-store scanner: walk the dsh-cc sessions store and classify each
 * session directory from its header line, unfiltered by any gate window.
 *
 * Layout: `<sessionsRoot>/<projectKey>/<sessionId>/<stream>`; any directory at
 * depth 2 is treated as a session dir. Stream resolution mirrors
 * session-forensics/src/scan.ts: prefer `session.v3.jsonl.zstd`, fall back to
 * the legacy `session.jsonl.zstd` (the writer emits exactly one format per
 * dir). Only the header line is needed, so the read is a bounded prefix
 * (256 KiB compressed → 16 KiB decompressed) via `node:fs`/`node:zlib`
 * in-process zstd — no fs seam (prefix reads are impossible over it) and no
 * `zstd` CLI (plan §3.1, cold-review blockers #1/#2).
 *
 * Every failure is classified, never thrown: unreadable dirs count toward
 * `unreadable`, a missing root or absent zstd capability yields a zeroed
 * result.
 * @module @dsh-cc/memory-consolidation/session-scan
 */
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { StringDecoder } from "node:string_decoder";

/** One session directory's classification, unfiltered by any gate window. */
export interface ScannedSession {
  id: string;
  createdAt: number;
  sub: boolean;
}

export interface SessionScanResult {
  /** All classifiable sessions, so the memo can be shared across repos. */
  sessions: ScannedSession[];
  /** Session directories seen, classifiable or not. */
  scanned: number;
  /** Directories skipped because no readable stream/header was found. */
  unreadable: number;
}

/** Compressed prefix window (bytes) read from the stream file. */
const READ_WINDOW = 256 * 1024;
/** Decompressed text budget: stop reading once the header must have surfaced. */
const TEXT_BUDGET = 16 * 1024;

const V3_STREAM = "session.v3.jsonl.zstd";
const LEGACY_STREAM = "session.jsonl.zstd";

function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * Decompress a bounded prefix of the stream and return the first
 * `type: "session"` JSONL header, or undefined when none surfaces within the
 * budget / the stream is corrupt. Never rejects.
 */
function readHeader(streamPath: string): Promise<Record<string, any> | undefined> {
  // Capability check (plan §3.1): undated/nonstandard Node without in-process
  // zstd fails closed here.
  if (typeof zlib.createZstdDecompress !== "function") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let text = "";
    let settled = false;
    const finish = (header: Record<string, any> | undefined) => {
      if (settled) return;
      settled = true;
      source.destroy();
      zstd.destroy();
      resolve(header);
    };
    const findHeader = (): Record<string, any> | undefined => {
      for (const line of text.split("\n")) {
        if (!line.includes('"type":"session"')) continue;
        try {
          const entry = JSON.parse(line);
          if (entry?.type === "session") return entry;
        } catch {
          // torn or non-JSON line: keep scanning
        }
      }
      return undefined;
    };
    // StringDecoder (not chunk.toString) so a multibyte char split across
    // streams can't inject U+FFFD and silently break the header JSON.parse.
    const decoder = new StringDecoder("utf8");
    const onChunk = (chunk: Buffer) => {
      text += decoder.write(chunk);
      if (text.length >= TEXT_BUDGET) finish(findHeader());
    };
    const source = createReadStream(streamPath, { start: 0, end: READ_WINDOW - 1 });
    const zstd = zlib.createZstdDecompress();
    source.pipe(zstd);
    zstd.on("data", onChunk);
    source.on("error", () => finish(undefined));
    zstd.on("error", () => finish(undefined));
    zstd.on("end", () => { text += decoder.end(); finish(findHeader()); });
  });
}

/** Classify a header line per the pinned v3 contract, defensively. */
function classify(header: Record<string, any>, dirName: string): ScannedSession {
  const data = header.data;
  const createdRaw = header.createdAt ?? header.time ?? header.ts ?? header.timestamp;
  // Missing/garbage timestamp counts as NEW (fails open to over-inclusion).
  const createdAt = isSafeInt(createdRaw) ? createdRaw : Number.MAX_SAFE_INTEGER;
  const depth = isSafeInt(header.delegationDepth)
    ? header.delegationDepth
    : isSafeInt(data?.delegationDepth)
      ? data.delegationDepth
      : 0;
  const origin = header.origin ?? data?.origin;
  return {
    id: typeof header.id === "string" && header.id.length > 0 ? header.id : dirName,
    createdAt,
    sub: depth > 0 || origin === "subagent",
  };
}

/**
 * Scan the session store: classify every depth-2 directory from its stream
 * header. A missing/unreadable root yields a zeroed result, never an throw.
 */
export async function scanSessions(sessionsRoot: string): Promise<SessionScanResult> {
  const zeroed: SessionScanResult = { sessions: [], scanned: 0, unreadable: 0 };
  // Capability check (plan §3.1): undated/nonstandard Node without in-process
  // zstd fails closed to a zeroed result.
  if (typeof zlib.createZstdDecompress !== "function") return zeroed;
  try {
    const projects = await readdir(sessionsRoot, { withFileTypes: true });
    const sessions: ScannedSession[] = [];
    let scanned = 0;
    let unreadable = 0;
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const projectDir = join(sessionsRoot, project.name);
      let entries;
      try {
        entries = await readdir(projectDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        scanned++;
        const sessionDir = join(projectDir, entry.name);
        // Stream resolution mirrors session-forensics/src/scan.ts.
        let header: Record<string, any> | undefined;
        for (const stream of [V3_STREAM, LEGACY_STREAM]) {
          header = await readHeader(join(sessionDir, stream));
          if (header !== undefined) break;
        }
        if (header === undefined) unreadable++;
        else sessions.push(classify(header, entry.name));
      }
    }
    return { sessions, scanned, unreadable };
  } catch {
    return zeroed;
  }
}

/**
 * The gate window: qualify (`!sub && createdAt > lastAt`), count all
 * qualifying, and select up to 50 hint ids, most-recent first. Pure.
 */
export function gateWindow(
  sessions: readonly ScannedSession[],
  lastAt: number,
): { count: number; hints: string[] } {
  const qualifying = sessions.filter((s) => !s.sub && s.createdAt > lastAt);
  const hints = [...qualifying]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50)
    .map((s) => s.id);
  return { count: qualifying.length, hints };
}
