# W4 — Recall-selection quality eval harness

Measures whether the recall selector picks the right topic files, and produces
the paired comparison that gates any future flip of the `recallUseSmallFast`
default (selector model: inherited main model → haiku alias). **The flip itself
is not part of this change** — this harness only produces the evidence.

A third, SystemOne arm scores the same fixture pool, golden queries and metrics
against the probabilistic decision selector (design
`docs/plans/2026-11-02-systemone-03-memory-recall.md`, feature S1-03), so the
W4 gate can compare three arms from the same inputs.

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
- `report-<ISO-timestamp>.json` — output of a baseline-arm run (artifact of the
  gate).
- `report-systemone-<ISO-timestamp>.json` — output of a SystemOne-arm run.

The vitest specs live in `../tests/eval-harness.spec.ts` (ungated validators +
metric-math unit tests), `../tests/eval-recall-run.spec.ts` (the gated
baseline-arm runner) and `../tests/eval-recall-systemone.spec.ts` (the gated
decision-model arm) because the root vitest include pattern
(`packages/*/*/tests/**/*.spec.ts`) does not cover `eval/` — no vitest config
was modified.

## Running

Baseline arms, from the repo root:

```
DSH_RECALL_EVAL=1 pnpm vitest run packages/memory/memory/tests/eval-recall-run.spec.ts
```

Requires:

- the `haiku` alias resolvable — point `DSH_RECALL_EVAL_ROUTES` at its route
  JSON (e.g. `DSH_RECALL_EVAL_ROUTES='{"provider":"deepseek","model":"deepseek-chat"}'`);
  without it the suite **skips cleanly**.
- a real model adapter: set `DSH_RECALL_EVAL_PROVIDER` (provider name) and
  `DSH_RECALL_EVAL_ADAPTER_MODULE` (module path whose default export is an
  adapter instance) so the booted real subagent stack can serve completions.
  Without an adapter the run completes but every selection is empty — do not
  attach such a report to a flip.

Decision-model arm:

```
DSH_RECALL_EVAL=1 \
DSH_RECALL_SYSTEMONE_ROUTE='{"provider":"…","model":"…","protocol":"systemone"}' \
DSH_RECALL_SYSTEMONE_ROUTES='{"gauge":{"revision":"…","actual-model-id":"…"}}' \
DSH_RECALL_SYSTEMONE_CONNECTION='{"baseURL":"https://…","apiKeyEnv":"…"}' \
pnpm vitest run packages/memory/memory/tests/eval-recall-systemone.spec.ts
```

Requires (any missing piece makes the suite **skip**, never fail):

- `DSH_RECALL_SYSTEMONE_ROUTE` — the concrete route the lane alias (`gauge`)
  resolves to, as the `ccModelRoutes` layer reports it. Only
  `protocol: "systemone"` counts; a chat route is not a decision route. The alias
  itself is not a setting: every consumer pins the exported lane constant.
- optional `DSH_RECALL_SYSTEMONE_ROUTES` — the `systemone-decisions` `routes`
  dict (pin rows keyed by alias, the same shape the settings namespace accepts).
  A row can only narrow the alias route: `revision` (default: the wire model id),
  `actual-model-id` (absent: no version pin, so S1-01 validation alone applies),
  `per-request-tokens` / `per-question-tokens` (default: the measured per-model
  window), `max-output-tokens` (`32768`) and `max-questions` (`32`). An absent
  row runs exactly those defaults; a present row with an invalid field resolves
  to unconfigured, as in the host service.
- `DSH_RECALL_SYSTEMONE_CONNECTION` — the provider record's `baseURL`, plus the
  `apiKeyEnv` name of the credential. **Credentials come only from the existing
  route configuration**: the spec reads the named environment variable the way
  the host service's env fallback does, and never invents a key.
- optional `DSH_RECALL_SYSTEMONE_SETTINGS` — a JSON object of the kebab-case
  `cc-systemone-memory-recall` section (thresholds, batch and size limits).
  `mode` is forced to `active` for this arm; everything else falls back to the
  design defaults.

The arm drives the production wire stack (`createDecisionRunner` → the
SystemOne client → a real `fetch`) through the same `SystemOneRecallDecisionSelector`
the coordinator uses. The **ledger append and the session quota reservation are
eval seams** — the production `@dsh-cc/decision-usage` service is not a
dependency of this package — so usage in the report is the wire envelope's own
token counts, not a ledger projection; run the quota/ledger gate separately.

Without `DSH_RECALL_EVAL=1` both runners skip; `tests/eval-harness.spec.ts`
always runs (fixture + golden validators, metric math).

## Report

JSON only. Baseline arms (`report-<ISO-timestamp>.json`): per-arm per-query
selections, per-arm per-class + overall precision/recall/F1 over the required
set (tolerated extras don't hurt precision; unlisted selections do), and paired
per-query Jaccard agreement between arms. No latency metric; no token
accounting (the result object exposes none).

SystemOne arm (`report-systemone-<ISO-timestamp>.json`): one record per golden
query with the candidate count, batch count, whole-selection latency, status
(`selected`/`fallback`/`cancelled`), the fixed **fallback reason** (a closed
enum — never a query, filename or path), the delivered fixture filenames and
their probabilities, the per-query score, the **usage** tokens of that query's
batches, the per-batch runner unavailability reasons and the answered-batch
count. Above the records: the same per-class + overall metrics, latency
mean/p50/p95/max, the delivered recall, summed usage, the fallback-reason
histogram and `answeredBatches` (0 means no decision answer arrived at all).

Reports store **no credentials**: the route is identified by
alias/provider/model/revision only — `baseURL`, `apiKey` and the credential
variable never enter the file. Golden queries and fixture names are synthetic,
which is the design's explicit offline-evaluation allowance.

## PRE-REGISTERED GATE

A future flip of the `recallUseSmallFast` default (inherited model → haiku
alias) is legitimate **iff**:

1. haiku-arm F1 ≥ strong(inherited)-arm F1 − 0.03, **and**
2. no query class shows a zero-hit collapse (a class whose haiku-arm hits
   drop to zero across all its queries while the strong arm hits).

The generated `report-*.json` must be attached to the flip PR. Runs on a mock
adapter do not satisfy the gate.

For the SystemOne arm the same W4 floor applies relative to the inherited
baseline, plus the design's own addition (feature S1-03): the
`no-relevant-memory` mis-injection rate must not exceed the baseline's. A
SystemOne report is evidence only when `answeredBatches > 0` — a run that
skipped the gate, used mocks or answered nothing proves nothing.

