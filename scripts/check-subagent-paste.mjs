#!/usr/bin/env node
/**
 * check-subagent-paste.mjs — Stop hook that flags when the assistant
 * pastes a subagent's output verbatim (a ≥40-line quoted block carrying
 * agent-contract headers) instead of distilling it — a violation of the
 * AGENTS.md context-discipline rule.
 *
 * Hook protocol (canonical): https://code.claude.com/docs/en/hooks
 *   - On HIT (default mode): print {"systemMessage": ...} to stdout.
 *   - Strict mode (SUBAGENT_PASTE_HOOK=block): print {"decision":"block",...}.
 *   - Fail-closed: any parse/read/missing-field error → silent exit 0;
 *     a broken hook must never block the workflow.
 *   - In strict mode, bail when stdin.stop_hook_active === true to avoid
 *     the 8× block-cap loop.
 *
 * NOTE: deliberately conservative — prefer misses over false positives.
 */
import { readFileSync } from "node:fs";

const SYSTEM_MSG =
  "⚠️ 疑似整段转述 subagent 输出（违反 AGENTS.md 上下文纪律），请提炼综合而非转述。";
const BLOCK_REASON =
  "疑似整段转述 subagent 输出（违反 AGENTS.md 上下文纪律）。请提炼综合为结论，不要整段转述 subagent 返回。";

// fast-worker contract pair: a Changed header line + a Deviations: line.
const CHANGED_RE = /^-?\s*\*\*Changed\*\*|^Changed:/;
const DEVIATIONS_RE = /Deviations:/;
// deep-reasoner contract pair: Recommendation: + Risks/unknowns:.
const RECOMMENDATION_RE = /Recommendation:/;
const RISKS_RE = /Risks\/unknowns:|\*\*Risks\/unknowns\*\*/;

function hasAnyPair(lines, text) {
  const changed = lines.some((l) => CHANGED_RE.test(l));
  const deviations = DEVIATIONS_RE.test(text);
  const fastWorker = changed && deviations;
  const deepReasoner = RECOMMENDATION_RE.test(text) && RISKS_RE.test(text);
  return fastWorker || deepReasoner;
}

// Read all of stdin (fail-closed on any error).
let raw;
try {
  raw = readFileSync(0, "utf-8");
} catch {
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0);
}

if (payload === null || typeof payload !== "object") {
  process.exit(0);
}

// Strict mode (default OFF).
const strict = process.env.SUBAGENT_PASTE_HOOK === "block";
if (strict && payload.stop_hook_active === true) {
  process.exit(0);
}

const msg = payload.last_assistant_message;
if (typeof msg !== "string") {
  process.exit(0);
}

const lines = msg.split("\n");
let hit = false;

// 1) Maximal runs of consecutive '>'-quoted lines (optional leading ws).
//    Strip the '>' quote marker before scanning content for contract
//    headers, so anchored header regexes still match `> Changed:` etc.
let i = 0;
while (i < lines.length && !hit) {
  if (/^\s*>/.test(lines[i])) {
    const start = i;
    while (i < lines.length && /^\s*>/.test(lines[i])) i++;
    const run = lines.slice(start, i);
    if (run.length >= 40) {
      const stripped = run.map((l) => l.replace(/^\s*>\s?/, ""));
      if (hasAnyPair(stripped, stripped.join("\n"))) hit = true;
    }
  } else {
    i++;
  }
}

// 2) Fenced ``` ... ``` regions (raw content; ≥40 lines between fences).
if (!hit) {
  let inFence = false;
  let fenceStart = -1;
  for (let j = 0; j < lines.length && !hit; j++) {
    if (/^\s*```/.test(lines[j])) {
      if (!inFence) {
        inFence = true;
        fenceStart = j + 1; // exclude the opening fence line
      } else {
        const region = lines.slice(fenceStart, j); // excludes both fence lines
        if (region.length >= 40 && hasAnyPair(region, region.join("\n"))) {
          hit = true;
        }
        inFence = false;
      }
    }
  }
}

if (!hit) {
  process.exit(0);
}

if (strict) {
  process.stdout.write(JSON.stringify({ decision: "block", reason: BLOCK_REASON }));
} else {
  process.stdout.write(JSON.stringify({ systemMessage: SYSTEM_MSG }));
}
process.exit(0);
