import { describe, expect, it } from "vitest";
import { analyzeErrorRetry, STREAK_BUCKETS } from "../src/analyze/error-retry.ts";
import { runForensics } from "../src/index.ts";
import type { TurnOutcome } from "../src/types.ts";

let seq = 0;

function turn(
  overrides: Partial<TurnOutcome> & { kind: TurnOutcome["kind"] },
): TurnOutcome {
  seq++;
  return {
    project: "proj",
    sessionId: "s1",
    turn: overrides.turn ?? seq,
    ...overrides,
  };
}

describe("analyzeErrorRetry", () => {
  it("counts error turns, max consecutive streak, and max-tokens turns per session", () => {
    const turns = [
      turn({ turn: 1, kind: "error" }),
      turn({ turn: 2, kind: "error" }),
      turn({ turn: 3, kind: "error" }),
      turn({ turn: 4, kind: "completed" }),
      turn({ turn: 5, kind: "max-tokens" }),
      turn({ turn: 6, kind: "error" }),
    ];
    const result = analyzeErrorRetry(turns);
    expect(result.sessions).toHaveLength(1);
    const s = result.sessions[0]!;
    expect(s.totalErrorTurns).toBe(4);
    expect(s.maxConsecutiveErrorTurns).toBe(3);
    expect(s.maxTokensTurns).toBe(1);
    expect(result.findings).toHaveLength(1); // streak 3 ≥ 3
  });

  it("computes streaks per session independently (grouped by sessionId)", () => {
    const turns = [
      turn({ sessionId: "a", turn: 1, kind: "error" }),
      turn({ sessionId: "b", turn: 1, kind: "completed" }),
      turn({ sessionId: "a", turn: 2, kind: "error" }),
    ];
    const result = analyzeErrorRetry(turns);
    const a = result.sessions.find((s) => s.sessionId === "a")!;
    expect(a.maxConsecutiveErrorTurns).toBe(2);
    expect(result.histogram["1"]).toBe(0);
    expect(result.histogram["2"]).toBe(1);
  });

  it("buckets the histogram by max streak: 0 / 1 / 2 / 3 / 4-9 / 10-19 / 20-49 / 50+", () => {
    const turns: TurnOutcome[] = [
      // streak 0 (no errors)
      turn({ sessionId: "zero", turn: 1, kind: "completed" }),
      // streak 1
      turn({ sessionId: "one", turn: 1, kind: "error" }),
      turn({ sessionId: "one", turn: 2, kind: "completed" }),
      // streak 2
      turn({ sessionId: "two", turn: 1, kind: "error" }),
      turn({ sessionId: "two", turn: 2, kind: "error" }),
      turn({ sessionId: "two", turn: 3, kind: "completed" }),
      // streak 3
      turn({ sessionId: "three", turn: 1, kind: "error" }),
      turn({ sessionId: "three", turn: 2, kind: "error" }),
      turn({ sessionId: "three", turn: 3, kind: "error" }),
      // streak 5 → 4-9
      ...[1, 2, 3, 4, 5].map((t) => turn({ sessionId: "five", turn: t, kind: "error" })),
      // streak 12 → 10-19
      ...Array.from({ length: 12 }, (_, i) =>
        turn({ sessionId: "twelve", turn: i + 1, kind: "error" })),
      // streak 25 → 20-49
      ...Array.from({ length: 25 }, (_, i) =>
        turn({ sessionId: "tf", turn: i + 1, kind: "error" })),
      // streak 55 → 50+
      ...Array.from({ length: 55 }, (_, i) =>
        turn({ sessionId: "ff", turn: i + 1, kind: "error" })),
    ];
    const result = analyzeErrorRetry(turns);
    expect(Object.keys(result.histogram)).toEqual([...STREAK_BUCKETS]);
    expect(result.histogram).toEqual({
      "0": 1,
      "1": 1,
      "2": 1,
      "3": 1,
      "4-9": 1,
      "10-19": 1,
      "20-49": 1,
      "50+": 1,
    });
  });

  it("emits a finding for total error turns ≥ 20 even without a streak", () => {
    // 20 alternating error/completed turns: no streak > 1, but total = 20.
    const turns = Array.from({ length: 40 }, (_, i) =>
      turn({ sessionId: "burn", turn: i + 1, kind: i % 2 === 0 ? "error" : "completed" }));
    const result = analyzeErrorRetry(turns);
    expect(result.sessions[0]!.maxConsecutiveErrorTurns).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.occurrences).toBe(20);
    expect(result.findings[0]!.evidence).toEqual(["session:burn"]);
  });

  it("emits no findings below both thresholds", () => {
    const turns = [
      ...Array.from({ length: 2 }, (_, i) => turn({ turn: i + 1, kind: "error" })),
      turn({ turn: 3, kind: "completed" }),
    ];
    expect(analyzeErrorRetry(turns).findings).toHaveLength(0);
  });

  it("returns empty sessions/histogram-zeroes/findings on no turns", () => {
    const result = analyzeErrorRetry([]);
    expect(result.sessions).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(Object.values(result.histogram).every((n) => n === 0)).toBe(true);
  });
});

describe("runForensics error-retry integration", () => {
  it("registers the analyzer in the pipeline: ForensicsResult carries errorRetry", async () => {
    const result = await runForensics("/nonexistent-path-xyz", { decompress: async () => "" });
    expect(result.errorRetry).toBeDefined();
    expect(result.errorRetry.sessions).toEqual([]);
    expect(result.errorRetry.findings).toEqual([]);
    expect(result.errorRetry.histogram["0"]).toBe(0);
  });
});
