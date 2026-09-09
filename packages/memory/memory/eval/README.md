# W4 — Recall-selection quality eval harness

Measures whether the recall selector (`SubagentMemorySelector`) picks the right
topic files, and produces the paired comparison that gates any future flip of
the `recallUseSmallFast` default (selector model: inherited main model → haiku
alias). **The flip itself is not part of this change** — this harness only
produces the evidence.

## Layout

- `fixture-memory/` — 28 synthetic topic files (3 declared distractor
  clusters: `model-aliases`, `vitest`, `sandbox` — each mixes relevant topics
  with lookalikes) + `MEMORY.md` index.
- `golden.json` — 40 queries, 10 per class (`direct-topic`,
  `compositional`, `no-relevant-memory`, `ambiguous-phrasing`), each with
  `required` (must be selected; drives recall) and `tolerated` (acceptable
  extras; never hurt precision). `clusters` declares the distractor groups the
  fixture validator checks.
- `lib.ts` — pure validators + metric math (imported by the specs; not shipped).
- `report-<ISO-timestamp>.json` — output of a run (gitignored artifact of the gate).

The vitest specs live in `../tests/eval-harness.spec.ts` (ungated validators +
metric-math unit tests) and `../tests/eval-recall-run.spec.ts` (the gated eval
runner) because the root vitest include pattern
(`packages/*/*/tests/**/*.spec.ts`) does not cover `eval/` — no vitest config
was modified.

## Running

From the repo root:

```
DSH_RECALL_EVAL=1 pnpm vitest run packages/memory/memory/tests/eval-recall-run.spec.ts
```

Requires:

- the `haiku` alias resolvable — point `DSH_RECALL_EVAL_ROUTES` at its route
  JSON (e.g. `DSH_RECALL_EVAL_ROUTES='{"provider":"anthropic","model":"claude-3-5-haiku"}'`);
  without it the suite **skips cleanly**.
- a real model adapter: set `DSH_RECALL_EVAL_PROVIDER` (provider name) and
  `DSH_RECALL_EVAL_ADAPTER_MODULE` (module path whose default export is an
  adapter instance) so the booted real subagent stack can serve completions.
  Without an adapter the run completes but every selection is empty — do not
  attach such a report to a flip.

Without `DSH_RECALL_EVAL=1` the runner skips; `tests/eval-harness.spec.ts`
always runs (fixture + golden validators, metric math).

## Report

JSON only, written to `eval/report-<ISO-timestamp>.json`: per-arm per-query
selections, per-arm per-class + overall precision/recall/F1 over the required
set (tolerated extras don't hurt precision; unlisted selections do), and
paired per-query Jaccard agreement between arms. No latency metric; no token
accounting (the result object exposes none).

## PRE-REGISTERED GATE

A future flip of the `recallUseSmallFast` default (inherited model → haiku
alias) is legitimate **iff**:

1. haiku-arm F1 ≥ strong(inherited)-arm F1 − 0.03, **and**
2. no query class shows a zero-hit collapse (a class whose haiku-arm hits
   drop to zero across all its queries while the strong arm hits).

The generated `report-*.json` must be attached to the flip PR. Runs on a mock
adapter do not satisfy the gate.
