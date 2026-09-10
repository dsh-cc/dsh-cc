/**
 * Analyzer 4 — permission denials, driven by approval/asked|decided pairs.
 * Only outcome `rejected` counts as a denial: `cancelled` is user
 * abandonment, `unavailable` is infra. Sessions whose stream carried an
 * `approval/policy` event with `policy: "never"` are excluded (their tools
 * are never asked, so they poison the denominator).
 */
import type { ApprovalPair, Finding, SessionMeta } from "../types.ts";

export function findPermissionDenials(
  approvals: ApprovalPair[],
  sessions: SessionMeta[],
): Finding[] {
  const excluded = new Set(
    sessions.filter((s) => s.policyNever).map((s) => s.sessionId),
  );
  const groups = new Map<string, { count: number; tool: string; reason: string; session: string; sample: ApprovalPair }>();
  for (const pair of approvals) {
    if (pair.outcome !== "rejected") continue;
    if (excluded.has(pair.sessionId)) continue;
    const tool = pair.toolName ?? "unknown";
    const reason = pair.reason ?? "";
    const key = `${tool}\u0000${reason}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        count: 1,
        tool,
        reason,
        session: pair.sessionId,
        sample: pair,
      });
    } else {
      existing.count++;
    }
  }
  const findings: Finding[] = [];
  for (const group of groups.values()) {
    findings.push({
      kind: "permission-denial",
      title: `user keeps rejecting \`${group.tool}\``,
      detail:
        group.reason === ""
          ? `Rejected ${group.count}×; ask before invoking or stop proposing it.`
          : `Rejected ${group.count}× (reason: ${group.reason}); ask before invoking or stop proposing it.`,
      occurrences: group.count,
      evidence: [`session:${group.session}`],
    });
  }
  return findings;
}
