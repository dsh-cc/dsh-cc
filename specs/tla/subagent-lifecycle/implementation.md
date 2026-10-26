# Implementation record — subagent-lifecycle

Keyed to the final run of 2026-10-26 (post-#299 revision) 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L257-L298〕. Not part of
inputDigest 〔src:ws:specs/tla/subagent-lifecycle/design.md#L1-L135〕.

## Run lineage

- **Final run (revised model, includes the PR #299 continuation guard):**
  runId `20261026T132526Z-3761d98c-6b16-4461-a3aa-a1df1ceb2779`, 〔src:ws:specs/tla/subagent-lifecycle/design.md#L1-L135〕
  inputDigest `490b412ec8e8091ca313304cb63802b54ea50d491e628e3aeb86c08ec1267dcf` 〔src:ws:specs/tla/subagent-lifecycle/design.md#L1-L135〕.
  Identical per-case criteria to its predecessor
  `20261026T130635Z-cc70d9f6-…` (digest `921ad594…`): the only input change
  between them was citation-marker backfill in design.md 〔src:ws:specs/tla/subagent-lifecycle/design.md#L1-L135〕, which does not
  affect the model, cfgs or properties.
  The model gained the `CapacityObservable` constant and the capacity guard
  inside `Restart`, the `strict-cap-unobservable` probe, refreshed code
  anchors (A11–A13) and a revised design.md 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L214-L298〕; the three cfgs were regenerated
  (the cfg-drift guard blocked the stale bytes as designed; they were
  inspected and removed).
- **Superseded run (pre-#299 semantics):**
  `20261026T070646Z-9165fd15-e95f-4edb-9b95-1ed252242b2c` — its `convention`
  case produced the F-2 counterexample (`CapOK`,
  `Spawn, Spawn, Settle, Spawn, Restart`) that motivated the fix.
- runnerPackage: `@dsh-cc/plugin-dsh-cc-agents` 0.9.2, TLC 1.7.4, Java 〔src:ws:specs/tla/subagent-lifecycle/design.md#L1-L135〕
  25.0.2, darwin 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L257-L298〕
- check-evidence: `valid` / fresh / verification `counterexample` (aggregate
  — the three expansion probes are expected counterexamples)

## Case results (final run)

| Case | Status | Statistics (generated/distinct/queue) |
|---|---|---|
| convention | **verified** | 15128/2918/0 | 〔src:ws:specs/tla/subagent-lifecycle/design.md#L1-L135〕
| strict-cap-toctou | counterexample — CapOK | 464/173/86 | 〔src:ws:specs/tla/subagent-lifecycle/design.md#L1-L135〕
| strict-cap-unobservable | counterexample — CapOK | 514/202/123 | 〔src:ws:specs/tla/subagent-lifecycle/design.md#L1-L135〕
| strict-late-continue | counterexample — NoLateEpoch | 968/366/222 | 〔src:ws:specs/tla/subagent-lifecycle/design.md#L1-L135〕

## Counterexample dispositions

### convention / CapOK — F-2 CLOSED (fixed by PR #299) 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L23-L54〕

The pre-#299 counterexample trace — `Spawn, Spawn, Settle, Spawn, Restart`
(a continuation at the cap admitting a 26th activation) — no longer exists:
`Restart` carries the continuation capacity guard, so `CapOK` verifies for
every interleaving in the bounds. The fix (merge commit `1c89f1e3`):

- `packages/subagent/resume-pins/src/live-capacity.ts` — the counting
  predicate, the fail-open degradation contract, the shared refusal literal;
- the `tools/pre-execute` gate refuses a continuation at the cap before pin
  admission (same-epoch steers to a live agent pass — no new slot);
- `packages/subagent/task` extracts `LIVE_CAPACITY_REFUSAL` (the D4 copy) so
  both lanes share one literal, pinned byte-for-byte by test.

Acceptance mapping: model `Restart` guard ↔ the gate's
`if (!targetLive) { … continuationCapacityRefusal … }`; model invariant 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L233-L256〕
`CapOK` ↔ `live-capacity.spec.ts` "denies a continuation at the cap",
"passes a same-epoch steer", "admits one below the cap"; copy equality ↔
`continuation-capacity.spec.ts`.

### strict-cap-toctou / CapOK — F-1 (defect, still open)

Trace: `SpawnCheck ×3 → SpawnStart ×3`. The spawn guard and
`startContinuable` are separate awaits with no lock, so concurrent spawn 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L23-L54〕
admissions can overshoot. Declared out of scope in the fix PR; the upstream
`maxActiveSubagents` activation cap is the practical backstop 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L23-L54〕.

### strict-cap-unobservable / CapOK — documented fail-open boundary

Trace: `Spawn, Spawn, Settle, Spawn, Restart` with
`CapacityObservable = FALSE`. When the live registry is unreadable (missing 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L23-L54〕
`listChildren`, throwing listing, absent registry) the production guard 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L257-L298〕
admits — a safety valve must not wedge continuations on its own
infrastructure. Pinned by `live-capacity.spec.ts` "degrades open …".

### strict-late-continue / NoLateEpoch — accepted residual

Trace: `Spawn, Settle, ContinueCheck, GraceFire, Restart`. An in-flight
send_message admitted before the grace fire still gets one extra epoch — the
code comment's documented residual.

## Unmodeled scope

- Cooperative release (still-resident; 10 s observe timeout) 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L198-L213〕 — modeled as
  immediate eviction.
- Pin-store persistence, `serializePerKey` FIFO, resume pins, cross-session 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L198-L213〕
  cold-resume after drain (upstream `it.skip` gap).
- Ephemeral one-shot lane (TTL reaper), coordinator worker registry, one-shot 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L198-L213〕
  ledger, suppress-settled notices.
- Grace-window durations — abstracted to a nondeterministic fire.
- The gate's pin-policy evaluation (session/workspace/definition/route
  checks) — orthogonal to capacity, covered by `gate.spec.ts`.

## Suggested regression tests (repo changes, not made here)

1. Spawn-admission TOCTOU (F-1): two concurrent `collectForeground` calls at 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L23-L54〕
   `live = MaxLive - 1` with a deferred `startContinuable` — pins the 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L257-L298〕
   overshoot.
2. In-flight send vs grace fire: gate pass → fire → restart lands — pins the
   accepted residual explicitly (today only a code comment).
