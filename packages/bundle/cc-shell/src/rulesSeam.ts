/**
 * The plugin rules seam host: bridges CC plugin `rules/*.mdc` entries into a
 * `cc:plugin-rules` system-prompt section through the loader's `RulesSeam`
 * guest contract. Provided by the cc-shell-glue composition via a child plugin
 * (a direct provide on the LOADING glue fiber is invisible to strict
 * `ctx.get`), so the loader's `mountRules` finds it under the `rules` key.
 *
 * Rendering (docs/plans/2026-09-15-cursor-plugin-dialect.md §3.3, PR-B S5):
 * one consolidated section over all plugins; per plugin, `alwaysApply` entries
 * render verbatim under "Rules from plugin <name>", glob-scoped entries render
 * as "When editing files matching `<globs>`: <body>", and scopeless entries
 * (falsy alwaysApply, empty globs) render as generic guidance with a
 * `logger.warn` at merge time. Prompt-budget guard (§7): each plugin's
 * rendered contribution is capped at {@link RULES_BUDGET_CAP_CHARS} chars —
 * over-budget text is truncated with an explicit "... (truncated)" tail plus a
 * warning. When no plugin contributes, the section renders '' (no stray
 * header). CC-flavor plugins contribute no rules entries, so the section stays
 * empty for them.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RuleEntry, RulesSeam } from '@dsh-cc/plugin-loader'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The plugin rules seam, when cc-shell-glue is composed. */
    rules?: RulesSeam
  }
}

/** Name of the system-prompt section this bridge owns. */
export const RULES_SECTION_NAME = 'cc:plugin-rules'

/** Prompt order of the rules section (after serena-first's 105). */
export const RULES_SECTION_ORDER = 106

/**
 * Per-plugin rendered-rules cap in characters (§7 prompt-budget guard). A
 * plugin whose rendered contribution exceeds this is truncated with an
 * explicit tail; fixed and documented rather than configurable.
 */
export const RULES_BUDGET_CAP_CHARS = 4000

/** Explicit tail appended to a truncated plugin contribution. */
const TRUNCATION_TAIL = '\n... (truncated)'

/** The warning text shape shared by the generic-guidance and budget warnings. */
function warnOnce(ctx: Context, warned: Set<string>, key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  ctx.logger.warn(`cc-shell-glue: ${message}`)
}

/** Render one plugin's entries into its section block (uncapped). */
function renderPlugin(name: string, list: readonly RuleEntry[]): string {
  const lines: string[] = [`### Rules from plugin ${name}`]
  const always = list.filter(e => e.alwaysApply)
  const scoped = list.filter(e => !e.alwaysApply && e.globs.length > 0)
  const generic = list.filter(e => !e.alwaysApply && e.globs.length === 0)
  for (const e of always) lines.push('', e.body.trim())
  if (generic.length > 0) {
    lines.push('', 'The rules below carry no activation scope (no globs, alwaysApply false); treat them as general guidance for this plugin\'s domain.')
  }
  for (const e of generic) lines.push('', e.body.trim())
  for (const e of scoped) lines.push('', `When editing files matching \`${e.globs.join(', ')}\`:\n${e.body.trim()}`)
  return lines.join('\n')
}

/** The shape `createPluginRulesSeam` returns: the seam plus its section text. */
export interface PluginRulesSeam {
  /** The loader guest seam. */
  seam: RulesSeam
  /** Render the whole section ('' when no plugin contributes). */
  sectionText(): string
}

/** Create the plugin rules seam host. */
export function createPluginRulesSeam(
  ctx: Context,
  opts: { capChars?: number } = {},
): PluginRulesSeam {
  const cap = opts.capChars ?? RULES_BUDGET_CAP_CHARS
  // Copy-on-write store: pluginName → its entries. merge REPLACES the
  // plugin's slot; the disposer removes exactly that slot, so concurrent
  // plugins never see each other's contributions disappear.
  const entries = new Map<string, readonly RuleEntry[]>()
  const warned = new Set<string>()

  const renderOne = (name: string): string => {
    const list = entries.get(name)
    if (list === undefined || list.length === 0) return ''
    let text = renderPlugin(name, list)
    if (text.length > cap) {
      text = text.slice(0, Math.max(0, cap - TRUNCATION_TAIL.length)) + TRUNCATION_TAIL
      warnOnce(ctx, warned, `budget:${name}`, `plugin "${name}" rules contribution exceeds the ${cap}-character prompt budget; truncated`)
    }
    return text
  }

  const seam: RulesSeam = {
    mergePluginRules(pluginName: string, incoming: readonly RuleEntry[]): () => void {
      if (incoming.some(e => !e.alwaysApply && e.globs.length === 0)) {
        warnOnce(
          ctx,
          warned,
          `scopeless:${pluginName}`,
          `plugin "${pluginName}" has rules without an activation scope (no globs, alwaysApply false); they are surfaced as general prompt guidance`,
        )
      }
      const stored = [...incoming]
      entries.set(pluginName, stored)
      return () => {
        // Remove exactly OUR slot; a stale disposer after a re-merge must
        // not delete the newer contribution.
        if (entries.get(pluginName) === stored) entries.delete(pluginName)
      }
    },
  }

  return { seam, sectionText: () => [...entries.keys()].map(renderOne).filter(t => t !== '').join('\n\n') }
}
