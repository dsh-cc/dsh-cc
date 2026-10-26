# Implementation record — subagent-lifecycle

Keyed to the final run of 2026-10-26 (see below). Not part of inputDigest.

## Final run

- runId: `20261026T070646Z-9165fd15-e95f-4edb-9b95-1ed252242b2c`
- inputDigest: `61cd9a05ef4808b46d208af519338ac093ecfc11c3b4a8f5d6dd84915222a221`
  (note: this digest predates the module-name/EXTENDS/Cardinality fixes of
  earlier failed runs — the digest above is the successful run's own
  recorded value; the authoritative digest is in `evidence.json`)
- runnerPackage: `@dsh-cc/plugin-dsh-cc-agents` 0.9.2, TLC 1.7.4
  (jarSha256 936a2620…), Java 25.0.2, darwin
- check-evidence: `valid` / fresh / verification `counterexample` (exit 0)

## Case results

| Case | Status | Statistics (generated/distinct/queue) |
|---|---|---|
| convention | counterexample — CapOK violated | 500/202/123 (stopped at first violation) |
| strict-cap-toctou | counterexample — CapOK violated | 464/173/86 |
| strict-late-continue | counterexample — NoLateEpoch violated | 968/366/222 |

## Counterexample dispositions

### convention / CapOK — FINDING F-2 (requirement ambiguity, pending user adjudication)

Trace: `SpawnAtomic → SpawnAtomic → Settle → SpawnAtomic → Restart`.
Two children fill MaxLive=2; one settles; a third spawn is admitted
(live=1 < 2); the settled child is then restarted via send_message →
3 running children, MaxLive exceeded.

Root cause (verified in code): `assertLiveCapacity` guards only the three
spawn lanes — `collectForeground` (`background-start.ts:284`),
`startBackground` (`:402`), and the ephemeral dispatch
(`ephemeral-dispatch.ts:87`). The send_message continuation path
(`packages/subagent/resume-pins/src/plugin.ts`) checks the tombstone
marker but never the live-capacity. The upstream harness
`maxActiveSubagents` (default 8) is the only backstop for
continuation-created activations, and it fails with a bare
ACTIVATION_LIMIT_REACHED with no remedy pointer (per the 25-cap's own doc
comment). The prompt contract says "A background child holds one of 25
live-child capacity slots while it is running", which reads as a global
invariant but is enforced as a spawn-lane admission check only.

Classification: **defect (user adjudication 2026-10-26: the 25-cap is a
global bound)** — the send_message admission path
(`packages/subagent/resume-pins/src/plugin.ts`) should check live capacity
before admitting a continuation; today only the three spawn lanes do. The
prompt contract ("A background child holds one of 25 live-child capacity
slots while it is running") states the intended global semantics. Fix
belongs in a separate PR (production code untouched in this modeling
task); the model keeps CapOK as the global property, and this
counterexample is its reproduction.

### strict-cap-toctou / CapOK — FINDING F-1 (real defect, known)

Trace: `SpawnCheck ×3 → SpawnStart ×3` (with one child already running in
general). Two or more admissions interleave between the guard's
`await seam.listChildren` and the later `startContinuable` await; the
guard counts only already-`running` children, so concurrent in-flight
admissions are invisible to each other and can overshoot the cap.

Classification: **design defect (bounded, acknowledged)** — the code has
no lock between check and start; the cap is documented as "a safety valve,
not a scheduling policy", and the upstream activation cap bounds the
overshoot in practice. Reported, not fixed.

### strict-late-continue / NoLateEpoch — documented accepted residual

Trace: `SpawnAtomic → Settle → ContinueCheck → GraceFire → Restart`. The
send_message gate passes (marker not yet set), the grace window fires and
tombstones the ready row, then the in-flight admission restarts the child
for one extra epoch. This matches the code comment verbatim (release.ts
"an in-flight send_message that lands after the fire gets its one extra
epoch and a fresh window (the accepted residual)").

Classification: accepted residual — intended behavior, kept as a probe
that pins it.

## Unmodeled scope

- Cooperative release (still-resident / cancel-resistant turn keeping its
  slot; 10 s observe timeout) — modeled as immediate eviction.
- Pin-store persistence, `serializePerKey` per-child FIFO, resume pins,
  cross-session cold-resume after drain (upstream `it.skip` gap).
- Ephemeral one-shot lane (TTL reaper), coordinator worker registry,
  one-shot ledger, suppress-settled notices.
- Grace-window durations (30 min fg / 2 h bg / override 0) — abstracted
  to nondeterministic fire.
- Duplicate-id / re-tier races (childIds are fresh UUIDs).

## Suggested regression tests (repo changes, not made here)

1. Cap semantics: spawn to 24 running children, settle one, restart it via
   send_message — asserts whether the 25th slot logic holds (pins the
   F-2 disposition whichever way it is adjudicated).
2. Admission TOCTOU: two concurrent `collectForeground` calls at
   live=MaxLive-1 with a deferred `startContinuable` — pins the overshoot
   (F-1).
3. In-flight send vs grace fire: gate pass → fire → restart lands — pins
   the accepted residual explicitly (currently only a code comment).
