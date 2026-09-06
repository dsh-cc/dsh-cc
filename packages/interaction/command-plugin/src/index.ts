/**
 * Human-facing `/plugin` and `/reload-plugins` commands: list the mounted
 * Claude Code plugins and rescan the on-disk discovery roots. Both read the
 * optional `ccPlugins` service mounted by cc-shell-glue; when that service is
 * absent (a composition without the glue) they report the seam gracefully
 * rather than failing.
 * @module @dsh-cc/command-plugin
 */

import { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import {
  formatPluginList,
  formatReloadSummary,
  type CcPluginSummary,
  type CcPluginRescanError,
} from './plugin.ts'

export const name = 'command-plugin'
export const inject = ['commands']

/**
 * The minimal structural face of the optional `ccPlugins` service that
 * `command-status`'s host composition provides. Kept local and structural so
 * this package need not depend on the cc-shell bundle's full dependency graph.
 */
export interface CcPluginsSeam {
  /** Enumerate the currently mounted plugins. */
  list(): CcPluginSummary[]
  /** Dispose and remount every discovery root; returns per-root failures. */
  rescan(): Promise<CcPluginRescanError[]>
}

/** Resolve the optional ccPlugins seam, or undefined when not composed. */
function seam(ctx: Context): CcPluginsSeam | undefined {
  return ctx.get('ccPlugins') as CcPluginsSeam | undefined
}/** Execute `/plugin`: list the mounted CC plugins. */
async function executePlugin(ctx: Context, _invocation: CommandInvocation): Promise<CommandResult> {
  const plugins = seam(ctx)
  if (plugins === undefined) {
    return { kind: 'success', text: 'No plugin registry is mounted in this composition (cc-shell-glue absent).' }
  }
  return { kind: 'success', text: formatPluginList(plugins.list()) }
}

/** Execute `/reload-plugins`: dispose and remount every discovery root. */
async function executeReload(ctx: Context, _invocation: CommandInvocation): Promise<CommandResult> {
  const plugins = seam(ctx)
  if (plugins === undefined) {
    return { kind: 'success', text: 'No plugin registry is mounted in this composition (cc-shell-glue absent).' }
  }
  const errors = await plugins.rescan()
  return { kind: 'success', text: formatReloadSummary(plugins.list(), errors) }
}

/**
 * Register the `/plugin` and `/reload-plugins` commands for every composed
 * command adapter.
 * @param ctx - context carrying the command registry.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'plugin',
    description: 'list mounted Claude Code plugins (name, root, component counts)',
    handler: (invocation: CommandInvocation) => executePlugin(ctx, invocation),
  })
  ctx.commands.register({
    name: 'reload-plugins',
    description: 'dispose and remount all Claude Code plugin discovery roots',
    handler: (invocation: CommandInvocation) => executeReload(ctx, invocation),
  })
}
