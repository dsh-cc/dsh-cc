/**
 * Statusline HUD + sessionProjections feed for the TUI driver.
 *
 * Migrated out of createDriver (harness/driver.ts) as a free-function
 * collaborator so the factory stays under the line budget. Receives a
 * structural {@link DriverHudCtx} instead of importing the factory (no cycle).
 *
 * Owned state: the git-branch probe result, the sessionProjections handle, and
 * the derived HUD patch path. Exposes back to createDriver the pieces the
 * factory (runLocal usage panel) and switchSession still need: applyUsage,
 * projections, statusLineOf, seedHud, seedTodos, refreshBranch.
 * @module @dsh-cc/tui/harness/driver-hud
 */

import {
  setHud,
  setTodos,
  setTurnActive,
  setUsage,
  type HudView,
  type UsageView,
} from '../store.ts'
import {
  breakdownOf,
  occupancyOf,
  percentOf,
  sameTodos,
  sameUsage,
  todosOf,
  tokensOf,
  totalsOf,
  usageViewOf,
} from './usage-view.ts'
import {
  type ContextPressureStateLike,
  type SessionProjectionsLike,
  type TokenUsageStateLike,
} from '../state/driver-types.ts'
import { formatModeLine, formatStatusLine } from '../statusline.ts'
import { truncateToWidth } from '@dsh-cc/pi-tui'
import type { DriverHudCtx } from './driver-ctx.ts'

/**
 * Build the statusline HUD section. Runs the boot sequence on construction —
 * in original order: branch probe, seed HUD/todos from live projections, anchor
 * the working line if busy, then subscribe to the change feed — so createDriver
 * needs no extra call.
 */
