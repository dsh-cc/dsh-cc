# @dsh-cc/token-efficiency

Token-efficiency eval harness for dsh-cc: fixed corpus, frozen acceptance gate, and a comparator (plan `docs/plans/2026-09-20-token-efficiency-eval-harness.md`). Slice A ships the redactor and corpus loader only.

## Tier semantics

- **replay** — metric-definition regression suite. Vectors are a deterministic function of (fixed sanitized fixture, current `metrics.ts`). A replay vector change means the metric definitions changed; a green replay tier never evidences a feature's savings. The only replay failure mode is parse/fold error.
- **mock-script** — feature-wiring regression suite. MockAdapter-scripted runs assert that features fire (or correctly don't) and that metric folding records the traffic. Two scripts per feature: a fires-case and a doesn't-fire control.
- **live** — the only home of improvement claims. Held-out, per-PR, run by hand; results attach to the PR as evidence and never feed back into tuning the same candidate.

## Discipline rules (binding)

1. `eval-gate.yaml` changes land alone — enforced by the presubmit freeze check.
2. Live-tier results never tune the candidate they measure.
3. Baseline refreshes are their own PRs; `metrics.ts` changes force a refresh.
4. Every efficiency-claiming PR runs the tiers and pastes the report head line into the PR description.

## Corpus layout

Descriptor YAML files live centrally under this package's `corpus/`; sanitized replay fixtures under `fixtures/`. Recorded choice (plan §3.2 vs §6): **v1 uses a central `corpus/` under this package; per-feature colocation remains possible via fixture paths.**

Raw session logs are never committed; the redactor (`src/redactor.ts`) produces byte-stable sanitized blobs for review and commit.

## CLI (bin)

`pnpm check:token-efficiency` runs `check` with package defaults; the bin itself is tsx-run (`pnpm exec tsx packages/test-support/token-efficiency/src/bin.ts <subcommand> …`):

- `sanitize <session.jsonl|.zstd|-> [--out <path>]` — raw log → canonical sanitized JSONL (Phase-0 dogfooding). `--out` requires exactly one input; otherwise stdout.
- `run [--gate <path>] [--corpus <dir>] [--write-baseline <path>]` — folds every replay task's fixture; prints one line per task vector (tokens, cost, counters) and the footer. `--write-baseline` writes `{foldedAt, ref: $TOKEN_EFFICIENCY_BASELINE_REF ?? 'unpinned', vectors}`.
- `check [--gate <path>] [--corpus <dir>]` — gate + baseline load, candidate fold, per-task verdicts, per-task usage-coverage lines, footer. Exit 1 on parse failure, capability regression, definition change, counter-expectation miss, or missing candidate/baseline vector; exit 2 on usage error.

Non-replay tasks are skipped with a one-line deferral notice; the mock-script runner is a later slice.

Every run ends with the footer:

> token-efficiency tiers: replay = metric-definition stability only (a green replay tier is NOT savings evidence) · mock-script = wiring regression · improvement claims belong to the live tier only

## Presubmit gate (freeze + rot)

`scripts/check-eval-gate.mjs` (CI step `check:eval-gate`, PR-only) enforces the discipline over the net PR diff vs `origin/main`:

1. **Freeze** — `eval-gate.yaml` modified or deleted together with any `packages/**/src` change is rejected: the gate lands alone. **Exemption:** creating the gate in the PR (net status A) is the bootstrap case and is silent.
2. **Rot** — `src/metrics.ts` added or modified without the gate's `baseline.vector` file being added/modified in the same diff is rejected. Skipped (with a log line) when `eval-gate.yaml` is absent or unparseable on disk.

The live tier is Phase 2 deferred: manual-only runs behind a one-way valve, with ≥3 hand runs before any nightly scheduling is considered.

## Mock-script tier (wiring regression)

`corpus/mock/*.yaml` descriptors are executed by the mock-tier runner
(`src/mock-run.ts`, plan §3.2): each task id maps to a scenario that boots the
REAL plugin stack — real agent loop, real tools runtime, real token meter, real
feature plugin (ContextCrusher / CompactionCostGate), and a REAL basic
compaction engine — with a scripted `MockAdapter` standing in only for the LLM
(context-crusher `composition.spec.ts` precedent). A scenario drives the agent
loop on the descriptor `prompt`, collects the outcome through the real session
surface accessor (`session.surface.nodes` + `session.eventAt`, never
`snapshotEvents()`), and folds:

- `foldMetricVector(events, { task })` — the shared token/cost axes (reported, never gate mock tier);
- the feature-owned `foldCounters` exported from the `@dsh-cc/context-crusher`
  and `@dsh-cc/compaction-cost-gate` package roots (§3.4) merged into `counters`;
- `capability: { ok }` — the scripted run completed cleanly to its final text.

Unknown mock id → loud error (no silent drop). Mock vectors are never written
into the baseline blob: the gate evaluates them on `capability.ok` +
`counters.expect` only.

### Tasks

- `mock/ccr-fires` — crusher enabled, `biggrep` output crosses the min-bytes gate; expects `ccr.applied >= 1`.
- `mock/ccr-control` — crusher enabled, output below min-bytes; expects `ccr.applied = 0`.
- `mock/costgate-fires` — `todo_write` completion arms the boundary, idle fires the gate with a tiny margin, the REAL compaction engine executes end-to-end; expects `costgate.gate >= 1` and `costgate.compacted >= 1`.
- `mock/costgate-control` — gate armed and evaluated but the inequality fails (large margin); expects `costgate.gate >= 1`, `costgate.compacted = 0`.

> Note: committed replay fixtures currently fold ccr.* counters to zero — no genuine CCR production markers appear in the source sessions; genuine counter coverage lives in the mock tier (ccr-fires/ccr-control)
