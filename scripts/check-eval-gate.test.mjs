#!/usr/bin/env node
/* Test fixtures for check-eval-gate.mjs: synthetic changeset table for the freeze/rot rules */
import { findEvalGateProblems } from "./check-eval-gate.mjs";
import assert from "node:assert/strict";

const PKG = "packages/test-support/token-efficiency";
const VECTOR = `${PKG}/fixtures/baseline-vectors.json`;
const c = (status, path) => ({ status, path });

// unrelated files only → pass
assert.deepEqual(
  findEvalGateProblems([c("A", "README.md"), c("M", "packages/core/x/src/thing.ts")]),
  [],
  "unrelated files must pass",
);

// net-A bootstrap exemption: gate created together with src changes → pass
assert.deepEqual(
  findEvalGateProblems([
    c("A", `${PKG}/eval-gate.yaml`),
    c("A", `${PKG}/src/bin.ts`),
    c("A", "packages/other/src/y.ts"),
  ]),
  [],
  "gate creation (bootstrap) is exempt from freeze",
);

// D on gate + any packages src change → freeze fail
assert.deepEqual(
  findEvalGateProblems([
    c("D", `${PKG}/eval-gate.yaml`),
    c("M", "packages/core/deep/src/x.ts"),
  ]),
  [
    "freeze: eval-gate.yaml changed together with packages/**/src (frozen-acceptance rule; land the gate change alone)",
  ],
  "gate deletion + src change must fail freeze",
);

// M on gate alone → pass (no src files in the diff)
assert.deepEqual(findEvalGateProblems([c("M", `${PKG}/eval-gate.yaml`)]), []);

// metrics A + baseline A → rot pass
assert.deepEqual(
  findEvalGateProblems([c("A", `${PKG}/src/metrics.ts`), c("A", VECTOR)]),
  [],
  "metrics + baseline refreshed together must pass",
);

// metrics M + baseline absent → rot fail
assert.deepEqual(
  findEvalGateProblems([c("M", `${PKG}/src/metrics.ts`)]),
  [
    "rot: metrics.ts changed without refreshing the baseline vector (fold candidate+baseline with the same definitions)",
  ],
  "metrics change without baseline refresh must fail rot",
);

console.log("check-eval-gate fixture suite OK (freeze net-A exemption, freeze D+src, rot paired/missing, unrelated pass)");
