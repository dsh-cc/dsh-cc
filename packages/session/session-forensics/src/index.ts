/**
 * session-forensics — pure analysis library for /learn.
 * Deterministic analyzers over dsh-cc session JSONL stores; no cordis,
 * no @deepseek-ai runtime dependencies.
 */
export {
  APPROVAL_OUTCOMES,
  decompressJsonl,
  parseStream,
  scanSessions,
} from "./scan.ts";
export type { ApprovalOutcome, ParsedStream } from "./scan.ts";
export { correlatePaths } from "./analyze/path-correlation.ts";
export { findEnvFacts } from "./analyze/env-facts.ts";
export { findSearchScope } from "./analyze/search-scope.ts";
export { findPermissionDenials } from "./analyze/permission-denials.ts";
export { LARGE_FILE_THRESHOLD, findLargeFiles } from "./analyze/large-files.ts";
export { anchor } from "./types.ts";
export type {
  ApprovalPair,
  Finding,
  ForensicsOptions,
  ForensicsResult,
  ScanStats,
  SessionMeta,
  ToolRecord,
} from "./types.ts";
import { scanSessions } from "./scan.ts";
import { correlatePaths } from "./analyze/path-correlation.ts";
import { findEnvFacts } from "./analyze/env-facts.ts";
import { findSearchScope } from "./analyze/search-scope.ts";
import { findPermissionDenials } from "./analyze/permission-denials.ts";
import { findLargeFiles } from "./analyze/large-files.ts";
import type {
  ForensicsOptions,
  ForensicsResult,
  ScanStats,
} from "./types.ts";

/** Default seam injected from the host (zstd CLI child process). */
export type Decompress = (file: string) => Promise<string>;

/**
 * Full pipeline: scan the sessions store, run every analyzer, aggregate raw
 * findings by (kind, title), rank by occurrences, apply the minOccurrences
 * filter (default 2).
 */
export async function runForensics(
  sessionsRoot: string,
  options: ForensicsOptions & { decompress?: Decompress } = {},
): Promise<ForensicsResult> {
  const minOccurrences = options.minOccurrences ?? 2;
  const scan = await scanSessions(sessionsRoot, options);
  const findings = [
    ...scan.sessions.flatMap((s) => [
      ...correlatePaths(s.records),
      ...findEnvFacts(s.records),
      ...findSearchScope(s.records),
    ]),
    ...findPermissionDenials(scan.approvals, scan.sessions.map((s) => s.meta)),
    ...findLargeFiles(scan.sessions.flatMap((s) => s.records)),
  ];

  // Aggregate identical findings across sessions/occurrences.
  const merged = new Map<string, (typeof findings)[number]>();
  for (const finding of findings) {
    const key = `${finding.kind}\u0000${finding.title}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, { ...finding });
    } else {
      existing.occurrences += finding.occurrences;
      existing.evidence.push(...finding.evidence);
    }
  }
  const ranked = [...merged.values()]
    .filter((f) => f.occurrences >= minOccurrences)
    .sort((a, b) => b.occurrences - a.occurrences);

  const stats: ScanStats = {
    sessionsScanned: scan.sessions.length,
    linesParsed: scan.linesParsed,
    corruptLinesSkipped: scan.corruptLinesSkipped,
    truncatedTails: scan.truncatedTails,
    sessionsByPolicyNever: scan.sessions.filter((s) => s.meta.policyNever)
      .length,
  };
  return { findings: ranked, stats };
}
