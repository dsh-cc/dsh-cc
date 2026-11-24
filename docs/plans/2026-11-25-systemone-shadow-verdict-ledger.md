# Shadow-Verdict Ledger for the SystemOne Consumer Features

- Date: 2026-11-25 (r4; three-seat review converged — r1 full review NO-GO/GWC ×3, r2/r3 delta rounds, r4 final micro-confirm: critic GO, codex GO, grok GO-WITH-CHANGES with two non-gating minor wording notes folded)
- Status: Implemented — this ledger, the three feature recorders, and the report script (see `packages/observability/decision-usage/src/shadow-verdicts.ts`, `scripts/shadow-verdict-report.mjs`).
- Program: SystemOne decision features (S1-04 memory-extraction gate, S1-05 tool-discovery, S1-06 skill-recommendation).

## Problem

All three features run in `shadow` on the maintainer profile, but the only durable
evidence shadow produces is the decision-usage ledger (`~/.dsh/decision-usage/
<projectKey>/<sessionId>/usage.jsonl`), which records availability and cost —
dispatch, latency, tokens, outcome — and never the judgment itself. The
pre-registered flip gates for each feature require decision-quality evidence:

| Feature | Pre-registered gate | Data on disk today |
| --- | --- | --- |
| memory-extraction | ≥ 100 shadow windows, every would-skip verdict manually checked (doc 04 §Rollout) | 18 dispatches; would-skip verdicts exist only as in-process `ctx.log` events, never persisted |
| tool-discovery | ≥ 60 labeled shadow-vs-lexical disagreements, one-sided 95% Wilson LCB ≥ 0.60, sampling sidecar as prerequisite (activation plan §"Flip policy") | 26 dispatches; the sidecar was never implemented; disagreement data is never persisted |
| skill-recommendation | ≥ 100 shadow requests, complete-judgment (coverage 1.0) on ≥ 99%, request p95 ≤ effective `timeout-ms` (capacity revision supersedes doc 06's 1500 ms line), metered cost per project | 56 dispatches from one manual verification burst; `judged`/`eligible` are returned to the model but never persisted |

Note on gate authority: doc 06's original `p95 ≤ 1500ms` line was superseded by
the 2026-11-13 capacity revision
(`docs/plans/2026-11-13-skill-recommender-capacity.md`: p95 ≤ effective
`timeout-ms`, complete-judgment = coverage `judged === eligible`, the ≤ 1%
remainder allowed to be `unavailable('timeout')`). Doc 06's own status header
records that supersession; this instrument implements the capacity-revision
gate. All other thresholds are implemented verbatim from their registering
documents.

Waiting longer does not close these gaps: the missing evidence is not sample
count alone but a durable record of what the judge decided, which no amount of
calendar time will produce. This document specifies the missing instrument.

## Goals / Non-goals

Goals:

1. Persist one **evaluation-grain** verdict row per shadow (and active)
   decision evaluation for all three features — one row per extraction window,
   per ToolSearch evaluation, per recommendation request — joinable with the
   existing usage ledger on `decisionId`.
2. Respect the privacy discipline already established for the usage ledger:
   closed, feature-specific payload schemas (no free-text fields, no unknown
   keys), no state or question bodies, no credentials — hashes, enums, counts
   and catalog names only.
3. Provide one report script that evaluates each feature's pre-registered flip
   gate directly and prints boolean PASS/FAIL lines (prose explains, never
   decides).
4. Zero behavior change in shadow/active mode: recording is fire-and-forget
   (callers void the returned promise; the implementation never rejects),
   never throws into the feature path, and never influences the decision.

Non-goals:

- No change to any pre-registered threshold or gate semantics; this design only
  builds the instrument the gates already assume exists.
- No change to mode defaults; `off|shadow|active` semantics are untouched.
- No auto-flip, no auto-configuration, no new settings namespace. Recording is
  unconditional whenever a decision evaluation completes in shadow or active
  mode.
- No labeling automation: disagreement and would-skip labeling stays a human
  workflow; the script only exports the unlabeled queue and computes the
  statistic over labeled rows.

## Design

### Row identity and grain (r1 fold: the join-key redesign)

The usage ledger's `(decisionId, attempt)` pair is minted inside the runner and
is invisible to consumers (`DecisionRun` carries `decisionId` only); two of the
three features aggregate multiple wire decisions per evaluation, and tool-discovery
cache hits share one judgment across waiters. The verdict row therefore defines
its **own** identity instead of borrowing the usage ledger's:

- **Grain** — one row per *evaluation*: one extraction gate verdict (one window,
  one `runner.run`, one `decisionId`), one ToolSearch evaluation (post-cache,
  after `selectNames` — waiters sharing a cached judgment each record their own
  row with their own `max_results`-capped name list), one `recommend()` request
  (all batches).
- **`eventId`** — a uuid minted by the recorder service; it is the row identity
  and the **labeling key** for the human review workflows. Rows are deduplicated
  on it across rotations.
- **`decisionIds: string[]`** — the wire-decision uuids the evaluation consumed
  (`run.decisionId` per batch), the usage-ledger join. Attempt numbers are not
  carried: a `decisionId` already identifies its attempt set in the usage
  ledger (the runner reuses one `decisionId` across retries and keys rows by
  `decisionId` + attempt; joining on `decisionId` alone selects all its rows,
  which is what cost attribution wants). Pre-dispatch terminals
  (`unconfigured`, `cancelled` before dispatch) record an empty array — their
  usage join is legitimately empty, and the report counts them in the request
  denominator exactly as the gates require.

### Ledger: `shadow-verdicts.jsonl`

One new append-only file per decision-usage session directory, sibling of
`usage.jsonl`. Row shape:

```jsonc
{
  "schemaVersion": 1,
  "eventId": "<uuid>",            // row identity; the labeling key
  "time": 1795486845123,          // epoch ms, service-minted
  "feature": "memory-extraction" | "tool-discovery" | "skill-recommendation",
  "mode": "shadow" | "active",   // as the feature observed it at decision time
  "decisionIds": ["<uuid>"],     // usage-ledger join; [] for pre-dispatch terminals
  "payload": { /* feature-specific closed schema, below */ }
}
```

**Writer and serialization (r1 fold).** The writer is owned by the decision-usage
service. All size-check / rotation / torn-tail-repair / write operations for one
directory are serialized through a per-directory in-process promise chain (the
same pattern as `quota.ts`'s `transactionQueues`) — the verdict file takes **no
`quota.lock`**, so a verdict fault can never freeze the quota transaction, but
within one process its own appends are fully ordered. Cross-process interleaving
is handled the same way `usage.jsonl` handles it: each append is a single
`write()` under `O_APPEND`, and the torn-tail newline repair makes a mid-append
crash recoverable (the reader skips blank lines). Durability pattern: open
`a+`, 0600, torn-tail repair, write, fsync — the `appendDecisionRow` pattern.

The session directory is derived **live per call** (harness home + live
projectKey/sessionId), exactly as the service's quota path does — not pinned at
`forAgent` binding time, so a mid-session cwd or session change files rows in
the same directory the usage ledger is writing.

**Size cap and rotation.** When the file exceeds 8 MiB at append time, the
writer renames it to `shadow-verdicts.jsonl.1` (replacing any earlier rotation)
before appending. Rows are small (closed schemas, sub-kilobyte), so 8 MiB is
months of volume at observed rates. The report reads **both** generations and
deduplicates on `eventId`, so rotation never resets the accumulating soak counts.

### Service seam: `recordShadowVerdict` (r1 fold: optional on every consumer face)

All three features reach the same service object, but through **three typed
faces**: memory-consolidation imports the real `BoundDecisionRunner`
(`packages/llm-tuning/systemone/src/decision-types.ts`), tool-search declares its
own structural `DiscoveryRunner`
(`packages/core/tool-search/src/discovery-contract.ts`), skill-recommender its
own structural `SkillRecommendationRunner`
(`packages/skill/skill-recommender/src/types.ts`). The method is therefore
added as **optional on all three interfaces**:

```ts
// added to BoundDecisionRunner, DiscoveryRunner, SkillRecommendationRunner
/** Best-effort verdict append; resolves when safe, never rejects. Callers void the promise. */
recordShadowVerdict?(input: ShadowVerdictInput): Promise<void>

export interface ShadowVerdictInput {
  feature: DecisionFeature
  decisionIds: readonly string[]
  mode: 'shadow' | 'active'
  payload: Record<string, unknown>   // validated against the feature's closed schema
}
```

Optional, so existing test doubles and any other implementor keep compiling
(structural typing also means the real service satisfies all three faces
unchanged). The service implementation mints `eventId`/`time`, validates the
payload, and appends. The returned promise never rejects; internal failures are
swallowed after one warn. **Call-site discipline: callers `void` the promise** —
never await it inside the decision path, so the append's disk latency cannot
contaminate the latency the gates measure.

### Payload validation: closed per-feature schemas (r1 fold)

The privacy backstop is **not** size caps — a short user string fits any size
cap. It is a closed allowlist per feature, checked by the writer: unknown keys
or wrong-typed fields → row dropped + one warn (fail-closed to a dropped row,
never a persisted surprise). Size caps (≤ 4096 bytes serialized, strings
≤ 256 chars, arrays ≤ 128 items) remain as a second bound on catalog-name
fields. The writer exports the three schemas so the report script and tests
import the same validators (the instrument asserts equality with the production
constants; no inline copies).

### Feature payloads

**memory-extraction** — recorded in the gate (`extraction-gate.ts`) after a
successful `readNoul`, for answered runs only (availability is the usage
ledger's job; incomplete windows never reach the model, so no
`windowComplete` field — every recorded row is a complete window by
construction). One row per window; `decisionIds = [run.decisionId]`:

```jsonc
{
  "verdict": "would-skip" | "extract-positive" | "extract-uncertain",
  "probability": 0.83,             // the noul answer
  "skipThreshold": 0.15,          // settings.skipProbability observed at decision time
  "fromExclusive": 12,            // window seq bounds, in the host's own seq type
  "throughInclusive": 47,         // (integer or decimal-string, as the window carries them)
  "surfaceEvents": 42,
  "stateBytes": 1843
}
```

This is the "would the fork have been skipped" record doc 04 §Rollout requires,
with the window bounds and shape counters needed to identify each window
individually and judge whether the ≥ 100-window population is representative.

**tool-discovery** — recorded in the runtime (`discovery-runtime.ts`) at the
post-`selectNames` point covering **both mode branches** (the shadow branch's
existing tally site and the active branch's return — recording is hoisted to
the common point before the mode split, so active rows do not silently
vanish; active rows feed the flip policy's post-flip monitoring, and the gate
lines filter to shadow), once per ToolSearch evaluation (post-cache, after
`selectNames`). To carry the join through the cache, `DiscoveryJudgment` (the
cached value) gains one additive field `readonly decisionIds: readonly
string[]`, filled by `judge()` from each batch's `run.decisionId` — the
scored-candidates shape is otherwise untouched. Payload:

```jsonc
{
  "queryHash8": "a1b2c3d4e5f60708",  // sha256(query), first 16 hex chars — hashed by the discovery runtime itself at the selectNames site (the raw query never crosses the seam; an extra `query` key in the payload would be an unknown key and drop the row)
  "suggested": ["Bash", "Read"],     // this waiter's activation set after selectNames
  "lexical": ["Bash", "Grep"],       // this waiter's lexical hit set
  "differing": true,
  "suggestedOnly": 1,
  "lexicalOnly": 1,
  "candidatesJudged": 12,
  "originSeq": 1157                  // locator: joins the session log offline
}
```

Names are catalog metadata, not user text — the class of data the activation
plan prescribes recording. Raw query text is never persisted; an auditor
recovers it offline from the session log via `queryHash8` + sessionId +
`originSeq`, exactly as the plan's sidecar spec states. Cache-hit waiters
re-record with their own name lists and the shared `decisionIds`.

**skill-recommendation** — recorded inside `recommend()` itself, **before the
shadow-mode branch zeroes the recommendation list** (public shadow results
return `recommendations: []`, so a wrapper around the public return would see
empty names on every soak row; the recorder reads `value.recommendations` at
the point of assembly), one row per request, for **every terminal outcome**
(`shadow`/`recommended`, `unavailable`, `cancelled`). The wall-clock request
latency is measured at `recommend()` entry, not derived from per-batch settle
rows. Because several pre-dispatch terminals (`unconfigured` on missing
actor/runner/watermark/catalog, `stale`) return **before a bound runner
exists**, the recorder for this feature is NOT taken from the runner face: it
is an optional field on the runtime's own deps (`RecommendationRuntimeDeps`),
resolved from the host decision-usage service directly and thus callable from
the first line of `recommend()`. One exception is pinned: the
`unavailable('settings')` terminal (settings section unreadable, mode
unknown) records nothing — a row whose `mode` cannot be observed has no gate
population and would pollute neither numerator nor denominator; the report
notes this exclusion in prose. Payload:

```jsonc
{
  "status": "shadow" | "recommended" | "unavailable" | "cancelled",
  "eligible": 128,                   // required on shadow/recommended only
  "judged": 96,                      // required on shadow/recommended; judged === eligible is the completeness test
  "recommended": ["article-review"], // required on shadow/recommended only (catalog names)
  "failureClass": "timeout",         // required on unavailable only; the full closed reason union the runtime already produces (SkillUnavailableReason ∪ bounds reasons ∪ the runtime mapping: settings|unconfigured|stale|error), not just "timeout"
  "requestLatencyMs": 812,           // wall clock of the whole recommend() call; always present
  "requestTimeoutMs": 5000          // the effective timeout-ms observed at entry; always present
}
```

Pre-dispatch terminals (`unconfigured`, `cancelled` before dispatch) record
`status` / `requestLatencyMs` / `requestTimeoutMs` and omit the pool fields —
the closed schema makes `judged`/`eligible`/`recommended` conditional on
`status ∈ {shadow, recommended}` and `failureClass` conditional on
`status === 'unavailable'`, so these rows persist (a schema that required the
pool fields on every row would drop the denominator rows it needs).
`decisionIds` carries the request's `value.decisionIds` array when present.

### Report script: `shadow-verdict-report.mjs`

`packages/observability/decision-usage/scripts/shadow-verdict-report.mjs`,
run as `node scripts/shadow-verdict-report.mjs [--home ~/.dsh] [--export <dir>]`.
It walks `<home>/decision-usage/*/*/shadow-verdicts.jsonl` **and**
`shadow-verdicts.jsonl.1`, deduplicates on `eventId`, joins usage rows on
`decisionId`, and prints per feature:

- **memory-extraction** (shadow rows only): total windows, would-skip count,
  verdict distribution, median/mean `surfaceEvents` and `stateBytes`. Gate
  line (both conjuncts of doc 04 §303):
  `GATE extraction-windows: n>=100 AND wouldSkipChecked==wouldSkipTotal -> PASS|FAIL (n=..., wouldSkip=..., checked=...)`.
  The `--export` dir gets `extraction-would-skips.jsonl` (one row per
  would-skip: `eventId`, `probability`, `fromExclusive`/`throughInclusive`, session locator);
  the human review workflow appends `{"eventId": "...", "checked": true}` to
  `extraction-labels.jsonl` there, and the next run reads it back.
- **tool-discovery** (shadow rows only): judgments, differing rows, labeled
  count, judge-correct rate. Gate line:
  `GATE discovery-disagreements: differing>=60 AND labeled>=60 AND wilson-lcb>=0.60 -> PASS|FAIL (differing=..., labeled=..., lcb=...)`.
  `--export` writes `discovery-disagreements.jsonl` (one row per differing
  evaluation: `eventId`, `queryHash8`, `suggested`, `lexical`, `originSeq`,
  session locator, `decisionIds`); labeling appends
  `{"eventId": "...", "judgeCorrect": true|false}` to `discovery-labels.jsonl`.
  Labels deduplicate on `eventId` (last-write-wins). The two-week maintainer
  window from the activation plan stays prose — the script prints the span of
  observed shadow rows as a diagnostic.
- **skill-recommendation** (shadow rows only): request count, coverage-based
  complete-judgment rate with an **explicit completeness predicate** — a row
  is complete iff `status ∈ {shadow, recommended}` AND `judged` and
  `eligible` are present numbers AND `judged === eligible`; anything else
  (omitted pool fields included — a bare `judged === eligible` test on
  absent fields would read `undefined === undefined` as complete) is
  non-complete. The rate is `count(complete) / n` over **all shadow request
  rows** (not the answered subset — 50 complete + 50 timeout must not read as
  100%), with the capacity revision's remainder rule enforced as a conjunct:
  every non-complete row must be `unavailable` with
  `failureClass: "timeout"`. Request p95 over `requestLatencyMs`, metered
  input tokens per projectKey (joined usage rows summed by project directory).
  Gate line (capacity revision):
  `GATE skillrec-requests: n>=100 AND coverage-complete>=0.99 AND nonCompleteAllTimeout AND p95<=ceiling -> PASS|FAIL (n=..., rate=..., p95=..., ceiling=...)`.
  The `ceiling` aggregation rule for mixed per-request timeouts: the gate
  compares the p95 against the **minimum** observed `requestTimeoutMs`
  across the counted rows — passing under the minimum ceiling implies
  passing under every row's own ceiling, which is the conservative direction
  (the maximum would let 94 rows at a 2000 ms ceiling pass on the strength
  of 6 rows at 10000 ms). The report prints the observed
  `requestTimeoutMs` distribution alongside; a population mixing materially
  different ceilings is itself a diagnostic the operator should notice.

The Wilson lower bound is computed by importing the repo's own
`wilsonLowerBound` (`packages/core/tool-search/scripts/lib/eval-metrics.mjs`,
one-sided z = 1.645) — never reimplemented. The script prints the numeric
inputs (k, n, lcb) alongside every boolean.

Exit code 0 whenever all gate lines print (the report is an instrument, not a
CI gate — shadow data is live-maintainer data, never CI fixtures).

### What the gates then read

| Pre-registered requirement | Instrument output |
| --- | --- |
| ≥ 100 complete windows AND every would-skip manually checked (doc 04) | `extraction-windows` gate line: count conjunct from rows, review conjunct from `extraction-labels.jsonl` |
| ≥ 60 labeled disagreements, Wilson LCB ≥ 0.60 (activation plan) | `discovery-disagreements` gate line over `discovery-labels.jsonl` |
| ≥ 100 requests, coverage-complete ≥ 99%, p95 ≤ effective timeout-ms, per-project cost (capacity revision) | `skillrec-requests` gate line + per-project token table |

The same report also serves the "or guide feature modification" question:
verdict distributions, failure classes, and window shapes are the evidence a
feature change would be argued from (e.g., an extraction population that is
90% trivial windows argues for a window-completeness change, not a flip).

## Verification

- **Unit — writer**: closed-schema validation (unknown key dropped + warned;
  wrong-typed field dropped; valid rows persist); caps (4096-byte, 256-char,
  128-item bounds); rotation at 8 MiB (renamed file, new file starts with the
  row); torn-tail repair; per-dir serialization (two concurrent
  `recordShadowVerdict` calls produce two intact rows in order);
  `recordShadowVerdict` never rejects (append failure folds to warn).
- **Unit — recorders**: extraction gate emits one verdict row per answered run
  with the right verdict bucket at the `skipProbability` boundary, window seq
  bounds, and `decisionIds=[run.decisionId]`; discovery runtime emits one row
  per evaluation with correct `differing`/set math and cache-hit waiters
  recording separate rows with the shared `decisionIds` (reusing the existing
  tally fixtures); recommender emits one row per request for every terminal
  class including pre-dispatch `unconfigured` (empty `decisionIds`), with
  wall-clock `requestLatencyMs`.
- **Unit — report**: Wilson LCB via the imported `wilsonLowerBound` against
  hand-computed references — **42/60 → 0.5958 (FAILS the 0.60 line); 43/60 →
  0.6132 (the smallest passing k); 40/60 → 0.5613**; gate booleans faithful to
  each conjunct (a would-skip unchecked holds `extraction-windows` FAIL even
  at n=200; an unlabeled differing row holds `discovery-disagreements` FAIL;
  a request with `judged < eligible` is not coverage-complete); the two
  Node-verified regression fixtures from review: **50 complete + 50
  `unavailable('timeout')` rows yield rate 0.50 (not 1.0), and a row with
  omitted pool fields is non-complete** (the `undefined === undefined`
  counterexample), plus an `unavailable('error')` row failing the
  `nonCompleteAllTimeout` conjunct; the **mixed-ceiling counterexample** —
  94 rows at `requestTimeoutMs=2000`/`requestLatencyMs=2500` plus 6 rows at
  10000/3000 — fails the gate under the minimum-ceiling rule (it would pass
  under a maximum rule, which is why the minimum is pinned); join
  correctness including orphan verdict rows (counted, reported); rotation
  dedup (a row appearing in both generations counts once).
- **Integration**: a temp harness home driven through the three features'
  existing test rigs produces usage rows and verdict rows joinable by
  `decisionId`; the report over that home prints all three gate lines and
  fails them on an empty/unlabeled population.
- **Behavioral no-op**: with the recorder wired, existing shadow-mode feature
  tests pass unchanged (recording adds no observable behavior to the decision
  path; callers void the returned promise).

## Risks

- **Ledger growth**: bounded by the 8 MiB rotation, and rotation no longer
  resets the soak (the report reads both generations).
- **Privacy**: closed schemas reject any free-text field by construction; the
  caps bound catalog-name arrays; query text never leaves the session log.
- **Identity drift**: a `decisionId`-keyed join selects all of a decision's
  usage rows (all attempts); cost attribution sums them, which matches how the
  usage ledger itself charges. Evaluation rows are deduplicated on `eventId`
  across cache-hit waiters only via their own row identity — waiters are
  distinct evaluations by design.
- **Mode flips mid-run**: the row records the mode the feature observed at
  decision time; the three soak gate lines filter to shadow rows, and active
  rows feed post-flip monitoring, as the activation plan's flip policy
  requires.
