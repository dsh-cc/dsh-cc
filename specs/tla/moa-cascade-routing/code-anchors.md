# Code anchors — moa-cascade-routing

Verbatim excerpts from the current worktree, read before modeling. Each
excerpt is byte-exact; source path and line range are given per block.

Refreshed 2026-11-07 for the harness-0.2.2 S4 slice (D3.2): classification
moved to the pre-admission seam, request-time overlays were deleted, and
arming went provenance-signal-driven. **The TLA model itself is unchanged**;
the anchors below track the code only. B4, B7, B8, B9 are untouched by S4.

## B1 — arming truth table (disarm / re-arm; r3-final provenance signals)

Source: `packages/interaction/moa/src/arming.ts:96-138` (excerpt)

```ts
  noteBootPair(pair: ...): void {
    // first-wins, unconditional (even while disabled); also first-wins the
    // userBaseSelection and resolves a deferred rehydrated switch-back check
    ...
  }

  noteUserSelection(selection: ProvenanceSelection): void {
    this.userBase = { ...selection }
    if (this.bootDefault !== undefined && same(selection, this.bootDefault)) {
      this.reason = undefined
      this.armed = true
      return
    }
    this.armed = false
    this.reason = 'explicit-model-switch'
  }

  noteMoaSelection(selection: ProvenanceSelection): void {
    this.lastMoa = { ...selection } // NEVER disarms
  }

  isArmed(): boolean { return this.enabled && this.armed }
```

Disarm is driven ONLY by the driver's explicit `/model` / `/effort` write
signals (`noteUserSelection`) plus the resume-rehydration path
(`rehydrateFromSidecar`, conservative unarmed-until-boot-pair); the pre-step
observation is tripwire-only (`observeTripwire`) and never mutates arming
beyond the first-wins boot baseline.

## B2 — the pre-step observe (frozen selection; tripwire-only)

Source: `packages/interaction/moa/src/sanitizer.ts:46-56` (excerpt)

```ts
    // 0.2.2 semantics: the frozen pair is `payload.modelSelection` of
    // `agent/pre-step` (the loop freezes `agent.model.current()` at preStep
    // start and stamps it on the payload)...
    publishLiveSelection(payload.agent, pairOf(payload.modelSelection))
```

moa's observePreStep then tripwires the published pair
(`observeLiveSelection`, report-only) — there is no longer any overlay for
the observe to precede; truthful-by-construction replaces self-feedback
guarding.

## B3 — admission gate and durable tier select

Source: `packages/interaction/moa/src/router.ts:440-482` (excerpt)

```ts
  const routeAdmission = async (agentLike: unknown, opening: UserMessage): Promise<void> => {
    if (isSubagentAgent(agentLike)) return
    const agent = agentLike as Agent
    if (typeof agent.model?.current !== 'function') return
    await rehydrateFromSidecar(agent)
    const live = agent.model.current()
    // first-wins boot baseline, filtered vs lastMoa (moa's own writes never
    // become "boot")
    ...
    // The §5.3/D3.2 gate, spelled inline:
    if (opening.source?.kind !== 'user') return
    if (!deps.readSettings().enabled) return
    if (!opts.validation.ok) opts.ensureArmed?.()
    if (!opts.validation.ok || !arming.isArmed()) return
    const { tier, row } = await classifyOnce(signal, opening)
    if (tier === undefined) { serveUserBase(agent, live); pendingAdmission = { opening, tier: undefined, row }; return }
    const selection = await tierSelectionFor(tier, live?.reasoningEffort, signal)
    ...
    agent.model.select(selection)          // durable; every following step freezes it
    arming.noteMoaSelection(selection)
    pendingAdmission = { opening, tier, row }  // binds the real turn at noteClaimed
  }
```

Classification runs once per admitted batch at the entry point
(`routeBeforeAdmission`, fail-open wrapped); per-step/per-request
re-classification is impossible by construction — later steps of the turn
read the same durable selection.

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

## B5 — judge ordering: bookkeeping, select-then-followup; stale guard

Source: `packages/interaction/moa/src/judge.ts:355-382` (excerpt)

```ts
    if (rejected && !shadow && !isStale(...) && nextDistinctTier(...) !== undefined && ...) {
      bookkeeping.recordRetryUsed(...)
      release()
      if (!opts.validation.ok || !arming.isArmed()) { /* mid-flight disarm vetoes entirely */ return }
      const toSelection = deps.tierSelection?.(toTier, ...) ?? tierRouteVariables(toTier, deps.routes?.())
      if (toSelection !== undefined) {
        snap.agent.model.select(toSelection) // durable BEFORE the followup
        noteMoaSelection(toSelection)
      }
      snap.agent.followup(createUserMessage({ ..., source: { kind: 'moa-escalation', ... } }))
    }
    // shadow => log only, acted: false, reason 'shadow: would escalate'
```

and the stale guard `isStale` (`judge.ts:223-258`): a genuine `user/message`
event with `seq >= watermark` → `'new genuine user message'`; a
`request/header ... 'change'` event → `'model changed (/model)'`; and since
0.2.2 a durable `model/selection` event (a bare `/model` write opens no
turn) → `'model changed (/model)'`.

## B6 — production floor seam (durable escalation model; floor restore on unrecorded origin)

Source: `packages/interaction/moa/src/judge.ts:371-376` + `state.ts:101-105` (excerpts)

```ts
    // The retry's MODEL is the durable selection the judge wrote BEFORE the
    // followup (crash/resume restores it from the durable model/selection
    // tail — F-3); the retry turn is never re-classified. floorFor(originSeq)
    // is undefined on a retry turn whose escalation was not recorded, and
    // the claim-side escalation branch then restores it from the durable
    // followup provenance (B10) instead of failing open.
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

applied at the shared-state writer call sites (capture, admission seam,
observe tripwire, pre-step splice, judge, sanitizer publish).

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

## B10 — the restore call site (retry-turn routing, D3.2 claim-side)

Source: `packages/interaction/moa/src/router.ts:528-536`

```ts
      if (!isMoaEscalationMessage(source)) return
      if (!opts.validation.ok) opts.ensureArmed?.()
      if (!deps.readSettings().enabled || !opts.validation.ok || !arming.isArmed()) return
      const floor = restoreEscalationFloor(bookkeeping, agentLike, source as OpeningSource, warn)
      if (floor === undefined) return
      setTurnTier({ turn, tier: floor, suppressRow: true })
```

A retry turn is never re-classified. The claim-side bind (the
`agent/inbox/claimed` listener's escalation branch, D3.2) sets the sticky
turn tier from the restored floor with NO status row (the typed followup
itself IS the escalation row, §3.5); the retry's MODEL comes from the
durable selection the judge selected before the followup (B5). When the
in-memory entry is gone or lower than the durable record (crash/resume
between the escalation dispatch and the retry round) the floor is restored
from the log.
