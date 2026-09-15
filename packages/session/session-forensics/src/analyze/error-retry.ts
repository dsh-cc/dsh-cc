/**
 * Analyzer 5 — error-retry, driven by captured `turn/end` outcomes.
 * Computes per-session error-turn totals, maximum consecutive error-turn
 * streak, max-tokens turn count, and an across-sessions histogram over those
 * streaks. Emits findings at streak ≥ 3 or total errors ≥ 20 (the
 * CC-derived thresholds under calibration — this analyzer is how we confirm
 * or revise them from real transcripts).
 */
import type {
  ErrorRetryResult,
  Finding,
  SessionErrorStats,
  StreakBucket,
  TurnOutcome,
} from "../types.ts";

/** Histogram buckets, in display order. */
export const STREAK_BUCKETS: readonly StreakBucket[] = [
  "0",
  "1",
  "2",
  "3",
  "4-9",
  "10-19",
  "20-49",
  "50+",
];

const CONSECUTIVE_CAP = 3;
const TOTAL_CAP = 20;

function bucketOf(maxStreak: number): StreakBucket {
  if (maxStreak >= 50) return "50+";
  if (maxStreak >= 20) return "20-49";
  if (maxStreak >= 10) return "10-19";
  if (maxStreak >= 4) return "4-9";
  return `${maxStreak}` as StreakBucket;
}

/**
 * Analyze captured turn outcomes. NOTE (stickiness, plan §1): a turn that hit
 * the model's output ceiling and then recovered STILL records
 * `reason.kind: "max-tokens"` in `turn/end` (sticky within the turn), so the
 * max-tokens turn count reads "touched the ceiling at least once", NOT
 * "ended truncated" — do not misread it during threshold calibration.
 */
export function analyzeErrorRetry(turns: TurnOutcome[]): ErrorRetryResult {
  const histogram = Object.fromEntries(
    STREAK_BUCKETS.map((b) => [b, 0]),
  ) as Record<StreakBucket, number>;

  // Group by session, preserving stream order per session.
  const bySession = new Map<string, TurnOutcome[]>();
  for (const t of turns) {
    const key = `${t.project}\u0000${t.sessionId}`;
    const list = bySession.get(key);
    if (list === undefined) bySession.set(key, [t]);
    else list.push(t);
  }

  const sessions: SessionErrorStats[] = [];
  const findings: Finding[] = [];
  for (const [key, list] of bySession) {
    const ordered = [...list].sort((a, b) => a.turn - b.turn);
    let totalErrorTurns = 0;
    let maxConsecutiveErrorTurns = 0;
    let streak = 0;
    let maxTokensTurns = 0;
    for (const t of ordered) {
      if (t.kind === "error") {
        totalErrorTurns++;
        streak++;
        if (streak > maxConsecutiveErrorTurns) maxConsecutiveErrorTurns = streak;
      } else {
        streak = 0;
      }
      if (t.kind === "max-tokens") maxTokensTurns++;
    }
    const [project = "", sessionId = ""] = key.split("\u0000");
    const stats: SessionErrorStats = {
      project,
      sessionId,
      totalErrorTurns,
      maxConsecutiveErrorTurns,
      maxTokensTurns,
    };
    sessions.push(stats);
    histogram[bucketOf(maxConsecutiveErrorTurns)]++;

    if (
      maxConsecutiveErrorTurns >= CONSECUTIVE_CAP ||
      totalErrorTurns >= TOTAL_CAP
    ) {
      findings.push({
        kind: "error-retry",
        title: `API errors: streak of ${maxConsecutiveErrorTurns}, ${totalErrorTurns} total`,
        detail:
          `Session hit ${maxConsecutiveErrorTurns} consecutive error-ending turns ` +
          `(${totalErrorTurns} total; streak cap ${CONSECUTIVE_CAP}, total cap ${TOTAL_CAP} under calibration). ` +
          "Request retry is owned by the harness — check provider status or model health.",
        occurrences: totalErrorTurns,
        evidence: [`session:${sessionId}`],
      });
    }
  }

  return { sessions, histogram, findings };
}
