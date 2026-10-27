# Code anchors — moa-cascade-routing

Verbatim excerpts from the current worktree (head d5f7e385), read before
modeling. Each excerpt is byte-exact; source path and line range are given
per block.

## B1 — arming truth table (disarm / re-arm)

Source: `packages/interaction/moa/src/arming.ts:63-98` (excerpt)

```ts
  noteBootPair(pair: ...): void {
    // first-wins, unconditional (even while disabled)
    ...
  }

  observeRequestModel(pair: ...): void {
    ...
    if (this.bootDefault === undefined) return
    if (same(pair, this.bootDefault)) {
      // user returned to no opinion (or never left): (re)arm
      if (!this.armed) { this.armed = true; this.reason = undefined }
      return
    }
    this.armed = false
    this.reason = 'explicit-model-switch'
  }

  isArmed(): boolean { return this.enabled && this.armed }
```

## B2 — the pre-overlay observe (self-feedback guard)

Source: `packages/interaction/moa/src/router.ts:357-372` (excerpt)

```ts
    // S2: observe pre-overlay — always (main agent)
    const resolved = await next()
    observeLiveSelection(pairOf(resolved)) // pair is pre-overlay by construction
    ...
    // "the old header self-feedback trap is structurally impossible"
```

and the sanitizer publish (`packages/interaction/moa/src/sanitizer.ts:47-56`)
publishes the **frozen** `selection.assembled` (not `selection.current`)
before `next()`.

## B3 — classify gate and sticky tier

Source: `packages/interaction/moa/src/router.ts:321-348` (excerpt)

```ts
    // S4: sticky-tier overlay
    if (getTurnTier()?.turn === payload.turn) { ... withTier(resolved, sticky.tier, signal) ... }
    // S5: no decision => serve resolved (fail-open)
    // S7 gate (all conjuncts):
    //   readSettings().enabled && opts.validation.ok && agent !== undefined
    //   && !isSubagentAgent(agent) && selectionVars !== undefined && boot !== undefined
    //   && sameFields(selectionVars, boot)
```

## B4 — escalation bookkeeping (floor, retries, bounds)

Source: `packages/interaction/moa/src/state.ts:60-106` (excerpt)

```ts
export class EscalationBookkeeping {
  private readonly states = new Map<number, { tierFloor: number; retriesUsed: number }>()
  ...
  recordFloor(originSeq: number, tierFloor: number): void {
    // refuses a decreasing floor (monotonicity)
  }
  recordRetryUsed(originSeq: number, fromTier: number, toTier: number, maxEscalations: number): void {
    // invariants: fromTier === live floor, toTier > floor, both in [0, TIER_COUNT)
    // retriesUsed < Math.min(maxEscalations, 3)
    // advances the floor to toTier and counts the retry
  }
```

with `MAX_ESCALATIONS_CEILING = 3`, default `max-escalations: 1`
(`settings.ts:25,130`).

## B5 — judge ordering: bookkeeping before followup; stale guard

Source: `packages/interaction/moa/src/judge.ts:310-390` (excerpt)

```ts
    if (rejected && !shadow && !isStale(...) && nextDistinctTier(...) !== undefined && ...) {
      bookkeeping.recordRetryUsed(...)
      release()
      await agent.followup(moaEscalationMessage(...))   // kind: 'moa-escalation', never 'user'
      ...
    }
    // shadow => log only, acted: false, reason 'shadow: would escalate'
```

and the stale guard `isStale` (`judge.ts:223-245`): a genuine `user/message`
event with `seq >= watermark` → `'new genuine user message'`.

## B6 — production floor-bookkeeping seam (fail-open on unrecorded origin)

Source: `packages/interaction/moa/src/state.ts:101-105` (excerpt)

