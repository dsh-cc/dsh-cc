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
- `src/sampling.ts` — receipt-row sampling harness per §8: dogfood 20%
  (min 5, ceil) then post-acceptance 5%; `K = 20` expected atomic facts
  (SAFE convention, arXiv 2403.18802 — a metric parameter, never a
  sampling ratio); labels `supported | partially | unsupported |
  irrelevant`; `F1@K` computation; the judge-lane budget table (numbers
  are first-budget estimates, recalibrated by dogfood). Judge calls are
  NOT wired at P2 (§4.4) — interfaces and schemas only.
- `scripts/baseline.mjs` — P0(3) coverage baseline: runs the extractor
  over the gold set and writes `baselines/<date>-P0-coverage-baseline.json`
  (detected-claim counts per family, documents with claims, candidate
  coverage denominator). Recalibration lands after one dogfood week (§8).

## Tests

`pnpm vitest run packages/evaluation/vwa-eval` — selector determinism and
`--check` round-trip, sha256 against live files, sampling math (ceil/min
rules, budget pins, a hand-computed F1@K), sentence-export shape.
