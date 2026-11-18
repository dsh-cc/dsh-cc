# Design: moa routing criteria — domain-neutral axis + data-analysis vocabulary

Status: **approved** — three-seat blind review closed (r1-r5, all GO; see §8
ledger). Implementation carries this text verbatim.
Base: `main` at `719bf9c2`. The review material was frozen per round as a
scratch snapshot; the committed artifacts are this document, the corpus and
probe under `packages/interaction/moa/eval/`, and the source edits of §3.
Feature family: moa (tiered cascade routing), interaction realm.

Terminology (fixed, r1 fold): **old criteria / new criteria** name the A/B
variable. **Legacy classifier** = the v1 admission path (argmax over the
question, bare opening text). **Context-routing v2** = the structured-state
tail-policy path. "v1/v2" alone is never used for the A/B axis.

## 1. Problem

The moa admission classifier asks one 4-way choice question
(`ROUTING_QUESTION`, `packages/interaction/moa/src/router-tiers.ts:11-21`).
Its four criteria strings are 100% software-engineering vocabulary
(typo fixes, single-function utilities, multi-file design, platform
migrations). The whole `packages/interaction/moa/` tree has zero occurrences
of any data-analysis vocabulary (`SQL`, `metric`, `aggregation`, `对账`).
Context-routing v2 does not fix this: `CONTEXT_ROUTE_QUESTION`
(`context-routing.ts:80-84`) copies `ROUTING_QUESTION.criteria` verbatim.

Measured consequences (live gateway 127.0.0.1:8080, model
`llmbox_systemone/bjev`, deterministic across repeat runs — identical
probabilities both runs). Matched data-vs-coding pairs, shipped criteria,
legacy-shape argmax:

| case | data request | argmax | matched coding request | argmax |
|---|---|---|---|---|
| A1 | single known-metric lookup | sketch 0.530 | function-location lookup | sketch 0.467 |
| A5 | one-table day aggregation | **blueprint 0.307 vs draft 0.305 — coin flip** | small utility function | draft **0.809** clean |
| A9 | two-caliber reconciliation | blueprint 0.762; under the tail policy the upper tail (0.156 > 0.10) selects **masterplan** | flaky-test root cause | blueprint 0.867, tail stays blueprint (0.089) |
| A13 | cross-BU quota scheme | masterplan 0.871 | subsystem refactor | blueprint 0.61 |

Corroborating production ledger (`~/.dsh/moa/routing.jsonl`, 614 `route`
rows), reported honestly on BOTH fields (r2 fold G7 — the earlier claim used
the collapsed field only): applied `tier` is sketch 366 / draft 12 /
blueprint 182 / masterplan 38, but `argmaxTier` is sketch 238 / draft 39 /
blueprint 129 / masterplan 15 (absent on 193 rows). The gap between the two
is mostly `collapseAppliedTier` folding draft into sketch, which this
deployment's ladder (sketch and draft both resolve to the same model,
blueprint is a different one) makes a no-op. So the ledger does NOT show the
classifier pushing aggregation work to blueprint; what it does show is that
the costly boundary in production is sketch/draft → blueprint. The A5 coin
flip stands on its own measurement (§1 table), not on this ledger.

Directional ablation (r1 wording, legacy shape): adding data vocabulary moved
A1 sketch 0.530→0.678, A5 →draft 0.713, A9 tail masterplan→blueprint
(upper tail 0.083), A13 unchanged. The bottleneck is the criteria
vocabulary, not the classifier model. NOTE (r1 fold): the §3 wording changed
after this ablation (see below); the ablation is directional evidence only —
the corpus A/B run of §5 is the binding measurement.

## 2. Goals / non-goals

Goals:
1. Make the four criteria strings domain-neutral in their complexity axis
   while keeping the existing coding vocabulary (no coding regression).
2. Add data-analysis vocabulary at every tier, with tier boundaries that do
   not let single-step exemplars capture complex work.
