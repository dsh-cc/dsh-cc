/**
 * Analyzer 5 — large read results. A read that dumped a huge file should
 * become "always page with offset/limit" guidance for that path.
 */
import type { Finding, ToolRecord } from "../types.ts";
import { anchor } from "../types.ts";

export const LARGE_FILE_THRESHOLD = 200_000;

export function findLargeFiles(records: ToolRecord[]): Finding[] {
  const groups = new Map<string, { count: number; session: string; turn?: number | undefined }>();
  for (const record of records) {
    if (record.name.toLowerCase() !== "read") continue;
    if (record.resultChars <= LARGE_FILE_THRESHOLD) continue;
    const path = (record.args as Record<string, unknown> | null)?.file_path;
    if (typeof path !== "string") continue;
    const existing = groups.get(path);
    if (existing === undefined) {
      groups.set(path, { count: 1, session: record.sessionId, turn: record.turn });
    } else {
      existing.count++;
    }
  }
  const findings: Finding[] = [];
  for (const [path, group] of groups) {
    findings.push({
      kind: "large-file",
      title: `always use offset/limit on ${path}`,
      detail: `Reading it whole returned ${group.count} oversized result(s) (>${LARGE_FILE_THRESHOLD} chars).`,
      occurrences: group.count,
      evidence: [anchor(group.session, group.turn)],
    });
  }
  return findings;
}
