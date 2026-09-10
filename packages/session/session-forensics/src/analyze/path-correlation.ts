/**
 * Analyzer 1 — success correlation on path-ish tools.
 *
 * Finds failures where a later, same-tool success recovered by pointing at a
 * different directory (same basename). Gated: the failure's error text must be
 * path-shaped, otherwise logic/test failures leak in.
 */
import type { Finding, ToolRecord } from "../types.ts";
import { anchor } from "../types.ts";

export const CORRELATION_TOOLS = new Set([
  "read",
  "edit",
  "glob",
  "grep",
  "bash",
]);

/** Path-shaped failure markers (case-insensitive). */
const PATH_ERROR = /enoent|no such file|not found/i;

function norm(name: string): string {
  return name.toLowerCase();
}

/** Extract path-like strings from a tool's parsed args object. */
export function extractPaths(args: unknown): string[] {
  if (typeof args !== "object" || args === null) return [];
  const paths: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (typeof value === "string") {
      if (
        key === "file_path" ||
        key === "notebook_path" ||
        key === "path" ||
        key === "directory" ||
        key === "cwd"
      ) {
        paths.push(value);
      }
    }
  }
  return paths;
}

/** Split a bash command into tokens, stripping trailing punctuation. */
function bashTokens(command: string): string[] {
  return command
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/[.,;:)'"`]+$/, ""));
}

const PATHISH_TOKEN = /\/[^\s/]+\.[a-z]{1,4}$/i;

function pathishTokens(command: string): string[] {
  const tokens = bashTokens(command);
  const paths = new Set<string>();
  for (const token of tokens) {
    if (token.includes("/") || PATHISH_TOKEN.test(token)) {
      paths.add(token.toLowerCase());
    }
  }
  return [...paths];
}

function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

function dir(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(0, idx);
}

/** Emit "prefer <goodDir>/ over <badDir> for <file>" findings for one session. */
export function correlatePaths(records: ToolRecord[]): Finding[] {
  const findings: Finding[] = [];
  const tools = [...records].filter((r) => CORRELATION_TOOLS.has(norm(r.name)));

  for (let i = 0; i < tools.length; i++) {
    const failure = tools[i]!;
    if (!failure.isError || !PATH_ERROR.test(failure.resultText)) continue;
    const nName = norm(failure.name);

    if (nName === "bash") {
      const cmd =
        typeof (failure.args as Record<string, unknown>)?.command === "string"
          ? ((failure.args as Record<string, unknown>).command as string)
          : "";
      const first = bashTokens(cmd)[0];
      // ponytail: bare first-token comparison ("pnpm", "node" alone are noise)
      // and raw token sets — a real argv/shell parser would cut false
      // positives; upgrade when the 20-finding manual gate says so.
      if (first === undefined) continue;
      const failedPaths = pathishTokens(cmd);
      for (let j = i + 1; j < tools.length; j++) {
        const success = tools[j]!;
        if (norm(success.name) !== nName || success.isError) continue;
        const cmd2 =
          typeof (success.args as Record<string, unknown>)?.command === "string"
            ? ((success.args as Record<string, unknown>).command as string)
            : "";
        if (bashTokens(cmd2)[0] !== first) continue;
        const good = pathishTokens(cmd2).find(
          (t) => !failedPaths.some((f) => f === t),
        );
        if (good === undefined) continue;
        const token = basename(good);
        if (!success.resultText.toLowerCase().includes(token.toLowerCase()))
          continue;
        findings.push({
          kind: "path-correlation",
          title: `prefer corrected path for \`${token}\` in \`${first}\` commands`,
          detail: `\`${cmd}\` failed; \`${cmd2}\` succeeded. Reuse the working path.`,
          occurrences: 1,
          evidence: [anchor(failure.sessionId, failure.turn)],
        });
        break;
      }
      continue;
    }

    const failedPaths = extractPaths(failure.args);
    for (let j = i + 1; j < tools.length; j++) {
      const success = tools[j]!;
      if (norm(success.name) !== nName || success.isError) continue;
      const goodPaths = extractPaths(success.args);
      const match = goodPaths.find((good) =>
        failedPaths.some(
          (bad) =>
            basename(bad) === basename(good) &&
            dir(bad) !== dir(good) &&
            success.resultText.includes(basename(good)),
        ),
      );
      if (match === undefined) continue;
      const bad = failedPaths.find(
        (p) => basename(p) === basename(match) && dir(p) !== dir(match),
      );
      if (bad === undefined) continue;
      findings.push({
        kind: "path-correlation",
        title: `prefer ${dir(match)}/ over ${dir(bad)} for ${basename(match)}`,
        detail: `${failure.name} failed on ${bad}, succeeded on ${match}.`,
        occurrences: 1,
        evidence: [anchor(failure.sessionId, failure.turn)],
      });
      break;
    }
  }
  return findings;
}
