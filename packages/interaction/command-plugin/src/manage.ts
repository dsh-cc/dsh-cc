/**
 * Handlers for the `/plugin` management subcommands. Seams are resolved
 * structurally by the caller (`index.ts`) and passed in: the optional
 * `ccPlugins` registry (mounted view + live rescan) and the optional
 * `ccPluginManager` service (state mutations, mounted by cc-shell-glue).
 * When the manager seam is absent the handlers degrade to the repo's
 * graceful sentence pattern; a core `PluginManagerError` (duck-typed by
 * its `name` so this package stays dependency-light) renders as a one-line
 * text result — its message, no stack.
 *
 * @module @dsh-cc/command-plugin/manage
 */

import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { parsePluginArgv, type ParsedPluginCommand } from './subcommands.ts'
import {
  formatInstallResult,
  formatInstalledList,
  formatMarketplaceAdded,
  formatMarketplaceList,
  formatMarketplaceRemoved,
  formatMarketplacesUpdated,
  formatPluginHelp,
  formatToggleResult,
  formatUninstallResult,
  formatUpdateResult,
  MANAGE_FOOTER,
  TRUST_WARNING,
  type InstalledPluginRow,
  type MarketplaceListRow,
} from './render-manage.ts'
import { formatPluginList } from './plugin.ts'
import type { CcPluginsSeam } from './index.ts'

/**
 * The minimal structural face of the `ccPluginManager` service (cc-shell's
 * `@dsh-cc/plugin-manager` binding). Kept local and structural so this
 * package need not depend on the manager package.
 */
export interface CcPluginManagerSeam {
  list(opts?: { enabled?: boolean, disabled?: boolean }): Promise<InstalledPluginRow[]>
  enable(arg: string, opts?: { scope?: string }): Promise<{ id: string, scope: string }>
  disable(arg: string, opts?: { scope?: string }): Promise<{ id: string, scope: string }>
  install(arg: string, opts?: { scope?: string }): Promise<{ id: string, version: string, scope: string }>
  uninstall(arg: string, opts?: { scope?: string }): Promise<{ id: string, scope: string }>
  update(arg: string, opts?: { scope?: string }): Promise<
    | { upToDate: true, id: string, version: string, scope: string }
    | { upToDate: false, id: string, fromVersion: string, toVersion: string, scope: string }>
  listMarketplaces(): Promise<MarketplaceListRow[]>
  addMarketplace(source: string, opts?: { scope?: string }): Promise<{ name: string, sourceKind: string }>
  removeMarketplace(name: string): Promise<{ name: string, removedPlugins: string[] }>
  updateMarketplaces(name?: string): Promise<string[]>
}

/** Seams handed to the manage handlers by `index.ts` (both optional). */
export interface ManageHandlerDeps {
  ctx: unknown
  ccPlugins?: CcPluginsSeam | undefined
  ccPluginManager?: CcPluginManagerSeam | undefined
}

const MANAGER_ABSENT = 'No plugin manager is mounted in this composition (cc-shell-glue absent).'

/** Core errors carry `name === 'PluginManagerError'`; render their message verbatim. */
function isPluginManagerError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'PluginManagerError'
}

function text(message: string): CommandResult {
  return { kind: 'success', text: message }
}

function parseArgv(invocation: CommandInvocation): string[] {
  return invocation.rawInput.trim().split(/\s+/).filter((token: string) => token.length > 0)
}

/** `exactOptionalPropertyTypes`-safe scope options: omit the key entirely when unset. */
function scopeOpts(scope: string | undefined): { scope?: string } {
  return scope === undefined ? {} : { scope }
}

/** Rescan the mounted-plugin registry after a successful mutation (tolerates seam absence). */
async function rescan(ccPlugins: CcPluginsSeam | undefined): Promise<void> {
  await ccPlugins?.rescan()
}

async function runList(manager: CcPluginManagerSeam, command: ParsedPluginCommand): Promise<CommandResult> {
  const rows = await manager.list(
    command.filter === 'enabled' ? { enabled: true }
      : command.filter === 'disabled' ? { disabled: true }
        : undefined,
  )
  return text(formatInstalledList(rows))
}

async function runMarketplaceAdd(
  manager: CcPluginManagerSeam,
  command: ParsedPluginCommand,
  ccPlugins: CcPluginsSeam | undefined,
): Promise<CommandResult> {
  const result = await manager.addMarketplace(command.arg!, scopeOpts(command.scope))
  await rescan(ccPlugins)
  const added = formatMarketplaceAdded({ name: result.name, sourceKind: result.sourceKind, scope: command.scope ?? 'user' })
  if (result.sourceKind === 'directory') return text(added)
  return text(`${added}\n${TRUST_WARNING}`)
}

/** Execute a `/plugin` invocation that routed to the management surface. */
export async function executePluginManage(deps: ManageHandlerDeps, invocation: CommandInvocation): Promise<CommandResult> {
  const argv = parseArgv(invocation)
  const outcome = parsePluginArgv(argv)

  if (outcome.kind === 'mounted') {
    const ccPlugins = deps.ccPlugins
    if (ccPlugins === undefined) {
      return text('No plugin registry is mounted in this composition (cc-shell-glue absent).')
    }
    return text(`${formatPluginList(ccPlugins.list())}\n${MANAGE_FOOTER}`)
  }
  if (outcome.kind === 'help') return text(formatPluginHelp())
  if (outcome.kind === 'parse-error') return text(outcome.message)

  const manager = deps.ccPluginManager
  if (manager === undefined) return text(MANAGER_ABSENT)
  const command = outcome.command
  const ccPlugins = deps.ccPlugins

  try {
    switch (command.verb) {
      case 'list':
        return await runList(manager, command)
      case 'install': {
        const result = await manager.install(command.arg!, scopeOpts(command.scope))
        await rescan(ccPlugins)
        return text(`${formatInstallResult(result)}\n${TRUST_WARNING}`)
      }
      case 'uninstall': {
        const result = await manager.uninstall(command.arg!, scopeOpts(command.scope))
        await rescan(ccPlugins)
        return text(formatUninstallResult(result))
      }
      case 'enable': {
        const result = await manager.enable(command.arg!, scopeOpts(command.scope))
        await rescan(ccPlugins)
        return text(formatToggleResult('enable', result))
      }
      case 'disable': {
        const result = await manager.disable(command.arg!, scopeOpts(command.scope))
        await rescan(ccPlugins)
        return text(formatToggleResult('disable', result))
      }
      case 'update': {
        const result = await manager.update(command.arg!, scopeOpts(command.scope))
        await rescan(ccPlugins)
        return text(formatUpdateResult(result))
      }
      case 'marketplace-list':
        return text(formatMarketplaceList(await manager.listMarketplaces()))
      case 'marketplace-add':
        return await runMarketplaceAdd(manager, command, ccPlugins)
      case 'marketplace-remove': {
        const result = await manager.removeMarketplace(command.arg!)
        await rescan(ccPlugins)
        return text(formatMarketplaceRemoved(result))
      }
      case 'marketplace-update': {
        const names = await manager.updateMarketplaces(command.arg)
        await rescan(ccPlugins)
        return text(formatMarketplacesUpdated(names))
      }
    }
  } catch (error) {
    if (isPluginManagerError(error)) return text(error.message)
    throw error
  }
}