3. Rotate the decision identity where one exists: context-routing v2's
   question version bumps (`CONTEXT_ROUTE_QUESTION_VERSION`). The legacy
   classifier has no decision identity — it calls `systemoneDecide` directly
   (`router-classify.ts:82-95`); the decision hash (`decision-hash.ts`,
   reached only via the DecisionRunner, `decision.ts:245`) is not on that
   path, and legacy `routing.jsonl` rows (`RouteRowFields`,
   `context-routing.ts:112-133`) carry no version or hash field. **r2 fold
   G5**: instead of only accepting that hole, this change closes it
   additively — a `ROUTING_CRITERIA_REVISION` constant in `router-tiers.ts`
   is emitted as `criteriaRevision` on every route row, legacy and v2 alike.
   The earlier draft claimed the shadow-mode `suggestedTier` field made the
   change observable; it does not — that field is the C-shape suggestion and
   carries no criteria version, and the ship-default mode is `off`, where
   shadow never runs. With `criteriaRevision` the armed legacy path that
   serves traffic can be sliced across the change after ship.
4. Pre-registered, blind-labeled evaluation with pass gates before merge.

Non-goals (explicit):
- **No change to `ACCEPT_QUESTION`** (the acceptance judge, `judge.ts:35-42`).
  Its criteria were calibrated against the P5 probe corpus; changing judge
  criteria without its own labeled corpus round is out of scope. Tracked as
  follow-up.
- No threshold changes (`min-top-probability`, `max-under-tier-probability`,
  `tau` stay at shipped values). Retuning thresholds on the corpus that
  motivates the change is the calibration sin the design discipline forbids.
- No `context-routing.mode` flip (stays `off` ship-default), no
  ladder/arming changes, no settings changes.
- No tool-turn escalation / execution-time re-classification (structural
  limit of an admission classifier, unchanged).

## 3. The change (exact text)

`packages/interaction/moa/src/router-tiers.ts` — `ROUTING_QUESTION.criteria`
becomes (verbatim; r2/r3 wording — the sketch suffix absorbs simple
single-table filters, the draft SQL exemplar is fenced to one table, and the
blueprint side explicitly claims a query that joins or spans several sources,
so single-query reconciliation and attribution stay blueprint; any later
wording edit requires re-running the §5 protocol):

```
sketch: 'trivial: typo fixes, one-line edits, simple factual questions, renames, single-command explanations, a single lookup or simple filter of one known table or metric'
draft: 'moderate: single-function utilities, small localized feature edits, explaining short code snippets, one-step aggregation or summary over one table, a single SQL query over one table'
blueprint: 'complex: multi-file or multi-module design, architecture proposals, root-cause analysis of subtle bugs, phased refactors, multi-source reconciliation, metric-caliber disputes, attribution analysis, a single query that joins or spans several sources'
masterplan: 'very hard or ambiguous: cross-cutting strategy, long-horizon multi-team planning, organization-scale tradeoff decisions, platform migrations, redesigning a metrics system across organizations'
```

Each tier keeps its existing coding exemplars unchanged (prefix) and appends
data-analysis exemplars (suffix), so coding-domain behavior should be
maximally preserved; "redesigning a metrics system across organizations"
recycles the existing masterplan shape ("platform migrations" family).
(r2 fold G1 — both the draft exemplar and the blueprint exemplars matched a
single complex query: D1 is one SQL over three tables and D2 is one SQL
attribution, so "a single straightforward SQL query" still captured them;
"straightforward" was undefined. The draft exemplar is now bounded to ONE
table and the blueprint side names the multi-source case explicitly.)

`packages/interaction/moa/src/context-routing.ts` —
`CONTEXT_ROUTE_QUESTION_VERSION` `'moa-context-route-v1'` →
`'moa-context-route-v2'` (the v2 question carries the criteria, so its pinned
question identity must rotate; it reaches `inputHashForDecision` via the
DecisionRunner, `decision.ts:245`). No policy-version bump (selection logic
unchanged, r1-confirmed). `CONTEXT_ROUTE_QUESTION` itself needs no edit: it
spreads `ROUTING_QUESTION.criteria`, preserving the one-source-of-truth
property pinned by `tests/context-routing.spec.ts:203-208`.