```ts
    // in production the originSeq entry is created by the FIRST recordRetryUsed
    // with tierFloor = toTier (recordFloor is test/rig-only); floorFor(originSeq)
    // is undefined on a retry-turn whose escalation was not recorded, and
    // tierForTurn then fails open (router.ts:333-334).
```

## B7 — degenerate-ladder and tier-skip rules

Source: `packages/interaction/moa/src/tiers.ts:50-114` (excerpt)

```ts
    // duplicate model only allowed contiguously: [A,A,B,C] arms, [A,B,A,C] refuses
    // seen.size < 2 ⇒ all-same ladder refuses
    // nextDistinctTier scans upward, returns first index whose routeKey !== fromKey;
    //   undefined at top — never hops down
```

## B8 — subagent scope exclusion

Source: `packages/interaction/moa/src/agent-scope.ts:36-48` (excerpt)

```ts
export function isSubagentAgent(agent: Agent): boolean {
  // session.header.origin === 'subagent'
  //   or typeof delegationDepth === 'number' && delegationDepth > 0
  // parentSession deliberately unused (root-session forks carry it)
  // defensive try/catch ⇒ fail-open "not a subagent"
}
```

applied at nine shared-state writer call sites (capture, observe, assemble,
pre-step splice, judge, sanitizer publish).

## B9 — event-sourced escalation floor restore (PR #301, F-3 fix)

Source: `packages/interaction/moa/src/escalation-restore.ts:1-63` (excerpt)

```ts
export function durableEscalations(
  agent: unknown,
  opening: OpeningSource,
): Escalation[] {
  const out: Escalation[] = []
  try {
    const session = (agent as { session?: { snapshotEvents?: () => readonly unknown[] } } | undefined)?.session
    const events = (session?.snapshotEvents?.() ?? []) as {...}[]
    for (const event of events) {
      const source = event.data?.source
      if (event.type !== 'user/message' || source?.kind !== MOA_ESCALATION_KIND || source.originSeq !== opening.originSeq) continue
      if (typeof source.fromTier !== 'number' || typeof source.toTier !== 'number') continue
      out.push({ fromTier: source.fromTier, toTier: source.toTier })
    }
  } catch {
    // Unreadable log: the opening's own record below still restores the floor.
  }
  if (!out.some((e) => e.fromTier === opening.fromTier && e.toTier === opening.toTier)) {
    out.push({ fromTier: opening.fromTier, toTier: opening.toTier })
  }
  return out
}

export function restoreEscalationFloor(
  bookkeeping: EscalationBookkeeping,
  agent: unknown,
  opening: OpeningSource,
  warn: (message: string) => void,
): number | undefined {
  const recorded = bookkeeping.floorFor(opening.originSeq)
  if (recorded !== undefined && recorded >= opening.toTier) return recorded
  try {
    bookkeeping.restoreFromEscalations(opening.originSeq, durableEscalations(agent, opening))
    return bookkeeping.floorFor(opening.originSeq)
  } catch (error) {
    warn(`moa: cannot restore the escalation floor for origin ${opening.originSeq} (...); serving the live selection`)
    return undefined
  }
}
```

with the rebuilding rule at `packages/interaction/moa/src/state.ts:119-140`:
floor = the highest recorded `toTier`, retries = the number of recorded
escalations, monotonic (never lowers a live floor or retry count), and a
malformed record **throws** so the caller warns and serves the live selection
explicitly instead of silently failing open.

## B10 — the restore call site (retry-turn routing) 〔src:ws:specs/tla/moa-cascade-routing/code-anchors.md#L190-L202〕

Source: `packages/interaction/moa/src/router.ts:327-345`

```ts
      if (!gate) return undefined
      const floor = restoreEscalationFloor(bookkeeping, agent, opening.source as OpeningSource, warn)
      if (floor === undefined) return undefined
```

A retry turn is never re-classified; when the in-memory entry is gone or lower
than the durable record (crash/resume between the escalation dispatch and the
retry round) the floor is restored from the log instead of failing open.
