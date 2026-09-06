/**
 * `plugins` checks for `/doctor`: per-plugin component load results,
 * duck-typing the `ccPlugins` seam (same spirit as `/plugin`).
 * @module @dsh-cc/command-doctor/checks/plugins
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Check } from '../report.ts'

/** Duck-typed `ccPlugins` component face used here. */
export interface PluginComponent {
  readonly kind: string
  readonly loaded: number
  readonly skipped: number
  readonly failed: number
  readonly reasons?: readonly string[]
}

/** Duck-typed `ccPlugins` entry face used here. */
export interface PluginEntry {
  readonly name: string
  readonly root: string
  readonly components: readonly PluginComponent[]
}

/** Collect the plugins group checks. */
export function pluginChecks(ctx: Context): Check[] {
  const plugins = ctx.get('ccPlugins') as
    | { list?(): PluginEntry[] }
    | undefined
  if (plugins?.list === undefined) {
    return [{
      id: 'plugins.registry',
      group: 'plugins',
      status: 'skip',
      summary: 'cc-shell-glue absent',
    }]
  }
  const entries = plugins.list()
  const checks: Check[] = [{
    id: 'plugins.overview',
    group: 'plugins',
    status: 'ok',
    summary: `${entries.length} plugins`,
    evidence: { count: entries.length },
  }]
  for (const entry of entries) checks.push(entryCheck(entry))
  return checks
}

/** One plugin row: warn when any component skipped or failed. */
function entryCheck(entry: PluginEntry): Check {
  const id = `plugins.${entry.name}`
  const bad = entry.components.filter(component => component.skipped > 0 || component.failed > 0)
  if (bad.length === 0) {
    return {
      id,
      group: 'plugins',
      status: 'ok',
      summary: `${entry.name}: all components loaded`,
      evidence: { root: entry.root },
    }
  }
  const reasons = bad.flatMap(component => component.reasons ?? [])
  return {
    id,
    group: 'plugins',
    status: 'warn',
    summary: `${entry.name}: ${bad.length} component kind(s) with skipped/failed entries`,
    detail: bad
      .map(component => `${component.kind}: skipped ${component.skipped}, failed ${component.failed}`)
      .join('; '),
    fix: reasons.length === 0 ? undefined : `review reasons: ${reasons.join('; ')}`,
    evidence: { root: entry.root, skipped: bad.reduce((total, c) => total + c.skipped, 0) },
  }
}
