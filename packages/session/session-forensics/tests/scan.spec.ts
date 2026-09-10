import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decompressJsonl, parseStream, scanSessions } from "../src/scan.ts";

const NOW = Date.now();

/** Build a tool/call + tool/result event pair as JSONL lines. */
function toolLines(
  callId: string,
  name: string,
  args: unknown,
  resultText: string,
  isError = false,
  turn = 1,
): string[] {
  return [
    JSON.stringify({
      type: "tool/call",
      data: { turn, step: 1, callId, name, arguments: JSON.stringify(args) },
    }),
    JSON.stringify({
      type: "tool/result",
      data: {
        message: {
          source: { callId },
          content: [
            { type: "tool-result", toolCallId: callId, content: [{ type: "text", text: resultText }], isError },
          ],
        },
      },
    }),
  ];
}

function headerLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "session",
    ts: NOW,
    data: { origin: "user", delegationDepth: 0, ...overrides },
  });
}

describe("parseStream", () => {
  it("normalizes tool calls and pairs results, including args JSON-string parsing", () => {
    const text = [
      headerLine(),
      ...toolLines("c1", "read", { file_path: "/a/b.ts" }, "file body"),
    ].join("\n");
    const parsed = parseStream("proj", "s1", text);
    expect(parsed.records).toHaveLength(1);
    const record = parsed.records[0]!;
    expect(record.name).toBe("read");
    expect(record.args).toEqual({ file_path: "/a/b.ts" });
    expect(record.argsRaw).toBe('{"file_path":"/a/b.ts"}');
    expect(record.resultChars).toBe(9);
    expect(record.resultText).toBe("file body");
    expect(record.isError).toBe(false);
    expect(parsed.meta.origin).toBe("user");
    expect(parsed.headerTs).toBe(NOW);
  });

  it("tolerates args that are not valid JSON (args = null, never throws)", () => {
    const text = [
      headerLine(),
      JSON.stringify({
        type: "tool/call",
        data: { turn: 1, step: 1, callId: "c1", name: "read", arguments: "{not json" },
      }),
    ].join("\n");
    const parsed = parseStream("proj", "s1", text);
    expect(parsed.records[0]!.args).toBeNull();
  });

  it("ignores a truncated last line and counts corrupt middle lines", () => {
    const good = headerLine();
    const text = [
      good,
      "{corrupt middle",
      ...toolLines("c1", "read", {}, "ok"),
      '{"type":"tool/ca',
    ].join("\n");
    const parsed = parseStream("proj", "s1", text);
    expect(parsed.corruptLinesSkipped).toBe(1);
    expect(parsed.truncatedTail).toBe(true);
    expect(parsed.linesParsed).toBe(3); // header + call + result
    expect(parsed.records).toHaveLength(1);
  });

  it("records approval pairs and policy-never", () => {
    const text = [
      headerLine(),
      JSON.stringify({ type: "approval/policy", data: { policy: "never", source: "delegation" } }),
      JSON.stringify({ type: "approval/asked", data: { id: "a1", toolName: "bash", callId: "c1", reason: "risky" } }),
      JSON.stringify({ type: "approval/decided", data: { id: "a1", outcome: "rejected" } }),
].join("\n");
    const parsed = parseStream("proj", "s1", text);
    expect(parsed.meta.policyNever).toBe(true);
    expect(parsed.approvals).toEqual([
      { project: "proj", sessionId: "s1", id: "a1", toolName: "bash", callId: "c1", reason: "risky", outcome: "rejected" },
    ]);
  });

  it("pairs decided events arriving before asked events", () => {
    const text = [
      headerLine(),
      JSON.stringify({ type: "approval/decided", data: { id: "a1", outcome: "rejected" } }),
      JSON.stringify({ type: "approval/asked", data: { id: "a1", toolName: "bash" } }),
    ].join("\n");
    const parsed = parseStream("proj", "s1", text);
    expect(parsed.approvals[0]!.outcome).toBe("rejected");
    expect(parsed.approvals[0]!.toolName).toBe("bash");
  });
});

describe("scanSessions", () => {
  function makeStore(): string {
    const root = mkdtempSync(join(tmpdir(), "forensics-"));
    const dir = join(root, "proj-key", "sess-1");
    mkdirSync(dir, { recursive: true });
    const text = [
      headerLine(),
      ...toolLines("c1", "read", { file_path: "/a/b.ts" }, "body"),
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl.zstd"), Buffer.from(text));
    return root;
  }

  it("reads streams through the injected decompress seam", async () => {
    const root = makeStore();
    const scan = await scanSessions(root, { decompress: async () => headerLine() });
    expect(scan.sessionsScanned).toBe(1);
    expect(scan.linesParsed).toBe(1);
  });

  it("applies the days filter via directory mtime", async () => {
    const root = makeStore();
    const old = new Date(NOW - 30 * 24 * 60 * 60 * 1000);
    utimesSync(join(root, "proj-key", "sess-1"), old, old);
    const scan = await scanSessions(root, { days: 14, decompress: async () => { throw new Error("must not decompress"); } });
    expect(scan.sessionsScanned).toBe(0);
  });

  it("falls back to the header timestamp when mtime is unreasonable", async () => {
    const root = makeStore();
    const old = new Date(0);
    utimesSync(join(root, "proj-key", "sess-1"), old, old);
    const oldHeader = JSON.stringify({ type: "session", ts: NOW - 30 * 24 * 60 * 60 * 1000, data: {} });
    const scan = await scanSessions(root, { days: 14, decompress: async () => oldHeader });
    expect(scan.sessionsScanned).toBe(0);
    const freshHeader = JSON.stringify({ type: "session", ts: NOW, data: {} });
    const scan2 = await scanSessions(root, { days: 14, decompress: async () => freshHeader });
    expect(scan2.sessionsScanned).toBe(1);
  });

  it("decompresses each stream exactly once and returns real content via default-free seam", async () => {
    const root = makeStore();
    let calls = 0;
    const scan = await scanSessions(root, {
      decompress: async () => { calls++; return headerLine(); },
    });
    expect(calls).toBe(1);
    expect(scan.sessionsScanned).toBe(1);
  });
});

describe("decompressJsonl", () => {
  it("shells out to the zstd CLI (round trip if available)", async () => {
    const { execFileSync } = await import("node:child_process");
    let zstd: string | undefined;
    try {
      execFileSync("zstd", ["--version"]);
      zstd = "zstd";
    } catch {
      zstd = undefined;
    }
    if (zstd === undefined) return; // env without zstd: skip
    const root = mkdtempSync(join(tmpdir(), "zstd-"));
    const file = join(root, "session.jsonl.zstd");
    execFileSync(zstd, ["-f", "-o", file], { input: headerLine() });
    const text = await decompressJsonl(file);
    expect(JSON.parse(text)).toMatchObject({ type: "session" });
  });
});
