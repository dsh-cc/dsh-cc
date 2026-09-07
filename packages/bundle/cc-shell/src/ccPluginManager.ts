/**
 * Claude Code plugin-state manager service for the cc-shell glue plugin.
 *
 * Wraps the pure `@dsh-cc/plugin-manager` core (install/uninstall/enable/
 * disable/update + marketplaces, all byte-shape parity with the real CLI)
 * bound to the session's Claude home and cwd, and publishes it as the
 * `ccPluginManager` service so slash commands (`/plugin` subcommands) can
 * consume it structurally. State mutations land in the same on-disk files
 * the loader's discovery reads, so a `ccPlugins.rescan()` after any mutation
 * reflects the change live.
 *
 * Publication follows the same host-realm pattern as `CcPluginsService`: the
 * instance is provided from the ROOT fiber via `ctx.root.provide`, making it
 * resolvable by every context (`ctx.get` and property access alike); an
 * effect on the glue fiber clears the publication when cc-shell-glue unloads.
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import { createCcPluginManager, createSystemGitRunner, type CcPluginManager } from '@dsh-cc/plugin-manager'
import { resolveClaudeHome } from '@dsh-cc/plugin-loader'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Claude Code plugin-state manager, when cc-shell-glue is composed. */
    ccPluginManager: CcPluginManager | undefined
  }
}

/**
 * Build the session-bound manager: `$CLAUDE_CONFIG_DIR` / `~/.claude` state
 * root, the session cwd (the same `process.cwd()` source `CcPluginsService`
 * uses for project/local `enabledPlugins` scope resolution), and the host
 * git runner for marketplace clones/updates.
 */
export function createSessionCcPluginManager(): CcPluginManager {
  return createCcPluginManager({
    claudeHome: resolveClaudeHome(),
    cwd: process.cwd(),
    runGit: createSystemGitRunner(),
  })
}

/**
 * Publish the `ccPluginManager` service from the root realm (see the
 * `CcPluginsService` publication notes in `ccPlugins.ts` for why).
 */
export class CcPluginManagerService {
  constructor(ctx: Context) {
    const value = createSessionCcPluginManager()
    const root = ctx.root
    const rootKey = root[Context.isolate]['ccPluginManager']
    const existing = rootKey === undefined ? undefined : root.reflect.store[rootKey]
    if (existing === undefined) {
      root.provide('ccPluginManager', value)
    } else {
      root.set('ccPluginManager', value)
    }
    ctx.fiber.effect(() => () => {
      if (root.get('ccPluginManager', false) === value) root.set('ccPluginManager', undefined)
    }, 'ccPluginManager: clear host-realm publication on unload')
  }
}
