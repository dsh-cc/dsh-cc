# Design: decision-gate-coalescing (shared protocol S1-05/S1-06/S1-11/S1-12)

Model directory: `specs/tla/decision-gate-coalescing`. Module `Model`,
spec `Spec`, safety-only.

## Formal design screening

- mode: **auto** (session-scoped; the project rules carry no formal-design
  screening clause at this revision — user request 2026-11-02; adoption
  snippet at `<skill>/references/agents-snippet.md`).
- decision: **enabled**
- triggerIds: FD-T1 (the gate cache and the single in-flight request are
  shared mutable state across concurrent callers), FD-T2 (per-caller
  cancellation races the coalesced response; a late response meets cancelled
  and surviving waiters).
- backends: `["tla"]`, modelDirs: `{"tla": "specs/tla/decision-gate-coalescing"}`.
- behavioral source: the shared concurrency rules stated identically in
  `docs/plans/2026-11-02-systemone-11-summary-gate.md` §Lifecycle (cache key
  composition, "concurrent gates with the same key may coalesce into one
  read-only request, with waiters cancelled by the disposal signal", only
  complete successful answers cached), `...-05-tool-discovery.md` (same-key
  request coalescing; each caller cancels independently; the underlying
  runner is aborted only when all waiters cancel), `...-06-skill-
  recommendation.md` and `...-12-reducer-gate.md` (same rules).
  One model covers the shared protocol; per-feature differences (settings,
  thresholds, question shapes) are out of scope by construction.

## Requirements

- **REQ-1** Callers with the same key coalesce onto one in-flight read-only
  request; a second request is never issued while one is in flight.
- **REQ-2** Each caller cancels independently; the coalesced request is
  aborted only when every waiter has cancelled.
- **REQ-3** Only a complete, successful, identity-validated answer is
  cached; unavailable, cancelled or partial results never enter the cache.
- **REQ-4** A cancelled waiter never consumes a result.
- **REQ-5** Identity is revalidated after every await; a stale identity
  discards the whole suggestion set.
- **REQ-6** Over-bound input, a missing service or an unresolvable route
  issues no request at all (the business falls back).

## State variables

| Variable | Meaning |
|---|---|
| `inflight` | the single coalesced request slot (0 = none) |
| `waiters` | callers currently joined to the in-flight request |
| `cancelled` | waiters that have cancelled (independent per caller) |
| `phase` | idle / dispatched / settled |
| `state` | the answer shape: ok / partial / none |
| `cache` | a complete validated answer is cached for the key |
| `valid` | the route identity is still valid |

## Coverage matrix

| Invariant | Requirement | Adverse trace challenged |
|---|---|---|
| `AbortOnlyWhenAllCancelled` | REQ-2 | `AbortLastWaiter` probe: request aborted while a waiter survives |
| `CacheCompleteOnly` | REQ-3/5 | `CachePartial` / `SkipReval` probes: a partial or stale-identity answer cached |
| `NoConsumeAfterCancel` | REQ-4 | `ServeAfterCancel` probe: a cancelled waiter consumes |
| `SettledHoldsSlot` | REQ-1 | a settled answer leaving the slot before waiters drain |
| `ValidAtConsume` | REQ-5 | consumption after an identity change |
| `TypeOK` | — | — |

## Bounds and assumptions

- Two callers, one request slot, two answer shapes (ok/partial) — the
  smallest configuration that still exercises coalescing, independent
  cancellation and the drain race.
- The cache models the per-key entry (present/absent), not the full key
  composition; the four features' key formulas differ but share the
  completeness rule.
- Over-bound input and unavailable service collapse into `NoRequest`.
- Out of scope: feature-specific settings, thresholds, question shapes,
  TUS/reducer generation, S1-02 metering, cache TTL timing (only the
  ordering that expiry clears before a new start matters — `ClearCache`).
