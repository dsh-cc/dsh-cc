# Implementation record: vwa-review-cycle

## First-use screening notice

Effective project rules in this session: the root AGENTS.md is a 7-line 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
forwarding stub; the 209-line review-protocol text is not loadable from 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
the effective rules. Screening was adopted manually from the
formal-design skill (session of 2026-10-27); **review-rule availability: 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
missing** — modeling and checking may proceed, but the formal review
dispatch gate is blocked. No reviewer roster was invented and no formal
review was dispatched this round.

## Screening decision

mode=auto, decision=enabled, triggerIds=FD-T1/T2/T3/T4, recorded in 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
design.md ("Formal design screening"). Scope selected by the user via 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
ask_user_question (2026-10-27): the vwa-argument review pipeline — the 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
only remaining unmodeled dsh-cc module that hits all four triggers.

## Final run (authoritative)

- runId: `20261027T141830Z-d99e5f76-ba46-4e8a-aa21-aef1b0b928d0` 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
- inputDigest: `f34d92e1ab77363e7e429b617ca6c017690b299b8829aa4cf9639a1a2d9563d9` 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
- runnerPackage: `@dsh-cc/plugin-dsh-cc-agents` 0.9.2 (cached skill 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  copy; Lean scripts present only on main post-#304, so this round is 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  TLA+-only by both scope decision and tool availability) 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
- toolchainVersion 1.7.4, jarSha256 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`, 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  Java 25.0.2 (PATH), platform darwin aarch64 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
- Commands: `preflight.mjs` (exit 0, ready-for-check), `check.mjs` 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  (exit 1 — aggregate counterexample, see below), `check-evidence.mjs` 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  (exit 0: valid / fresh / verification=counterexample) 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕

### Case outcomes

| case | coverage | outcome | statistics |
|---|---|---|---|
| convention 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L34-L45〕 | core | **verified** | 53,081,226 generated / 9,221,350 distinct / 0 queue, 259 s |
| strict-torn-lock 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L46-L55〕 | expansion | counterexample (expected, probe) | 199 / 106 / 81, 0.7 s |
| strict-reserved-spend 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L46-L55〕 | expansion | counterexample (expected, probe) | 5,293 / 1,687 / 1,080, 0.8 s |

Aggregate = counterexample **because of the two designed probes**; this
is a legal result for this model, not a failure to fix. The convention
core case is verified with no invariant violation.

### Probe traces (persisted under `.formal-design/runs/vwa-review-cycle/<runId>/`) 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕

- strict-torn-lock: `Initial → Prepare(p,q,h,m) → LockCreate(p) → 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  CrashTorn(p)`; `lockHolder = "torn"` afterwards, no action ever 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  clears it (only dead-pid holders are reclaimable, lock.ts:79-84) 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L7-L83〕.
- strict-reserved-spend: `Initial → Prepare → LockCreate → 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  AdmissionBody → StartRun → ReserveCall → Crash`; the durable reserved 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  row (reserved=1) outlives the killed attempt (settled=0, no in-flight 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  call) — the cycle ledger keeps the charge.

## Semantics sources (code read before modeling, worktree @ b2979b1e) 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕

Bulk read delegated to shunt-reader and spot-verified by the main
dialog against the actual files (read-back of exact ranges):

- lock.ts:25-102 — LOCK_WAIT_MS=2000, exclusive-create, dead-pid 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L7-L83〕
  reclaim, same-process self-deadlock, torn file never reclaimed,
  best-effort release.
- review-cycle.ts:140-274 — per-pid tmp sidecar write, prior-cycleId 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L84-L163〕
  idempotent reservation, REVISION_CONFLICT inside the lock, cycleUsage 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L133-L163〕
  excludes nothing for the calling cycle, reserveCycleCall check+reserve 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L84-L163〕
  in one critical section.
- review-run-store.ts:100-258 — reserveRequest stamps processId/nonce, 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L164-L213〕
  loadRequest restart rule (queued/running + dead owner → incomplete, 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L164-L213〕
  totals reconciled from the ledger), hash-verified records, append-only
  usage ledger, fully synchronous writeAtomic 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L164-L213〕.
- review-call.ts:55-224 — pool check+debit same tick, refund on 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L214-L264〕
  abort/count-fail/budget-refusal, earn at retry reservation, timeout
  classification.

## Deviations / modeling incidents during the run

1. SANY 2.1 (TLC 1.7.4 toolchain) rejects comma-separated LET definition 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L76-L100〕
   lists and comma `\A` bounds referencing earlier bounds — both were 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
   rewritten (newline-separated LET, nested `\A`). Same family as the 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L76-L100〕
   known "no line continuation" trap 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕.
2. TLC rejects cross-type equality (integer 0 vs string sentinel) inside 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L76-L100〕
   set-membership checks — all none-sentinels converted to the string
   `"none"` and id universes to strings 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕.
3. Two missing `UNCHANGED`/assignment completeness bugs found by TLC 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L76-L100〕
   (2109 not-completely-specified) — fixed in AdmissionBody 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕.
4. The first reserved-spend probe formulation flagged the healthy 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L46-L55〕
   reserve→dispatch gap; the probe was redesigned to count settled
   attempts (ok / retryable failure / abort) plus in-flight calls, so
   only a crash in the gap violates it. Trace now ends in Crash.
5. State-space control (all recorded, no properties were weakened): 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
   pend records normalized on every kind transition (stale fields
   multiplied states); admission-refusal outcomes removed from state;
   load observations recorded only for dead-owner loads; the second
   payload only preparable on replay (its only purpose); convention
   core bound MaxCalls=1 (exhaustion and retry-refusal paths still 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
   reachable), probes MaxCalls=2. Convention case: 53.0M generated / 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L46-L55〕
   9.2M distinct in 259 s after these cuts (previous formulation did 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
   not finish in 300 s) 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕.

## Unmodeled scope / exclusions

See design.md "Exclusions" E-1..E-7 (store transaction internals, audit 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
merge lattice, project-store lock duplication, audit reuse, two-file
terminal write, PID reuse, fixed `.tmp` path). Regression-test gaps 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
recorded in design.md "Planned code/test mapping": no existing test was 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
found for the dead-owner cycle-usage inclusion (crash-after-reserve) or
the torn-lock LOCK_BUSY path; the five listed scenarios are candidate 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L101-L110〕
test additions but no production code was touched this round.

## Review / handoff state

- Formal review: **blocked** (missing effective review rules, see the
  first-use notice). The complete same-run package exists under
  `.formal-design/runs/vwa-review-cycle/20261027T095301Z-…/` for any 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  future dispatch once rules are loadable.
- Implementation handoff: not applicable — this round is modeling and
  verification only; no production code change was planned or made.

## Run lineage

- R1 `20261027T095301Z-e4f4b80e-a0b2-45e3-9866-f386016eeca5`, digest 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  `211fbd471a99a3ff4dd90ce3821afec1b040fdc7bd60226019688dc64f3eacb3`: 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  first complete run; superseded by the citation-marker backfill.
- R2 `20261027T102631Z-733a1299-404c-4e57-8228-9993b93fa3a1`, digest 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  `e090a50808a426656b1590460be8d14bb697effe4e32f8c70c167f93b255f7e4`: 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  citation-marker run; superseded by the date correction.
- R3 `20261027T123510Z-f4877603-1519-4791-a422-17453ece5cdf`, digest 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  `b4e5a1e879f63b64ad40d0b4198ca6b7d816d1ae14e5a4c9678bb3e107588105`: 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  date correction (2026-11-23 to 2026-10-27); superseded by the residual 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  marker backfill below.
- R4 `20261027T141830Z-d99e5f76-ba46-4e8a-aa21-aef1b0b928d0`, digest 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  `f34d92e1ab77363e7e429b617ca6c017690b299b8829aa4cf9639a1a2d9563d9`: 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  the authoritative run. The only input change since R3 was adding six 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  citation markers to design.md lines the evidence gate still counted as
  unmarked (wrapped continuation sentences); per-case statistics are
  identical across all four runs (convention 53,081,226 / 9,221,350 / 0; 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  strict-torn-lock 199 / 106 / 81; strict-reserved-spend 5,293 / 1,687 / 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕
  1,080), confirming no model, property, bound or cfg semantics changed 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕.
