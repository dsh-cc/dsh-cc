/**
 * Glue plugin for the cc-shell bundle: mounts the things cordis patch rows
 * cannot express statically — Claude Code plugin directories on disk and MCP
 * server configs from `.mcp.json`. Base CC-agent discovery moved to the
 * subagent/task package (per-workspace), and the `model-aliases` namespace is
 * owned by the `@dsh-cc/model-aliases` routes service. Discovery is
 * best-effort: every absent path simply mounts nothing.
 *
 * MCP config discovery is source-separated: dsh-native config
 * (`<cwd>/.mcp.json` and `$DSH_HOME/.mcp.json`) takes precedence — when a
 * dsh-native file declares at least one server, the Claude Code files
 * (`$CLAUDE_CONFIG_DIR/.mcp.json` / `~/.claude/.mcp.json` and
 * `~/.claude.json`) are NOT loaded, and a notice points at `/mcp migrate`
 * (which imports them into `$DSH_HOME/.mcp.json`; a session restart makes the
 * import effective). The `mcpLoadClaudeFiles: true` knob restores the old
 * all-merge behavior, and an explicit `mcpConfigFiles` list is always honored
 * verbatim with no gating and no notice.
 *
 * @module @dsh-cc/bundle-shell
 */

import { existsSync, readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ModelRoutes } from '@dsh-cc/model-aliases'
import {
  buildRegistrations,
  claudeOnlyServers,
  readMcpServerNames,
  resolveDefaultMcpPaths,
  type ClaudeOnlySource,
  type McpConfigFile,
  type ResolvedMcpPaths,
} from '@dsh-cc/mcp-config'
import * as CcMcpClient from '@dsh-cc/mcp-client'
import { CcPluginsService } from './ccPlugins.ts'

/** Plugin config: which on-disk CC surfaces to mount. */
export interface Config {
  /**
   * Directories that each carry a plugin.json (or `.claude-plugin/plugin.json`).
   * Absent → installed ∩ enabled under `$CLAUDE_CONFIG_DIR` / `~/.claude`;
   * explicit [] or null disables.
   */
  pluginDirs?: string[] | null
  /** `.mcp.json` documents whose accepted servers become mcp-client instances. Absent → discovery defaults; explicit [] or null disables. */
  mcpConfigFiles?: string[] | null
  /**
   * Restore the old all-merge MCP discovery: `true` loads the dsh files AND
   * the Claude Code files together with no gating and no notice. Absent,
   * `null`, or `false` keeps the new gated discovery — dsh-native config
   * declaring ≥ 1 server takes precedence and Claude Code files are skipped
   * with a notice pointing at `/mcp migrate`. Ignored when `mcpConfigFiles`
   * is set explicitly.
   */
  mcpLoadClaudeFiles?: boolean | null
}

/** Runtime config schema (all fields optional; discovery prefers explicit lists). */
export const Config: z<Config> = z.object({
  // union with null: bare z.array() gets an implicit [] default from schemastery,
  // which would defeat the absent → discovery-fallback semantics below.
  pluginDirs: z.union([z.array(z.string()), z.const(null)]),
  mcpConfigFiles: z.union([z.array(z.string()), z.const(null)]),
  mcpLoadClaudeFiles: z.union([z.boolean(), z.const(null)]),
})

/** Cordis plugin id. */
export const name = 'cc-shell-glue'

