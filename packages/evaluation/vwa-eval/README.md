# @dsh-cc/vwa-eval

Evaluation tooling for the Verifiable Workspace Agent (design
`docs/plans/2026-10-12-verifiable-workspace-agent.md` §8). Plain node
tooling — **never boot-mounted as a plugin**; run from the repo root via
the scripts below or the package scripts.

## Contents

- `gold-set.json` — the pinned 30-document gold set (15 `docs/**` + 15
  package READMEs), each entry `{path, sha256, bytes}`; the pinned bytes
  live in `fixtures/gold/<path>`. Verify, or deliberately re-pin:
  ```
  node packages/evaluation/vwa-eval/scripts/select-gold.mjs --check
  node packages/evaluation/vwa-eval/scripts/select-gold.mjs --write
  ```
  `--check` validates only the snapshot and fails loudly (path + reason) if
  a snapshot file is missing, edited or stray; live repo docs are never
  consulted, so docs churn cannot break it. `--write` re-selects from the
  live repo and replaces the snapshot.
  Selection is regex-free, locale-independent (code-unit sorts only).
- `scripts/annotate.mjs` — sentence-level annotation lane: `export` dumps
  every gold-set sentence (via `@dsh-cc/vwa-evidence`'s sentence splitting
  and frozen four-family detector), `merge` combines annotator A/B files
  with the user adjudication into `annotations/gold-annotations.json`,
  `recall` prints detector recall (human-verifiable sentences the detector
  found) so a silent under-detector cannot inflate coverage.
- `src/annotation.ts`: the annotation lane's implementation, re-exported by
  `src/index.ts:1-8`. It covers gold-set loading, sentence splitting with the
  frozen four-family detector, the dual-annotation merge into
  `vwa-eval/gold-annotations@1`, and detector recall.
- `scripts/baseline.mjs` — P0(3) coverage baseline: runs the extractor
  over the gold set and writes `baselines/<date>-P0-coverage-baseline.json`
  (detected-claim counts per family, documents with claims, candidate
  coverage denominator). Recalibration lands after one dogfood week (§8).

- `src/scorer.ts` — the frozen `humanities-scorer@1` (design
  `docs/plans/2026-10-16-vwa-evidence-argument.md` §22.2): pure functions for
  atomic-claim matching (edit similarity and span IoU), claim split/merge
  credit, core recall, major-fault recall, clean false-positive rate, support
  macro-F1 over `direct | inferential | partial | contradicted | irrelevant`,
  and deterministic bootstrap confidence intervals (seed `20261016`, 10,000
  resamples; CIs are disclosed, never used as thresholds). No fs, no model
  calls.
- `humanities/` + `scripts/build-humanities-manifest.mjs` — the humanities
  gold manifest (`gold-manifest.json`, schema `gold-manifest.schema.json`)
  built from `humanities/cases/*.json` (three synthetic development cases at
  present): SHA-256 per case, domain stratum, and the frozen dev/holdout split
  (sorted by id, every third case holdout). `--check` recomputes and diffs
  against the committed manifest.

## Tests

`pnpm vitest run packages/evaluation/vwa-eval` covers two suites.
`tests/gold-set.spec.ts` checks the 30 sorted gold-set entries, the pinned
sha256 of every snapshot file, and that `--check` ignores live repo docs.
`tests/scorer.spec.ts` covers the frozen humanities scorer primitives, claim
metrics with split/merge credit, major-fault recall and clean-sample false
positives, support macro-F1, the deterministic bootstrap CIs, and the
committed humanities manifest round-trip.
