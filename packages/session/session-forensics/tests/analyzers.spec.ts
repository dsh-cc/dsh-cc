import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { correlatePaths } from "../src/analyze/path-correlation.ts";
import { findEnvFacts } from "../src/analyze/env-facts.ts";
import { findSearchScope } from "../src/analyze/search-scope.ts";
import { findPermissionDenials } from "../src/analyze/permission-denials.ts";
import { findLargeFiles } from "../src/analyze/large-files.ts";
import { runForensics } from "../src/index.ts";
import type { ApprovalPair, SessionMeta, ToolRecord } from "../src/types.ts";

let seq = 0;

function record(overrides: Partial<ToolRecord>): ToolRecord {
  seq++;
  return {
    project: "proj",
    sessionId: "s1",
    turn: overrides.turn ?? 1,
    name: "bash",
    args: {},
    resultChars: 0,
    resultText: "",
    isError: false,
    ...overrides,
  } as ToolRecord;
}

const session = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  project: "proj",
  sessionId: "s1",
  policyNever: false,
  ...overrides,
});

describe("path correlation", () => {
  it("emits prefer-dir finding when same-basename read fails then succeeds elsewhere", () => {
    const records = [
      record({ name: "read", turn: 2, args: { file_path: "/a/config.json" }, isError: true, resultText: "ENOENT: no such file or directory" }),
      record({ name: "read", turn: 3, args: { file_path: "/b/config.json" }, resultText: "read /b/config.json ok" }),
    ];
    const findings = correlatePaths(records);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toContain("prefer /b/ over /a for config.json");
    expect(findings[0]!.evidence).toEqual(["session:s1#turn=2"]);
  });

  it("ignores successes that come BEFORE the failure (window lower edge)", () => {
    const records = [
      record({ name: "read", turn: 1, args: { file_path: "/b/config.json" }, resultText: "ok" }),
      record({ name: "read", turn: 2, args: { file_path: "/a/config.json" }, isError: true, resultText: "No such file" }),
    ];
    expect(correlatePaths(records)).toHaveLength(0);
  });

  it("requires the success to be the FIRST success after the failure, and same tool name", () => {
    const records = [
      record({ name: "read", turn: 1, args: { file_path: "/a/config.json" }, isError: true, resultText: "No such file" }),
      record({ name: "grep", turn: 2, args: { path: "/b/config.json" }, resultText: "read /b/config.json ok" }),
      record({ name: "read", turn: 3, args: { file_path: "/b/config.json" }, resultText: "read /b/config.json ok" }),
    ];
    const findings = correlatePaths(records);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toContain("/b/config.json");
  });

  it("excludes non-path-shaped failures (logic/test errors) from the analyzer", () => {
    const records = [
      record({ name: "read", args: { file_path: "/a/config.json" }, isError: true, resultText: "TypeError: x is not a function" }),
      record({ name: "read", args: { file_path: "/b/config.json" }, resultText: "read /b/config.json ok" }),
    ];
    expect(correlatePaths(records)).toHaveLength(0);
  });

  it("requires the success result text to contain the file token", () => {
    const records = [
      record({ name: "read", args: { file_path: "/a/config.json" }, isError: true, resultText: "No such file" }),
      record({ name: "read", args: { file_path: "/b/config.json" }, resultText: "unrelated output" }),
    ];
    expect(correlatePaths(records)).toHaveLength(0);
  });

  it("correlates bash commands: same first token + differing path-ish token + token in result", () => {
    const records = [
      record({ turn: 1, args: { command: "pnpm test packages/a/foo.spec.ts" }, isError: true, resultText: "ENOENT packages/a/foo.spec.ts: not found" }),
      record({ turn: 2, args: { command: "pnpm test packages/b/foo.spec.ts" }, resultText: "PASS packages/b/foo.spec.ts" }),
    ];
    const findings = correlatePaths(records);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toContain("pnpm");
  });

  it("does not correlate bash commands with different first tokens", () => {
    const records = [
      record({ args: { command: "node a/x.js" }, isError: true, resultText: "ENOENT not found" }),
      record({ args: { command: "pnpm test b/x.js" }, resultText: "PASS b/x.js" }),
    ];
    expect(correlatePaths(records)).toHaveLength(0);
  });
});

