/**
 * Fail-soft resilience for `subagents.start` toolFilter drift: the host's
 * `tools.restrict()` throws on any allow-listed name that is not a global
 * (inherited) tool. Some names — notably the driver-injected child-scoped
 * `structured_output` — are visible to the child but NOT restrictable, so a
 * stale filter naming them dies at dispatch. This helper degrades such a
 * throw to a warn-once plus a single retry with the rejected names removed
 * (§4.2 of docs/plans/2026-09-23-auto-dream-dispatch-fix.md). Any other
 * error, or a failing retry, propagates unchanged.
 * @module @dsh-cc/memory/restrict-resilience
 */

/** Minimal logger shape both lanes already rely on. */
export interface ResilienceLogger {
  warn(message: string): void
}

/** The host throw's unknown-name prefix; names are comma-separated, quoted, up to `;`. */
const UNKNOWN_TOOL_PREFIX = /restrict\(\) names unknown global tools? /

/** Names already warned about this process (keyed by tool name). */
const warnedNames = new Set<string>()

/** Clear the warn-once state (test hook). */
export function resetRestrictWarnState(): void {
  warnedNames.clear()
}

/**
 * Harvest every quoted name between the throw's prefix and the following `;`.
 */
export function harvestUnknownToolNames(message: string): string[] {
  const match = UNKNOWN_TOOL_PREFIX.exec(message)
  if (match === null) return []
  const rest = message.slice(match.index + match[0].length)
  const end = rest.indexOf(';')
  if (end === -1) return []
  return [...rest.slice(0, end).matchAll(/"([^"]+)"/g)]
    .map(m => m[1])
    .filter((name): name is string => name !== undefined)
}

/** The filter shape the helper reads/reduces; extra request fields pass through untouched. */
interface FilterShape {
  allow?: readonly string[]
  deny?: readonly string[]
}

/**
 * Drop `dropped` from the filter's allow list (preserving deny and any other
 * fields); an absent filter stays absent.
 */
function reduceFilter(filter: FilterShape | undefined, dropped: readonly string[]): FilterShape | undefined {
  if (filter === undefined) return undefined
  return {
    ...filter,
    allow: (filter.allow ?? []).filter(name => !dropped.includes(name)),
  }
}

/**
 * `subagents.start(provider, request)` with one-shot filter-drop resilience:
 * on a restrict unknown-tool throw, warn once per dropped name (per process)
 * and retry exactly once with those names removed from `toolFilter.allow`.
 * The request type stays structural/generic so both the dream lane
 * (memory-job.ts) and the recall selector (recall.ts) can pass their shapes.
 */
export async function startWithFilterResilience<R extends { toolFilter?: FilterShape }>(
  subagents: { start(name: string, request: R): Promise<unknown> },
  provider: string,
  request: R,
  logger: ResilienceLogger,
): Promise<unknown> {
  try {
    return await subagents.start(provider, request)
  } catch (err) {
    const dropped = harvestUnknownToolNames(String(err instanceof Error ? err.message : err))
    if (dropped.length === 0) throw err
    for (const name of dropped) {
      if (!warnedNames.has(name)) {
        warnedNames.add(name)
        logger.warn(`toolFilter dropped "${name}": tools.restrict() cannot allow-list it (not a global tool); it stays child-visible when injected by the driver`)
      }
    }
    // exactOptionalPropertyTypes: omit toolFilter entirely when it was absent.
    const retryRequest: R = request.toolFilter === undefined
      ? request
      : { ...request, toolFilter: reduceFilter(request.toolFilter, dropped) as R['toolFilter'] }
    return await subagents.start(provider, retryRequest)
  }
}