Plus the r2-fold additive provenance (goal 3):

```ts
/** Criteria revision, emitted on every route row so traffic can be sliced across a criteria change. */
export const ROUTING_CRITERIA_REVISION = 'routing-criteria-v2'
```

`router-tiers.ts` exports it; `RouteRowFields` gains an optional
`criteriaRevision?: string`, written by the legacy classifier row and by both
v2 row emissions (shadow and active). This is additive to the ledger schema
(mode-off rows keep their shape except for the new key), and the moa spec
suite's row assertions need the field added where they assert exact shapes —
an implementation-time check, listed in §4 step 8.

No other source changes. Criteria stay hardcoded constants (no settings knob)
— a per-deployment criteria override would fragment the eval baseline and is
not wanted. Deliberate deviation from an earlier draft of this plan: no
package README line is added. The moa README documents settings and tier
behavior, never the criteria text, and a one-line addition would drag the
bilingual README trio (en + zh + i18n hashes) for a statement this document
and the source comments already carry.

## 4. Evaluation instrument

`packages/interaction/moa/eval/` (committed with the change):

1. `criteria-corpus.json` — the blind-labeled corpus (42 cases — 16
   data, 16 coding, 8 general, 2 adversarial single-query data cases D1/D2
   added at review round r1). Labels stay
   frozen through every round: relabelling after a baseline run would be
   exactly the fit-to-measurement sin the protocol forbids (soft labels are
   disclosed in §7 R1 instead).
