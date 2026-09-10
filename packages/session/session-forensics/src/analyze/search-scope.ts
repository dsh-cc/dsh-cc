/**
 * Analyzer 3 — search scope. A failed grep whose root is narrow, followed by
 * a successful grep with a similar pattern on a broader (ancestor) root.
 */
import type { Finding, ToolRecord } from "../types.ts";
import { anchor } from "../types.ts";

function grepArgs(record: ToolRecord):
  | { pattern: string; path: string }
  | undefined {
  const args = record.args as Record<string, unknown> | null;
  if (record.name.toLowerCase() !== "grep" || args === null) return undefined;
  if (typeof args.pattern !== "string") return undefined;
  return {
    pattern: args.pattern,
    path: typeof args.path === "string" ? args.path : "",
  };
}

/**
 * True when `broader` is strictly wider than `narrow`: either the default
 * (empty path = whole cwd) or a strict ancestor directory of it.
 */
function isBroaderRoot(broader: string, narrow: string): boolean {
  if (broader === "") return narrow !== "";
  if (broader === narrow || narrow === "") return false;
  const b = broader.endsWith("/") ? broader : broader + "/";
  return narrow.startsWith(b);
}

export function findSearchScope(records: ToolRecord[]): Finding[] {
  const findings: Finding[] = [];
  const greps = records.filter((r) => r.name.toLowerCase() === "grep");
  for (let i = 0; i < greps.length; i++) {
    const failure = greps[i]!;
    if (!failure.isError) continue;
    const failed = grepArgs(failure);
    if (failed === undefined || failed.path === "") continue;
    for (let j = i + 1; j < greps.length; j++) {
      const success = greps[j]!;
      if (success.isError) continue;
      const good = grepArgs(success);
      if (good === undefined) continue;
      const similar =
        good.pattern === failed.pattern ||
        good.pattern.includes(failed.pattern) ||
        failed.pattern.includes(good.pattern);
      if (!similar || !isBroaderRoot(good.path, failed.path)) continue;
      findings.push({
        kind: "search-scope",
        title: `search from ${good.path} for \`${failed.pattern}\``,
        detail: `Grep for \`${failed.pattern}\` under ${failed.path} found nothing; the same pattern under ${good.path} succeeded.`,
        occurrences: 1,
        evidence: [anchor(failure.sessionId, failure.turn)],
      });
      break;
    }
  }
  return findings;
}
