/**
 * Coded BUILT-IN rules (no corpus file needed): the repeat-tool-reminder guard
 * ported from the upstream harness guard `guard/repeat-tool-reminder`. Divergences
 * from upstream, deliberate:
 * - dsh-cc shares turn-rules' global MAX_INJECTIONS cap (storm safety); upstream
 *   has no shared cap.
 * - top-level agents only (upstream watches all agents; subagent wiring would
 *   need per-child plumbing through the isTopLevel early-return — deliberately
 *   omitted).
 * - include/exclude wildcards support `*` only (upstream compiles regexes).
 *
 * @module
 */

import type { ToolExecution } from '@dsh-cc/tools'

/** A built-in turn rule: observe post-execute events, reset on user restarts. */
export interface BuiltinRule {
  readonly key: string
  /** Return the reminder body when a threshold is hit, else undefined. Never throws. */
  observe(exec: ToolExecution, result: unknown, ctx: unknown): string | undefined
  /** Clear all chain state (a user message interjected at the prompt seam). */
  onUserRestart(): void
}

export interface RepeatReminderOptions {
  thresholds: readonly number[]
  include: readonly string[]
  exclude: readonly string[]
  argumentsPreviewChars: number
}

/** Chain state for one agent: last canonical call key + consecutive-run length. */
interface Chain {
  key: string
  count: number
}

/** Deep-key-sorted canonical JSON (upstream canonicalize): key order never splits a chain. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) out[key] = canonical((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

/** Wildcard match on the tool name (`*` only). exclude wins over include. */
function tracked(name: string, opts: RepeatReminderOptions): boolean {
  const matches = (pattern: string): boolean => pattern === '*' || pattern === name
  if (opts.include.length > 0 && !opts.include.some(matches)) return false
  return !opts.exclude.some(matches)
}

/**
 * The repeat-reminder built-in: N consecutive identical calls (same tool +
 * canonical args) on the same top-level agent fire a reminder at each of the
 * configured thresholds. Untracked calls (excluded / not included) are
 * TRANSPARENT: they neither extend nor break the chain.
 */
export function createRepeatReminderRule(opts: RepeatReminderOptions): BuiltinRule {
  const thresholdSet = new Set(opts.thresholds)
  // Rebound wholesale by onUserRestart() — a WeakMap cannot be cleared in place.
  let chains = new WeakMap<object, Chain>()
  return {
    key: 'builtin/repeat-reminder',
    observe(exec, _result, _ctx) {
      const agent = exec.agent
      // No agent → no chain to key on (direct ctx.tools.execute() callers).
      if (agent === undefined || (agent as object) === null) return undefined
      if (!tracked(exec.name, opts)) return undefined
      const args = canonical(exec.arguments)
      const key = `${exec.name}\n${JSON.stringify(args)}`
      const chain = chains.get(agent)
      const count = chain !== undefined && chain.key === key ? chain.count + 1 : 1
      chains.set(agent, { key, count })
      if (!thresholdSet.has(count)) return undefined
      let body = `${exec.name} × ${count}`
      if (opts.argumentsPreviewChars > 0) {
        const preview = JSON.stringify(args)
        if (preview !== undefined && preview !== '{}' && preview !== '[]' && preview !== 'null') {
          body += ` — ${preview.slice(0, opts.argumentsPreviewChars)}`
        }
      }
      return body
    },
    onUserRestart() {
      chains = new WeakMap()
    },
  }
}
