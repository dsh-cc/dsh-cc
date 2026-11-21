# @dsh-cc/math-eval

Structure-only evaluation tooling for the [Mathematical Research Harness](../../plugin/dsh-cc-math) — benchmarks, a strict run-manifest schema, the 9-config compute-matched ablation matrix, and the scorer contract for measuring what the math plugin actually adds.

## Status

Skeleton. Types, manifest validation, the ablation matrix, and structure checks are real; the scorer's kernel-check integration and the offline runner arrive with the M1/M2 waves. CI runs structure tests only — no model calls ever.

## What is pinned here

- `src/manifest.ts` — strict run-manifest schema with documented defaults (`attempts=8`, `tokens=200000`, `wallClockMs=1800000`, `allowHumanFidelity=false`, `tierPolicy="main"`, `discovery=null`).
- `src/ablation.ts` — the nine ablation configs (A–H plus F1, the single-attempt search variant) and the four isolated attribution contrasts (C→D retrieval, C→E feedback, H→F search, F→G experience).
- `src/scorer.ts` — the scoring contract: a candidate passes only if its statement is kernel type-equal to the benchmark's reference statement AND its own proof passes the full L2 check; restating the benchmark theorem does not pass.
- `fixtures/gold-set.json` — split and license records. Benchmark ingestion (miniF2F / ProofNet / PutnamBench subsets) is a later wave; every fixture must record `{source, license, fetchedAt, sha256, problemIds}` and redistribution-forbidding licenses fail the check.

## Usage

```sh
pnpm --filter @dsh-cc/math-eval run check   # structure check (also root: pnpm math-eval:check)
pnpm --filter @dsh-cc/math-eval test        # vitest structure tests
```

Real evaluation runs are offline and on demand — never in CI.

## Design source

`docs/plans/2026-11-21-mathematical-research-harness.md` §8–§9.