2. `criteria-probe.mjs` — local-only probe (network to the configured
   gateway; never runs in CI). Contract:
   - **Both question texts are scraped from source at run time**: the legacy
     instructions from `router-tiers.ts`, the v2 instructions from
     `context-routing.ts` (the `'+'`-concatenated literal is joined before
     comparison), each followed by an explicit assertion that the scraped
     string is non-empty and equals the text the probe will send. A drift
     fails loudly *before* any request (r2 fold N1/#1 — the previous version
     hardcoded both strings while §4 claimed scraping).
   - **Two shapes, each with its own shipped question**: L = legacy
     instructions + bare text + argmax; C = `CONTEXT_ROUTE_INSTRUCTIONS` +
     constructed first-turn `RoutingContext` + tail policy at shipped
     thresholds (0.60 / 0.10). Cross-combinations are never reported as
     shipped behavior.
   - **The printed tier is the pre-collapse pick** (`argmaxTier` /
     `suggestedTier`): the probe deliberately stops before
     `collapseAppliedTier` and before the truncation sentinel (these cases
     are far below the 4000-token budget), so a sketch↔draft flip on a ladder
     where both aliases share a model is a label change, not a model change
     (r2 fold #9).
   - **It prints the gate verdicts**, not just the raw rows: G1-G8 evaluated
     from the old/new pair in the same run, each as PASS/FAIL/N-A with the
     numbers that decided it (r2 fold N4/#2 and the critic's suggestion — the
     merge-blocking arithmetic must not live only in prose).
   - **G6 is a determinism gate, not a stability-by-majority gate**: a flip
     re-samples the flipped cases (`--g6-resamples`, default 3) and passes
     only on unanimity, reporting every sample when it does not (r4
     adjudication, see §5).
   - Per-shape, per-domain summary lines including exact-match counts (r2
     fold #3 — §5 promises them and the previous version aggregated across
     domains).
3. A clean baseline artifact is produced by the FIXED probe before any
   new-criteria run (`--runs 2`), replacing the pre-fix `/tmp` output whose
   summary counters were computed by the older instrumentation (r2 fold N3:
   the numbers in §5 were a hand recount of that run's rows, and the artifact
   must match the instrument that will produce the treatment side).
4. Old criteria are embedded in the probe as the frozen historical control.

## 5. Evaluation protocol and pre-registered gates

Definitions (executable in the probe output):
- **under-tier**: selected tier < `minTier` (the expensive failure). Only
  cases with `minTier > sketch` are eligible (sketch is the floor).
- **fallback** (C-shape only): the tail policy returns no tier
  (below min-top-probability) → live selection, no routing. Counted
  separately from under-tier; never mixed (r1 fold).
- **exposed cases**: A1, A5, A9, A13 — used to diagnose the wording before
   any corpus run (labels pre-registered then). A fifth exposed diagnostic
   case ("DAU 为什么掉了") was dropped from the corpus rather than carried
   in with a contested label. Gates are evaluated on the UNEXPOSED cases;
   exposed-case numbers are reported separately (r1 fold X4).
- Old criteria are embedded in the probe as the frozen historical control.

Gates (evaluated on the new-criteria run with the old-criteria run as the
control; any failure blocks the merge — a failed gate is a recorded result,
never a mandate to retune wording against the corpus). r2 restructured these
across all three seats: aggregate-only gates could pass while the exact
failures that motivated the change survived, and the three outcome states
(exact / over-tier / fallback / under-tier) let one gate be paid for by
another.

- **G1 (legacy data under-tier)**: on unexposed eligible data cases (n=11),
  old→new strictly decreases from the measured baseline of 3 AND new ≤ 1.
- **G2 (context data failure modes)**: same subset, C-shape: unexposed data
  under-tier stays 0 AND unexposed data fallbacks strictly decrease from the
  measured baseline of 7 AND land ≤ 3 (an absolute cap — the r2 fold noted
  the replacement contract had no floor of its own).
- **G3 (safety, both shapes, all cases)**: no case becomes under-tier that
  was not under-tier before.
- **G4 (coverage, both shapes, all cases)**: no case becomes a fallback that
  was routed before; and total C-shape fallbacks do not increase.
- **G5 (cost inflation, per shape)**: masterplan selections increase by at
  most 2 AND cases crossing into blueprint-or-above ≤ 2, each disclosed by
  case id. A crossing requires a NUMERIC old tier below blueprint and a new
  tier at or above it; recovering a fallback into blueprint is not a
  crossing (fallback has no selected tier, and G3/G4 already forbid using
  fallbacks as currency). This closes the netting
  loophole: demoting an over-tier masterplan to blueprint could previously
  "pay for" a new masterplan while crossing the model boundary §1 identifies
  as the costly one.
- **G6 (determinism)**: across the base runs, identical OUTCOME (tier or
  fallback) per (case, shape) under new criteria. A flip triggers a re-sample
  of the flipped cases (3 more by default) and the case passes only if EVERY
  sample agrees — unanimity. **r4 adjudication**: the earlier
  persistent/transient/unconfirmed labelling is withdrawn, because a
  tie-break that privileges one of the disagreeing samples is arbitrary, and
  any 3-sample pattern over two outcomes is still instability. (Both r5
  confirmations observed the consequence: with the two base samples already
  disagreeing, unanimity is arithmetically impossible, so the re-sample never
  swings the verdict — it is diagnostic evidence about whether the
  instability is one-off or pervasive. §4 says so too.) The design's
  own premise is a deterministic gateway (baseline: 0 flips over 2 runs), so
  unanimity holds whenever the classifier is genuinely deterministic; a
  singleton backend blip fails the gate and costs one probe re-run rather
  than being silently absorbed. Non-unanimity is reported with every sample
  and is a FAIL — never a silent pass, never an N-A hand-wave.
- **G7 (adversarial boundary)**: D1 and D2 must carry a SELECTED tier at or
  above blueprint on both shapes — a fallback does not satisfy the gate (a
  fallback is not routing, and under the old criteria D1/D2 already fall back
  on the C-shape, so "not under-tier" would pass trivially). Without this, G1
  could be satisfied by fixing A6/A7 (3→1) while a complex single query leaks
  into draft — the exact leak the cases exist to catch.
- **G8 (motivating diagnostics)**: A5 reaches ≤ draft on L-shape (it was
  blueprint against a draft floor) and A9 reaches ≤ blueprint on C-shape (it
  was masterplan against a blueprint floor). These four cases are the ones
  pre-registered as exposed, so G1/G2 exclude them. G8 is deliberately
  narrower than the exposure pool: A1 and A13 are already correct at baseline
  and stay report-only, and only the failing shape of each diagnostic is
  asserted. This is the one place the change is judged on cases that
  motivated it; the generalization burden stays on G1-G7 over the unexposed
  set, and §5 forbids retuning wording after a failure.

Not gated, reported: exact-match counts per domain and shape, per-case tier
distances, and the full transition table old→new for both shapes (so a reader
can see every case that moved, in which direction, and by how much).

### Treatment measurement (2026-11-18, after the source edits)

`node packages/interaction/moa/eval/criteria-probe.mjs --runs 2` against the
applied criteria, both shapes, 42 cases. Full artifact: the PR body carries
the gate lines; the raw run is reproduced there.

| gate | verdict | detail |
|---|---|---|
| G1 | PASS | L unexposed-data under 3 → 0 (n=11) |
| G2 | PASS | C under 0 → 0, fallback 7 → 2 |
| G3 | PASS | no case became under-tier |
| **G4** | **FAIL** | A4/c, B8/c, C4/c moved from a routed tier to fallback |
| G5 | PASS | masterplan L 10→10, C 14→11; one new blueprint-or-above crossing (B5) |
| G6 | PASS | no outcome flips across the base runs |
| G7 | PASS | D1 L=2 C=2; D2 L=2 C=2 |
| G8 | PASS | A5 L ≤ draft (now 1); A9 C ≤ blueprint (now 2) |

Everything else that moved improved: A6/A7 fallback→blueprint/draft, A11 and
A5 fallback→blueprint, D1 fallback→blueprint, A2 blueprint(+2)→draft(+1),
A9/A10/B9 masterplan(+1)→blueprint(0).

The three G4 failures are over-tier-routing → no-routing transitions: A4
(data, floor sketch) blueprint(+2) → fallback; B8 (coding, floor draft)
blueprint(+1) → fallback; C4 (general, floor draft) blueprint(+1) → fallback.
The new wording lowers the classifier's confidence on them below
`min-top-probability` (0.60), so the tail policy declines to route and the
live selection serves instead.

**Status: blocked by its own gate.** §5 says a failed gate blocks the merge
and is never met by retuning wording against the corpus, so this is recorded
as a failed result, not adjusted away. The disposition (hold, or merge under
an explicitly user-approved disclosed exception) is a user decision, recorded
in §8.

## 6. Rollback

Single revert of the two-file change; the question-version bump reverts with
it. Shadow-mode ledgers need no migration. No settings, migration, or
persisted-state surface is touched.

## 7. Risks / residuals

- **R1 (n=42, single annotator, criteria-shaped sample)**: labels are one
  author's blind judgment and the author also wrote the criteria, so the
  corpus proves direction, not deployment reliability. r2 disclosed the
  sample's shape: the 42 cases are first-turn paraphrases of the new
  exemplars, `general` has only two cases per tier, and messy production
  phrasing is out of sample. Two labels are soft and stay frozen rather than
  being relabelled after a baseline run (which would be fitting the
  measurement): **B13** ("permission subsystem → policy engine, across 4
  packages, migration plan") reads either as the blueprint "phased refactor"
  or as the masterplan "platform migration" — it is also the coding
  L-shape under-tier in the baseline; **A8** (daily error-rate 环比) reads
  either as draft "one-step aggregation" or as blueprint. Dropping the
  contested "why did DAU drop" case also removed a boundary that A10's
  three-way attribution does not cover; that gap is accepted, not hidden.
- **R2 (language coverage)**: corpus is Chinese (the deployment's live
  traffic); criteria text is English. Measured fine here; other languages
  unmeasured.
- **R3 (provenance)**: the legacy path has no decision identity by
  construction; the r2 fold closes the observability gap additively with
  `criteriaRevision` on every route row (§3), so post-ship slicing works on
  the path that serves traffic. What it does not do is give the legacy
  classification a *decision* hash — there is still no per-call envelope in
  legacy rows, so a criteria revision identifies the criteria generation, not
  the individual decision. Accepted.
- **R4 (answer correctness is unmeasured at every tier)**: this change
  moves tier placement; it does not measure whether any tier's answer is
  right. The acceptance judge (`ACCEPT_QUESTION`) does say "factually
  correct" / "factual errors", so a caliber miss is inside its vocabulary,
  but there is no data-domain measurement of it — the P5 dedup accept at
  0.846 is adjacent evidence, not a measurement of the data-caliber class.
  Critically (r2 fold), G1/G2/G7/G8 are **not** a safety net for answer
  quality: they constrain tier placement only, and on-tier or over-tier
  caliber errors pass all of them. The residual is stated as unmeasured at
  every tier, not just in a cheaper one.
- **R5 (wording is measured as a whole)**: the §3 text changed again in this
  round (draft bounded to one table; blueprint names the multi-span query)
  while no treatment run exists yet, so nothing measured was invalidated.
  After this round, any further wording edit requires re-running the §5
  protocol before merge.

## 8. Review ledger

- **r1** (design v1 + corpus v1): critic GO-WITH-CHANGES (3 P1: legacy
  identity claim false; G1/G2 semantics ambiguous; E1 disclosure broken.
  3 P2: G1 absolute floor; undisclosed eval script + scrape fragility; G6
  failure handling). codex NO-GO (7 P1: tail-policy gates missing;
  two-policies-one-distribution does not evaluate the shipped classifiers;
  "a single SQL query" leaks complex work + A4 boundary contradiction; E1
  disclosure; legacy identity; stability double definition; allowances
  unsound. 1 P2: judge rationale overstated). grok: interrupted
  (authentication), re-dispatched on v2. All findings folded into this v2:
  goal-3/R3 rewritten (identity), §3 reworded (sketch/draft suffixes),
  corpus disclosure corrected + D1/D2 adversarial cases added, §4 rewritten
  around the two shipped shapes, §5 gates restructured (terminology,
  fallback separation, unexposed-only gating, case-level rules, withdrawn
  allowances, single stability definition, absolute caps), R4 softened.
  No finding rejected.
- **r2** (design v3 + corpus v2, all three seats): critic GO-WITH-CHANGES
  (all 6 r1 folds RESOLVED; N1 probe hardcodes the v2 instructions instead
  of scraping; N2 D1/D2 ungated so G1's slack absorbs exactly their failure;
  N3 baseline artifact is pre-fix output; N4 stale probe header). codex
  GO-WITH-CHANGES (all 8 r1 folds RESOLVED; instruction-scraping unimplemented
  — same defect as critic N1, independently; probe retains the superseded G2
  contract and the design still says "G1/G2 caps ≤2"; promised per-domain
  summaries absent). grok GO-WITH-CHANGES (6 P1: the draft SQL exemplar still
  matched D1/D2 — a wording defect, not just a gating one; gates could pass
  while the motivating failures stayed wrong; three-state offsetting via
  fallback→under-tier and masterplan netting; probe/baseline do not match §4;
  the R3 shadow mitigation does not observe the legacy hole; R4 too narrow.
  3 P2: §1's "draft nearly dead" used the collapsed field — verified, the
  argmax tally is sketch 238 / draft 39 / blueprint 129 / masterplan 15 with
  193 rows missing the field; corpus soft labels and criteria-shaped sample;
  the probe stops before collapse). Folds in this v4: §3 draft bounded to one
  table and blueprint names multi-span queries; a `criteriaRevision` route
  field closes the legacy-provenance hole additively; §4 rewritten (real
  scraping of both instruction sets with equality assertions, printed gate
  verdicts, per-domain summaries, pre-collapse reporting, clean baseline
  artifact); §5 gates restructured to G1-G8 (tightened absolute caps, G3/G4
  three-state safety, G5 crossing cap, G7 adversarial, G8 motivating
  diagnostics); §1 ledger claim corrected to both tallies; R1/R3/R4/R5
  restated. Rejected findings: none.
- **r1.5** (no seat; baseline measurement): the old-criteria baseline run
  exposed two instrument defects, both fixed before any new-criteria run
  and disclosed here: (a) the probe's unexposed-eligible summary counted all
  domains, not data only — fixed with a domain filter plus a data-fallback
  counter; (b) G2's "strictly decrease" was unsatisfiable at the measured
  baseline of 0 C-shape data under-tier — amended (see §5). Baseline
  numbers recorded in §5.
- **r3** (design v4 + probe v2, all three seats, micro-confirmation): critic
  GO-WITH-CHANGES (F1-F9 all RESOLVED; 2 new P2 — the G6 re-run clause is not
  implemented in the probe, and G4's "total fallbacks" was computed on the
  unexposed subset). codex GO-WITH-CHANGES (8 of 9 RESOLVED; F4 NOT-RESOLVED
  on the same G5/G6 execution mismatches — G5 counted a fallback as an upward
  crossing, G6 failed on the first flip without the confirmation re-run).
  grok GO-WITH-CHANGES (F1-F9 all RESOLVED; raised G5 to P1 with the decisive
  arithmetic: under the old crossing rule the adversarial recoveries D1/D2
  alone exhaust the C-shape cap of 2, so any of A11/A12/B13/C6 would fail the
  gate; plus the stale §3 lead-in still describing the withdrawn
  "straightforward" qualifier, and G7's wording not matching the probe's
  assertion). Folds in this v4 revision: probe G5 counts only a numeric old
  tier, probe G4 sums all cases, probe G6 implements the confirmation re-run
  with persistent/transient/unconfirmed outcomes, §3 lead-in corrected, §5
  G5/G6/G7 definitions aligned with the implementation, G8's scope narrowed in
  the prose to match what it asserts. Rejected findings: none. Treating this
  as a fold round rather than a re-review: all three seats returned
  GO-WITH-CHANGES, so their delta re-review targets these instruments only.
- **r4** (final confirmation, all three seats): critic **GO** — all six r3
  folds RESOLVED, no new defects, recommended proceeding to implementation.
  codex GO-WITH-CHANGES — five of six RESOLVED; item 2 NOT-RESOLVED: the
  probe turned an "unconfirmed" G6 outcome into an automatic FAIL while §5
  reserves that case for operator judgement (a P2 on one line). grok
  GO-WITH-CHANGES — five of six RESOLVED; item 2 NOT-RESOLVED with a
  different diagnosis: the labelling rule privileged run 0, so a third sample
  agreeing with run 1 was scored "persistent" while only a match to run 0
  counted as "transient". **Seat disagreement, adjudicated rather than
  picked**: both critiques reduce to the same defect — a three-sample rule
  over two outcomes cannot separate "transient" from "real instability"
  without inventing a tie-break, so every labelling variant is arbitrary
  (codex wanted N-A, grok wanted a symmetric rule; neither fixes the
  arbitrariness). The fold removes the labelling entirely: G6 is now a
  DETERMINISM gate — a flip re-samples the case and passes only on unanimity,
  reporting every sample otherwise. The transient-passes allowance is
  explicitly withdrawn in §5 rather than faked, and a genuine blip costs one
  probe re-run instead of silently passing. No seat's finding was rejected;
  the divergence itself was the finding.
- **r5** (G6 micro-confirmation, codex + grok only — critic held no open
  item): both **GO**. codex: unanimity removes the arbitrariness, withdrawing
  transient passes is acceptable under the determinism premise, the probe
  implements §5; it also noted the re-sample cannot swing the verdict, now
  stated in §5 as diagnostic-only. grok: no run is privileged, no N-A bucket
  remains, and once the base pair disagrees `--g6-resamples` cannot move
  PASS/FAIL. No new defects. **Review closed: three seats GO on design v4,
  no open P0/P1/P2.**