describe("env facts", () => {
  it("records failing first-token command vs later successful variant", () => {
    const records = [
      record({ turn: 1, args: { command: "python3 -m pytest" }, isError: true, resultText: "ModuleNotFoundError: No module named 'pytest'" }),
      record({ turn: 2, args: { command: "python3 -m pip install pyyaml && python3 tools/gen.py" }, resultText: "generated ok" }),
    ];
    const findings = findEnvFacts(records);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toContain("python3 -m pip install");
  });

  it("ignores when no distinct error signature (success text same shape)", () => {
    const records = [
      record({ args: { command: "python3 -m pytest" }, isError: true, resultText: "boom" }),
      record({ args: { command: "python3 -m pytest" }, resultText: "boom" }),
    ];
    expect(findEnvFacts(records)).toHaveLength(0);
  });
});

describe("search scope", () => {
  it("finds failed narrow grep followed by successful broader grep on similar pattern", () => {
    const records = [
      record({ name: "grep", turn: 1, args: { pattern: "pointerLine", path: "/repo/src/one" }, isError: true, resultText: "no matches" }),
      record({ name: "grep", turn: 2, args: { pattern: "pointerLine", path: "/repo" }, resultText: "src/save.ts:66" }),
    ];
    const findings = findSearchScope(records);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toContain("search from /repo");
  });

  it("ignores a success that narrows instead of broadening", () => {
    const records = [
      record({ name: "grep", args: { pattern: "p", path: "/repo" }, isError: true, resultText: "no matches" }),
      record({ name: "grep", args: { pattern: "p", path: "/repo/src" }, resultText: "found" }),
    ];
    expect(findSearchScope(records)).toHaveLength(0);
  });
});

describe("permission denials", () => {
  const pair = (overrides: Partial<ApprovalPair>): ApprovalPair => ({
    project: "proj",
    sessionId: "s1",
    id: `a${++seq}`,
    toolName: "bash",
    outcome: "rejected",
    ...overrides,
  });

  it("counts rejected pairs only; cancelled and unavailable are not denials", () => {
    const approvals = [
      pair({ id: "a1", outcome: "rejected", toolName: "bash" }),
      pair({ id: "a2", outcome: "rejected", toolName: "bash" }),
      pair({ id: "a3", outcome: "cancelled" }),
      pair({ id: "a4", outcome: "unavailable" }),
      pair({ id: "a5", outcome: "allowed-once" }),
    ];
    const findings = findPermissionDenials(approvals, [session()]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.occurrences).toBe(2);
    expect(findings[0]!.title).toContain("bash");
  });

  it("excludes sessions with approval/policy never from the denominator", () => {
    const approvals = [pair({ sessionId: "child", id: "a1" })];
    const findings = findPermissionDenials(approvals, [session({ sessionId: "child", policyNever: true })]);
    expect(findings).toHaveLength(0);
  });

  it("carries the human reason into the detail", () => {
    const findings = findPermissionDenials([pair({ reason: "deletes files" })], [session()]);
    expect(findings[0]!.detail).toContain("deletes files");
  });
});

describe("large files", () => {
  it("flags reads above the threshold with offset/limit guidance", () => {
    const records = [
      record({ name: "read", args: { file_path: "/x/huge.log" }, resultChars: 250_000 }),
      record({ name: "read", args: { file_path: "/x/huge.log" }, resultChars: 300_000 }),
      record({ name: "read", args: { file_path: "/x/small.log" }, resultChars: 100 }),
    ];
    const findings = findLargeFiles(records);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toBe("always use offset/limit on /x/huge.log");
    expect(findings[0]!.occurrences).toBe(2);
  });
});

describe("runForensics", () => {
  it("returns zero findings and clean stats on empty history, no throw", async () => {
    const result = await runForensics("/nonexistent-path-xyz", { decompress: async () => "" });
    expect(result.findings).toEqual([]);
    expect(result.stats.sessionsScanned).toBe(0);
    expect(result.stats.linesParsed).toBe(0);
  });

  it("aggregates by title, ranks by occurrences, applies minOccurrences", async () => {
    const root = mkdtempSync(join(tmpdir(), "forensics-agg-"));
    for (const sessionId of ["sa", "sb"]) {
      const dir = join(root, "proj", sessionId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "session.jsonl.zstd"),
        Buffer.from(""),
      );
    }
    const result = await runForensics(root, { minOccurrences: 1, decompress: async () => "" });
    expect(result.stats.sessionsScanned).toBe(2);
    expect(result.findings).toEqual([]);
  });
});
