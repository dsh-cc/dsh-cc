# S1-04 extraction-gate evaluation

Synthetic offline data and the report schema for the memory-extraction decision
gate (design
[`docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md`](../../../../docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md)
§"Release evaluation and rollback"). The gate asks one SystemOne question over a
complete review window — *does this window hold at least one durable novel
fact?* — and may omit the extraction fork only on an explicit low-probability
verdict.

This directory holds the evidence contract for that decision. It does **not**
contain a production-text corpus: every window is fabricated for the gate.

## Layout

- `extraction-golden.json` — 240 synthetic windows (one case per line):
  100 positives, 100 negatives and 40 deterministic-fallback cases.
- `README.md` — this file: label definition, construction, gates, rollout.
- `report-<ISO timestamp>.json` — local artifact of a gated run (gitignored).
  A report produced with the mock runner is stamped `validForRelease: false`
  and is never evidence for a rollout decision.

The runner lives in
[`../tests/eval-extraction-systemone.spec.ts`](../tests/eval-extraction-systemone.spec.ts)
because the root vitest include pattern (`packages/*/*/tests/**/*.spec.ts`) does
not cover `eval/`; no vitest config is modified for it.

## Label definition

> A durable fact the original extraction could obtain from the complete window
> and that is useful in future.

Durable means it still holds in a later session: a user preference, an explicit
correction, a project constraint, a durable tool trap, or a fact confirmed
across messages. Not durable: temporary progress, an entry the existing topic
index already carries, tool noise, and assistant guesses no user or tool message
supports. Two reviewers label each window independently; every disagreement is
counted conservatively as positive (extract), because a false skip loses memory
while a false extract only spends a fork.

## How the set was constructed

All 240 windows are synthetic: no production text, no real user names, no
repository paths or facts, no credentials. Each case carries the window shape the
gate actually reviews — `fromExclusive`, `throughInclusive`, ordered
`{seq, kind, text}` events and the existing topic index — so a run rebuilds it
through `buildExtractionWindow` without translation.

| Class | Count | Subclasses (windows each) |
| --- | --- | --- |
| positive (expected `extract`) | 100 | `user-preference` (20), `explicit-correction` (20), `project-constraint` (20), `tool-trap` (20), `cross-message-confirmation` (20) |
| negative (expected `skip`) | 100 | `progress-only` (30), `duplicate-index-entry` (25), `tool-noise` (25), `unconfirmed-assistant-guess` (20) |
| fallback (expected `fallback-extract`) | 40 | `incomplete-window` (15), `over-budget` (15), `source-changed` (10) |

Positives also carry a `factClass` (the durable class) and the negatives cover
the four documented negative families. The fallback cases carry a `defect`, so
the deterministic half is data, not prose:

| `defect.kind` | What the harness injects | Expected fallback |
| --- | --- | --- |
| `image-block` | a non-text content block in a user message | `incomplete` |
| `missing-seq` | a surface event whose `seq` cannot be read | `incomplete` |
| `compacted-range` | a surface replacement intersecting the window | `incomplete` |
| `index-failed` | the topic-index read fails | `incomplete` |
| `index-truncated` | a 205-line index over the injection cap | `incomplete` |
| `over-budget` | the case's own `budgets` (event count, state bytes, input tokens) | `over-budget` |
| `source-changed` | the evidence head moves between the gate answer and the commit | `source-changed` (skip discarded, next stop extracts) |

The `stubPolicy` field documents how the offline harness answers: by class, so
both the extract and the skip path are exercised. That is scaffolding, **not** a
model measurement.

## Offline gates

A rollout past `shadow` must satisfy all of these on the frozen data and
thresholds (design §"Release evaluation and rollback"):

1. zero false skips on positive windows;
2. zero false skips in the `explicit-correction` and `user-preference`
   subclasses;
3. zero skips on incomplete windows (and no incomplete or over-budget window is
   ever sent to the decision model);
4. fact recall for facts that actually produced memory no lower than the
   always-extract baseline;
5. total cost — decision model, fallback, audit forks and every failure
   reservation — below that baseline.

Passing on this limited sample cannot claim zero missed memories overall; it only
qualifies the next stage. Anything else stays `off`.

## Running the harness

From the repo root:

```
DSH_EXTRACTION_EVAL=1 pnpm vitest run packages/memory/memory-consolidation/tests/eval-extraction-systemone.spec.ts
```

Without `DSH_EXTRACTION_EVAL=1` the suite skips. With it, the spec validates the
golden file, rebuilds every window through the real builder and runs it through
the real gate with a fake bound runner (no route, no network, no model). It then
writes `report-<ISO timestamp>.json` here and asserts two things only:

- the report schema (per-window probability, expected label, actual action,
  audit, fallback, usage, wall time);
- the deterministic fallback: all 40 fallback windows extract, none skips, and
  the 30 incomplete/over-budget windows never reach the decision model.

The report is stamped `releaseConclusion: 'invalid-for-release'`. **A mock report
must never be attached to a rollout decision.** An accuracy claim needs the real
configured decision route, at least three runs over the frozen set, the same
generative route as the always-extract baseline, and the checkpoint/revision
pinned in the report; that is an operator run, not this harness.

## Private input

A complete window means the configured decision route receives current session
text plus the existing topic index — more than the candidate metadata a recall
selector sees. It is sent only when that route is configured and the mode is
explicitly `shadow` or `active`; nothing is sent with the default `off`. No
credentials, request headers, tool arguments or absolute paths enter the state,
and no memory file or event type is added to hold gate state: the watermark,
skip ordinal, lease and hashes live in process memory only.

## Rollout

1. Enable `shadow` explicitly. Accumulate at least 100 synthetic or authorised,
   de-identified replay windows that meet the completeness requirement; every
   would-skip window that is labelled positive is checked by hand.
2. Only then enable `active`, and only in a designated workspace.

Set the mode back to `off` immediately if an audit fork finds any durable fact, a
cross-repo write, a watermark that jumped past an unfinished job, or a concurrent
overwrite of the same memory directory. Audit content is compared and labelled by
the operator against the memory before and after the audit — non-empty writes do
not by themselves mean a new fact — and facts an audit found are saved through
host validation as usual: they are never dropped because the verdict failed. The
feature never changes its own configuration.

## Rollback

Set `mode: off` (or remove the namespace). The coordinator cancels the new gate,
waits for the write lease to be released and for in-flight jobs to abort, then
hands dispatch back to the legacy extraction listener. In-memory watermarks and
skip counts are discarded; on-disk memory is neither migrated nor deleted, and the
dream lock returns to its original rollback path. A process restart or LRU
eviction simply starts again at watermark `-1`, preferring a repeated extraction
over a permanently missed memory. The default mode stays `off`; flipping the
default needs its own evaluation evidence and change review.
