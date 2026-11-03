# Implementation record: decision-gate-coalescing

Effective project rules at modeling time: the root AGENTS.md carries **no**
formal-design screening clause — screening is session-adopted (user request
2026-11-02; full-program scope confirmed via ask_user_question). Adoption
snippet: `<skill>/references/agents-snippet.md`. No formal review dispatched.

## Final run

- runId: `20261103T051921Z-2fd33c39-8d92-42a8-9b62-6b519e2b4ef9` (review-fold rerun)
- toolchain: TLC 1.7.4 (bundled JAR, SHA-256 pinned), Java 25.0.2, runner
  `@dsh-cc/plugin-dsh-cc-agents` 0.9.3-rc.4, darwin.
- convention (core): **verified** — 316 states generated, 59 distinct, 0 left on queue; all 6 invariants hold.
- Probes (expansion, expected counterexample; each hit exactly its intended
  invariant):
  - `strict-abort-last-waiter` → `AbortOnlyWhenAllCancelled`: the coalesced
    request aborted while a waiter survives.
  - `strict-cache-partial` → `CacheCompleteOnly`: a partial answer cached.
  - `strict-skip-reval` → `CacheCompleteOnly`: an identity-stale answer
    treated as cacheable.
  - `strict-serve-after-cancel` → `NoConsumeAfterCancel`: a cancelled waiter
    consumes the result.
- `check-evidence`: valid and fresh; aggregate `counterexample` is the
  expected legal form for a probe package.

## Counterexample classification

All development failures were **modeling defects**, never design defects:

1. The first `CacheCompleteOnly` counterexample conflated the current
   request's answer (`state`) with the cached answer: after all waiters
   cancelled, the request slot reset `state` while the cache entry from an
   earlier complete answer correctly survived. Fixed by tracking the cached
   answer's shape in a separate `cachedState` variable.
2. Several `UNCHANGED` lists missed newly added variables (`cachedState`,
   `cancelled` on `Start`/`AbortEarly`) — found by the per-action
   completeness audit and one TLC "not completely specified" report.
3. `UNCHANGED` cannot contain a primed variable (`cancelled'`) — a level
   error; the last-waiter cancellation branch was rewritten with explicit
   assignments.

## Verified scope and mapping

- Model ↔ design: the shared concurrency rules in
  `docs/plans/2026-11-02-systemone-11-summary-gate.md` §Lifecycle (cache
  key, only-complete-answers-cached, coalescing with independent
  cancellation), restated by `...-05-tool-discovery.md` (same-key request
  coalescing; abort only when all waiters cancel), `...-06-skill-
  recommendation.md` and `...-12-reducer-gate.md`. One model covers the
  shared protocol for all four features.
- Property → clause: `AbortOnlyWhenAllCancelled` ← the coalescing abort
  rule; `CacheCompleteOnly` ← only-complete-validated-answers;
  `NoConsumeAfterCancel` ← cancelled waiters consume nothing;
  `SettledHoldsSlot`/`ValidAtConsume` ← the drain and revalidation rules.
- Action → planned code: `Join`/`Start` ↔ the gate cache lookup and
  coalescing seam in each feature's gate module; `Cancel`/`AbortEarly` ↔
  per-caller signal handling; `Respond`/`Consume`/`Leave` ↔ the runner
  adapter's settlement and waiter fan-out; `ClearCache` ↔ TTL/expiry and
  settings-change invalidation.

## Not verified (explicitly out of scope)

- Feature-specific settings, thresholds, question shapes, batching and
  window arithmetic (each feature doc specifies its own).
- The cache key's full composition (project, session, agent, originSeq,
  callId, text hash, identity, versions, parameters) — modeled as one key.
- S1-02 metering and budget admission, and the business fallback behaviors
  (each feature's failure table).
- Liveness: a waiter that never leaves is a legal state; the model has no
  fairness.

## Review fold (three-seat impl-readiness review)

- `valid` now has a real antagonist (`IdentityChange` sets it FALSE and
  drops the cache); the `strict-skip-reval` probe hits `CacheNeedsValidIdentity`.
- Consumption is observed in `consumed`; `CancelledNeverConsumed` is the
  flag-free property, and `AbortEarly` injects an `early-abort` witness the
  `NoEarlyAbort` invariant rejects.
- The captured identity is snapshotted at dispatch and compared at
  settlement (the post-await revalidation the design names).