/**
 * Mount the discovered CC surfaces. Each piece is effect-scoped where the
 * underlying loader supports it.
 * @param ctx - the plug context.
 * @param config - discovery configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const results: string[] = []

  // The registry must outlive any single mcp-client instance: when an instance with
  // failOnStartupError fails at startup, cordis rolls that fiber back and would
  // dispose a lazily instance-provided registry with it. Provide it from a dedicated
  // child fiber that is ACTIVE before any instance mounts (a direct
  // `new McpConnectionsService(ctx)` here would stay invisible: this fiber is LOADING
  // and ctx.get is strict).
  if (ctx.get('mcpConnections') === undefined) {
    await ctx.plugin({
      name: 'cc-mcp-connections',
      apply(c: Context) {
        new CcMcpClient.McpConnectionsService(c)
      },
    })
  }

  // The spawn-time model resolver is provided by the `@dsh-cc/model-aliases`
  // routes service (`ccModelRoutes`). Query it lazily on every spawn so mount
  // order doesn't matter and an unmounted routes service degrades to inherit.
  const resolveModel = (model: string | undefined) =>
    (ctx.get('ccModelRoutes') as ModelRoutes | undefined)?.resolve(model)

  // 1. Claude Code plugins. Absent pluginDirs uses installed ∩ enabled;
  //    explicit []/null disables; a non-empty list flattens those dirs.
  const plugins = new CcPluginsService(ctx, {
    ...config.pluginDirs !== undefined ? { pluginDirs: config.pluginDirs } : {},
    resolveModel,
  })
  await plugins.mountAll()
  for (const summary of plugins.list()) {
    const tallies = summary.components
    const loaded = tallies.reduce((n, c) => n + c.loaded, 0)
    const skipped = tallies.reduce((n, c) => n + c.skipped, 0)
    results.push(`cc-plugin ${summary.name}: ${loaded} loaded/${skipped} skipped`)
  }

  // 2. `.mcp.json` documents → per-server @dsh-cc/mcp-client instances.
  //    An explicit `mcpConfigFiles` list is honored verbatim — no gating, no
  //    notice. Discovery mode resolves the default paths and gates the Claude
  //    Code files behind a non-empty dsh-native config (≥ 1 declared server):
  //    the dsh config then takes sole effect and skipped Claude Code servers
  //    surface as a notice pointing at `/mcp migrate`.
  //
  //    Mounts are deferred (`deferStartupConnect`): each plugin instance
  //    activates without awaiting its MCP handshake, so the first frame is
  //    not blocked on spawned servers; the handshakes still overlap because
  //    the serial mounts each spawn their child synchronously.
  const deferredNames: string[] = []
  let files: string[]
  let gatedPaths: ResolvedMcpPaths | undefined
  let noticeSources: ClaudeOnlySource[] = []
  if (config.mcpConfigFiles !== undefined) {
    // Explicit list honored verbatim; []/null disables MCP config mounts.
    files = config.mcpConfigFiles ?? []
  } else {
    const paths = resolveDefaultMcpPaths()
    let dshServerCount = 0
    for (const file of paths.dsh) {
      const names = readMcpServerNames(file)
      if (names.kind === 'ok') dshServerCount += names.names.length
    }
    const gated = dshServerCount > 0 && config.mcpLoadClaudeFiles !== true
    files = gated ? paths.dsh : [...paths.dsh, ...paths.claude]
    if (gated) {
      noticeSources = claudeOnlyServers(paths)
      if (noticeSources.length > 0) gatedPaths = paths
    }
  }

  for (const file of files) {
    if (!existsSync(file)) continue
    try {
      const body = JSON.parse(readFileSync(file, 'utf8')) as McpConfigFile
      const registrations = buildRegistrations(body, { env: process.env, deferStartupConnect: true })
      for (const server of registrations) {
        try {
          await ctx.plugin(CcMcpClient, server)
          deferredNames.push(server.serverName)
          results.push(`mcp server ${server.serverName} mounted from ${file}`)
        } catch (error) {
          ctx.logger.warn(`cc-shell-glue: failed to mount MCP server ${server.serverName} from ${file}: ${String(error)}`)
        }
      }
    } catch (error) {
      ctx.logger.warn(`cc-shell-glue: failed to mount MCP config ${file}: ${String(error)}`)
    }
  }

  // 3. Deferred-connect visibility window: prompts submitted while a deferred
  //    server is still handshaking cannot see its `mcp__*` tools. When any
  //    deferred server was mounted, register a one-shot `agent/session-start`
  //    hook (same pattern as the gating notice below) that lists the servers
  //    still `connecting` at that moment. The pending set is evaluated at fire
  //    time — fast handshakes settle right after the mount loop, so a boot
  //    where everything is ready by the first prompt injects nothing.
  if (deferredNames.length > 0) {
    let fired = false
    ctx.on('agent/session-start', ({ agent }: { agent: { inject(message: unknown): void } }) => {
      // One shot per process, consumed even when suppressed.
      if (fired) return
      fired = true
      const registry = ctx.get('mcpConnections') as CcMcpClient.McpConnectionsService | undefined
      const pending = registry === undefined
        ? []
        : registry.entries()
          .filter(entry => deferredNames.includes(entry.name) && entry.state === 'connecting')
          .map(entry => entry.name)
      if (pending.length === 0) return
      const text = `MCP: still connecting — ${pending.join(', ')}. Tools from these servers become available once ready.`
      agent.inject(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'cc-shell-glue', form: 'notice', summary: text } }))
    })
  }

  // 4. Gating notice: warn immediately, then inject once on the first
  //    `agent/session-start` (the TUI cannot see logger.warn). The closure
  //    flag makes it fire exactly once per process even when subagent/resume
  //    fan-out re-emits the event.
  if (gatedPaths !== undefined && noticeSources.length > 0) {
    const skipped = noticeSources.map(source => `${source.path} (${source.names.length} servers)`).join(', ')
    const text = `MCP: dsh config takes precedence — skipped Claude Code MCP config: ${skipped}. Run /mcp migrate to import them into ${gatedPaths.target}, then restart the session.`
    ctx.logger.warn(`cc-shell-glue: ${text}`)
    let fired = false
    ctx.on('agent/session-start', ({ agent }: { agent: { inject(message: unknown): void } }) => {
      if (fired) return
      fired = true
      agent.inject(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'cc-shell-glue', form: 'notice', summary: text } }))
    })
  }

  if (results.length > 0) ctx.logger.info(`cc-shell-glue: mounted — ${results.join('; ')}`)
}
