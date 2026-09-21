#!/usr/bin/env node
/**
 * check-eval-gate.mjs — presubmit gate for the token-efficiency frozen-acceptance
 * discipline (plan docs/plans/2026-09-20-token-efficiency-eval-harness.md §5).
 *
 * Rules over the NET PR diff (`git diff --name-status origin/main...HEAD`; a
 * file created anywhere in the PR has net status A):
 *   1. FREEZE — eval-gate.yaml modified or deleted together with any change
 *      under a packages/<org>/<pkg>/src/ tree → reject: the gate must land alone.
 *      Status A (created in this PR) is the bootstrap exemption.
 *   2. ROT — packages/test-support/token-efficiency/src/metrics.ts added or
 *      modified without the gate's baseline vector file being added/modified in
 *      the same diff → reject: metric definitions and the baseline must refresh
 *      together. Skips with a log line when eval-gate.yaml is absent/unparseable.
 *
 * Exit 0 with "check:eval-gate OK — …" when clean; exit 1 with one line per problem.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

const TOKEN_EFFICIENCY_PKG = "packages/test-support/token-efficiency";
const EVAL_GATE_PATH = `${TOKEN_EFFICIENCY_PKG}/eval-gate.yaml`;
const METRICS_PATH = `${TOKEN_EFFICIENCY_PKG}/src/metrics.ts`;
const SRC_RE = /^packages\/[^/]+\/[^/]+\/src\//;

/** Core pure rule check: net PR changeset → problem strings. */
export function findEvalGateProblems(changes) {
  const statusOf = (path) => changes.find((c) => c.path === path)?.status;
  const problems = [];

  const gateStatus = statusOf(EVAL_GATE_PATH);
  if ((gateStatus === "M" || gateStatus === "D")
    && changes.some((c) => SRC_RE.test(c.path))) {
    problems.push(
      "freeze: eval-gate.yaml changed together with packages/**/src (frozen-acceptance rule; land the gate change alone)",
    );
  }

  const metricsStatus = statusOf(METRICS_PATH);
  if (metricsStatus === "A" || metricsStatus === "M") {
    const baselineVectorPath = readBaselineVectorPath();
    if (baselineVectorPath === undefined) {
      console.log(
        `check:eval-gate: rot rule skipped — ${EVAL_GATE_PATH} absent or unparseable on disk`,
      );
    } else {
      const vectorStatus = statusOf(baselineVectorPath);
      if (vectorStatus !== "A" && vectorStatus !== "M") {
        problems.push(
          "rot: metrics.ts changed without refreshing the baseline vector (fold candidate+baseline with the same definitions)",
        );
      }
    }
  }
  return problems;
}

/** Baseline vector path from eval-gate.yaml (`baseline.vector`), posix-relative to the package dir. */
function readBaselineVectorPath() {
  const gatePath = join(process.cwd(), EVAL_GATE_PATH);
  if (!existsSync(gatePath)) return undefined;
  try {
    const text = readFileSync(gatePath, "utf8");
    const vector = /vector:\s*["']?([^"'\n]+)["']?/.exec(text)?.[1]?.trim();
    if (!vector) return undefined;
    return posix.join(TOKEN_EFFICIENCY_PKG, vector);
  } catch {
    return undefined;
  }
}

function main() {
  const result = spawnSync(
    "git",
    ["diff", "--name-status", "origin/main...HEAD"],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    console.error(
      `check:eval-gate: git diff failed: ${result.stderr?.trim() || result.error?.message || "unknown error"}`,
    );
    process.exitCode = 1;
    return;
  }
  const changes = result.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 2 && /^[AMD]$/.test(parts[0]))
    .map((parts) => ({ status: parts[0], path: parts[1] }));
  const problems = findEvalGateProblems(changes);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
    return;
  }
  console.log(
    `check:eval-gate OK — ${changes.length} changed file(s) satisfy the freeze/rot discipline`,
  );
}

// CLI only; the self-test imports findEvalGateProblems.
if (process.argv[1] && process.argv[1].endsWith("check-eval-gate.mjs")) {
  main();
}
