/**
 * Ctrl+P / Shift+Ctrl+P model-alias cycling (plan C6). PURE module: the
 * cycle rules plus the section factory, with the settings namespace and the
 * alias resolver injected as plain functions (the check:tui-boundary rule
 * keeps @deepseek-ai imports in src/harness/ — the cordis/settings glue lives
 * in harness/model-cycling-binding.ts). The configured
 * `cc-model-cycling.cycleOrder` alias list is cycled forward/backward with
 * wrap-around; each step is applied only when the resolved route is
 * advertised by the model catalog. Application goes through
 * `applyModelSwitch` (in-memory selection only — no settings persist).
 * Settings are read LIVE per keypress, never cached.
 * @module @dsh-cc/tui/model-cycling
 */

import { upsertRow, type TuiState } from './store.ts'

/** A fully resolved route (both halves concrete — required for advertisement). */
export interface CycleRoute {
  readonly provider: string
  readonly model: string
}

/** One usable cycle landing: the alias, its position, and the resolved route. */
export interface CyclePick {
  readonly index: number
  readonly alias: string
  readonly route: CycleRoute
  /** Aliases stepped over because they were unresolvable or unadvertised. */
  readonly skipped: readonly string[]
}

/**
 * Pure index rule: one step from `current` with wrap-around. `current === -1`
 * (selection not in the order) plus a forward delta lands on element 0 — the
 * one start rule, no special cases.
 */
export function nextCycleIndex(length: number, current: number, delta: 1 | -1): number {
  return (((current + delta) % length) + length) % length
}

/**
 * Pure start-index rule: the order position whose resolved route equals the
 * live selection, or −1 when none matches (so the first forward step lands on
 * element 0).
 */
export function startIndexOf(
  order: readonly string[],
  current: CycleRoute | undefined,
  resolve: (alias: string) => { provider?: string; model?: string } | undefined,
): number {
  if (current === undefined) return -1
  return order.findIndex((alias) => {
    const route = resolve(alias)
    return route?.provider === current.provider && route?.model === current.model
  })
}

/**
 * Pure cycle walk: step `delta` from `startIndex` up to `order.length` times,
 * taking the first alias `usable` accepts and recording every skipped alias.
 * Returns undefined when nothing in the order is usable.
 */
export function pickCycleTarget(
  order: readonly string[],
  startIndex: number,
  delta: 1 | -1,
  usable: (alias: string) => CycleRoute | undefined,
): CyclePick | undefined {
  const skipped: string[] = []
  let index = startIndex
  for (let step = 1; step <= order.length; step += 1) {
    index = nextCycleIndex(order.length, index, delta)
    const alias = order[index]
    if (alias === undefined) continue
    const route = usable(alias)
    if (route !== undefined) return { index, alias, route, skipped }
    skipped.push(alias)
  }
  return undefined
}

/** Collaborator seams for the cycling section (faked in specs). */
export interface ModelCyclingDeps {
  /**
   * Live cycle-order reader — read per keypress, never cached (settings hot
   * reload rides the binding). Empty/absent → cycling is inert.
   */
  readCycleOrder(): readonly string[]
  /** Alias resolver (cc-model-aliases), live per call. */
  resolveAlias(alias: string): { readonly provider?: string | undefined; readonly model?: string | undefined } | undefined
  /** Live selection ref; `current` is the route Ctrl+P starts from. */
  selection: { readonly current?: { provider: string; model: string } | undefined }
  applyModelSwitch(provider: string, model: string): Promise<void>
  loadCatalog(): Promise<readonly { provider: string; id: string }[]>
  emit(next: TuiState): void
  state(): TuiState
}

/**
 * Return the InputSink cycle method. All collaboration is injected as plain
 * functions, so this module stays harness-free (check:tui-boundary).
 */
export function createModelCyclingSection(rt: ModelCyclingDeps): {
  /** One cycle step; false = no cycle order configured (key falls through). */
  cycleModel(delta: 1 | -1): boolean
} {
  const toast = (text: string): void => {
    rt.emit(upsertRow(rt.state(), { kind: 'status', text }))
  }

  const cycleModel = (delta: 1 | -1): boolean => {
    const order = rt.readCycleOrder()
    if (order.length === 0) return false
    // Consume the key synchronously; resolution + catalog advertisement is an
    // async per-keypress continuation (the handler may await loadCatalog).
    void runCycle(order, delta).catch(() => {})
    return true
  }

  const runCycle = async (order: readonly string[], delta: 1 | -1): Promise<void> => {
    // Resolve every entry once per keypress (the alias service re-reads
    // settings per call). Entries without a fully concrete route cannot be
    // advertised and are skipped.
    const routes = new Map<string, CycleRoute>()
    for (const alias of order) {
      const route = rt.resolveAlias(alias)
      if (typeof route?.provider === 'string' && typeof route?.model === 'string') {
        routes.set(alias, { provider: route.provider, model: route.model })
      }
    }
    const startIndex = startIndexOf(order, rt.selection.current, (alias) => routes.get(alias))
    const catalog = await rt.loadCatalog()
    const advertised = new Set(catalog.map((entry) => `${entry.provider}/${entry.id}`))
    const pick = pickCycleTarget(order, startIndex, delta, (alias) => {
      const route = routes.get(alias)
      if (route === undefined) return undefined
      return advertised.has(`${route.provider}/${route.model}`) ? route : undefined
    })
    if (pick === undefined) {
      toast('No advertised model in the cycle order.')
      return
    }
    for (const alias of pick.skipped) {
      toast(`Skipped "${alias}" (not advertised); trying the next entry.`)
    }
    await rt.applyModelSwitch(pick.route.provider, pick.route.model)
  }

  return { cycleModel }
}