export function createHudSection(rt: DriverHudCtx) {
  const { state, emit, ctx, cwd, current, selection, branchProbe, statusline } = rt

  // --- Branch: one best-effort probe at boot and after each switchSession (the
  // cwd may differ per session). Async is fine — a late landing re-emits so
  // the footer picks it up; a probe superseded by a switch is dropped by the
  // sequence check. The probe never throws; failures just omit the segment.
  // No timer, one probe per (re)bind — zero polling.
  let branch: string | undefined
  let branchSeq = 0
  const refreshBranch = (): void => {
    const seq = ++branchSeq
    const dir = current.agent.session.header.cwd ?? cwd
    void Promise.resolve(branchProbe(dir))
      .catch(() => undefined)
      .then(next => {
        if (seq !== branchSeq || next === branch) return
        branch = next
        // Same-reference emit: re-notifies subscribers so root re-reads the
        // statusline getter with the fresh branch.
        emit(state())
      })
  }
  refreshBranch()

  // Projections: seed once from stateOf (a resumed session may already be
  // populated), then keep the hud fresh from the change feed — event-driven,
  // filtered to the live session so late events from a disposed session are
  // dropped by the id mismatch.
  const projections = ctx.get('sessionProjections') as SessionProjectionsLike | undefined
  const applyHud = (patch: Partial<HudView>): void => {
    const hud = state().hud
    const percentSame = patch.contextPercent === undefined || hud?.contextPercent === patch.contextPercent
    const tokens = patch.tokens
    const tokensSame = tokens === undefined
      || (hud?.tokens !== undefined && hud.tokens.input === tokens.input && hud.tokens.output === tokens.output)
    const detail = patch.contextTokens
    const detailSame = detail === undefined
      || (hud?.contextTokens !== undefined
        && hud.contextTokens.used === detail.used
        && hud.contextTokens.window === detail.window)
    if (percentSame && tokensSame && detailSame) return // emit only on an actual change
    emit(setHud(state(), patch))
  }
  const applyUsage = (patch: UsageView | undefined): void => {
    if (patch === undefined) return
    const s = state()
    const merged: UsageView = { ...s.usage, ...patch }
    if (sameUsage(s.usage, merged)) return
    emit(setUsage(s, merged))
  }
  const seedHud = (): void => {
    statusline?.onRebind()
    const s = state()
    const patch: Partial<HudView> = {}
    if (projections !== undefined) {
      const tokens = tokensOf(projections.stateOf(current.agent.session, 'tokenUsage') as TokenUsageStateLike | undefined)
      if (tokens !== undefined) patch.tokens = tokens
      const pressure = projections.stateOf(current.agent.session, 'contextPressure') as ContextPressureStateLike | undefined
      const percent = percentOf(pressure)
      if (percent !== undefined) patch.contextPercent = percent
      const occupancy = occupancyOf(pressure)
      if (occupancy !== undefined) patch.contextTokens = occupancy
    }
    // Replace wholesale: clear first so stale fields from a previous session
    // never leak, then apply whatever the new session actually has.
    let next = setHud(s, undefined)
    if (patch.contextPercent !== undefined || patch.tokens !== undefined || patch.contextTokens !== undefined) {
      next = setHud(next, patch)
    }
    if (next !== s) emit(next)
  }
  // Todos: same seeding contract as the HUD — stateOf at (re)bind, then the
  // change feed. Absent (`null` before the first write) clears the strip so
  // no cross-session leak survives a switch.
  const seedTodos = (): void => {
    const s = state()
    const value = projections === undefined
      ? undefined
      : projections.stateOf(current.agent.session, 'todos')
    const todos = todosOf(value)
    if (sameTodos(s.todos, todos)) return
    emit(setTodos(s, todos))
  }
  seedHud()
  seedTodos()
  // Boot may resume a log that ended mid-turn (crashed process): the setBusy
  // sync above flipped busy from the ground-truth agent status, so anchor the
  // working line here — deliberately after seedHud, so outputBase reads the
  // seeded token totals instead of pinning an unseeded baseline.
  if (state().busy) {
    emit(setTurnActive(state(), { startedAt: Date.now(), outputBase: state().hud?.tokens?.output }))
  }
  if (projections !== undefined) {
    projections.onChanged((session, key, value) => {
      if (session.id !== current.agent.session.id) return
      statusline?.onProjection(key)
      if (key === 'tokenUsage') {
        const usage = value as TokenUsageStateLike | undefined
        const tokens = tokensOf(usage)
        if (tokens !== undefined) applyHud({ tokens })
        applyUsage(usageViewOf(totalsOf(usage), undefined, undefined))
        // Working-line rebase guard: an anchor created before the HUD was
        // seeded carries outputBase === undefined; the first tokenUsage
        // change pins it. Strictly turn-MODIFYING (turn must already exist) —
        // a tokenUsage emit while idle must never conjure a phantom anchor.
        // setTurnActive re-derives verbIndex deterministically from the
        // unchanged startedAt, so this is a pure baseline pin; the live
        // stepStartedAt passes through so pinning never resets a mid-step
        // clock.
        const turn = state().turn
        if (turn !== undefined && turn.outputBase === undefined && tokens !== undefined) {
          emit(setTurnActive(state(), { startedAt: turn.startedAt, outputBase: tokens.output, stepStartedAt: turn.stepStartedAt }))
        }
      } else if (key === 'contextPressure') {
        const pressure = value as ContextPressureStateLike | undefined
        const percent = percentOf(pressure)
        const occupancy = occupancyOf(pressure)
        if (percent === undefined && occupancy === undefined) return
        applyHud({
          ...percent === undefined ? {} : { contextPercent: percent },
          ...occupancy === undefined ? {} : { contextTokens: occupancy },
        })
        applyUsage(usageViewOf(undefined, occupancy, undefined))
      } else if (key === 'todos') {
        const todos = todosOf(value)
        if (sameTodos(state().todos, todos)) return
        emit(setTodos(state(), todos))
      } else if (key === 'contextBreakdown') {
        applyUsage(usageViewOf(undefined, undefined, breakdownOf(value)))
      }
    })
  }

  const statusLineOf = (width?: number): string => {
    // Custom statusLine (plan §3.2/D3/D4): active → the command's rows with
    // padding plus a client-drawn mode row below; inactive → today's built-in
    // line, byte-identical.
    const custom = statusline?.override()
    if (custom !== undefined) {
      // Blank detection must trim: with padding > 0 an all-blank settle is
      // whitespace, not ''. Blank → the mode row alone.
      if (custom.trim().length === 0) return formatModeLine(state().permissionMode)
      const rows = custom.split('\n')
      const clipped = width === undefined
        ? rows
        : rows.map(row => truncateToWidth(row, width))
      return `${clipped.join('\n')}\n${formatModeLine(state().permissionMode)}`
    }
    const effort = selection.current?.reasoningEffort
    const s = state()
    return formatStatusLine({
      cwd: current.agent.session.header.cwd ?? cwd,
      sessionId: String(current.agent.session.id),
      permissionMode: s.permissionMode,
      ...selection.current === undefined ? {} : { model: selection.current.model },
      ...effort === undefined ? {} : { effort },
      ...branch === undefined ? {} : { branch },
      ...s.hud?.contextPercent === undefined ? {} : { contextPercent: s.hud.contextPercent },
      ...s.hud?.contextTokens === undefined ? {} : { contextTokens: s.hud.contextTokens },
      ...s.hud?.tokens === undefined ? {} : { tokens: s.hud.tokens },
      busy: s.busy,
    }, width === undefined ? {} : { width })
  }

  return { refreshBranch, seedHud, seedTodos, applyUsage, projections, statusLineOf }
}
