/**
 * Live wiring (design doc §4.1–§4.4): the `tools/post-execute` listener that
 * pulls serena diagnostics for the touched file after an accepted edit/write/
 * NotebookEdit and appends the `[lsp]` block. Fail-soft all the way — any
 * failure degrades to a drop (debug counter) and returns the downstream
 * decision unchanged, never throwing into the waterfall.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { McpConnectionsService } from '@dsh-cc/mcp-client'
import { getSessionCwd } from '@dsh-cc/session-cwd'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@dsh-cc/tools'
import { composeLspBlock } from './compose.ts'
import { matchTool } from './match.ts'
import { pullDiagnostics, renderDiagnosticsBlock } from './diagnostics.ts'
import { readUserSettings } from './settings.ts'

/** Consecutive dropped calls after which the listener auto-disables for the session (doc §4.3). */
export const BREAKER_THRESHOLD = 3

/**
 * Register the post-execute listener. No `prepend`: it composes inside the
 * context-crusher's outermost post-execute listener (doc §4.1).
 * @param ctx - the plug context.
 */
export function registerListener(ctx: Context): void {
  // Closure-scoped breaker keyed by serverName (doc §4.3): watches the MCP
  // connection (serena's internal LSP servers are invisible to us).
  const dropsByServer = new Map<string, number>()
  let disabled = false
  // Lazy warn-once (doc §4.6): there is no session-start hook at this seam.
  let warnedServerMissing = false

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const downstream = await next()
    try {
    if (disabled) return downstream
    return await appendDiagnostics(ctx, exec, result, downstream)
    } catch (error: unknown) {
      // Fail-soft invariant of the seam (CCR precedent): a throw here would
      // turn the user's tool result into an error result (data loss).
      ctx.logger.warn(`lsp-on-write: degraded to passthrough: ${String(error)}`)
      return downstream
    }
  })

  async function appendDiagnostics(
    ctx: Context,
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    downstream: PostToolDecision,
  ): Promise<PostToolDecision> {
    // Raw user-layer read per event (doc §4.6): cheap, hot-reload, project scope invisible.
    const dshHome = dshHomeOf(ctx)
    if (dshHome === undefined) return downstream
    const settings = await readUserSettings(dshHome)
    if (!settings.enabled) return downstream
    const filePath = matchTool(exec, settings.toolNames)
    if (filePath === undefined) return downstream
    // Value-accept guard (doc §4.5): the runtime throws on content+value.
    if (downstream.kind !== 'accept' || downstream.value !== undefined) return downstream
    if (exec.agent === undefined) return downstream // no session cwd → drop silently
    const sessionCwd = getSessionCwd(exec.agent)
    const registry = ctx.get('mcpConnections') as McpConnectionsService | undefined
    if (registry === undefined || registry.callTool === undefined) {
      warnServerMissingOnce(ctx, settings.serverName)
      return downstream
    }
    // Server-missing is warn-once, NOT a drop (doc §4.6): a permanently
    // absent mount must not charge the crash-loop breaker.
    if (!registry.entries().some((entry) => entry.name === settings.serverName)) {
      warnServerMissingOnce(ctx, settings.serverName)
      return downstream
    }
    let pulled
    try {
      pulled = await pullDiagnostics(
        registry,
        settings.serverName,
        filePath,
        sessionCwd,
        settings,
        // Effective budget: caller signal ∧ per-call timeout (doc §4.3).
        AbortSignal.any([exec.signal, AbortSignal.timeout(settings.timeoutMs)]),
      )
    } catch (error: unknown) {
      const count = (dropsByServer.get(settings.serverName) ?? 0) + 1
      dropsByServer.set(settings.serverName, count)
      ctx.logger.debug(`lsp-on-write: diagnostics call dropped (${count} consecutive for ${settings.serverName}): ${String(error)}`)
      if (count >= BREAKER_THRESHOLD) {
        disabled = true
        ctx.logger.debug(`lsp-on-write: ${settings.serverName} dropped ${BREAKER_THRESHOLD} consecutive diagnostics calls — disabled for the rest of the session`)
      }
      return downstream
    }
    dropsByServer.delete(settings.serverName)
    const text = renderDiagnosticsBlock(pulled, settings)
    if (text === undefined) return downstream
    return composeLspBlock(downstream, result, { type: 'text', text })
  }

  function warnServerMissingOnce(ctx: Context, serverName: string): void {
    if (warnedServerMissing) return
    warnedServerMissing = true
    ctx.logger.warn(`lsp-on-write: no server named "${serverName}" registered — no diagnostics will be reported`)
  }
}

/** Guarded dshHome read (context-crusher index.ts pattern): cordis throws on the property access itself. */
function dshHomeOf(ctx: Context): string | undefined {
  try {
    return ctx.dshHomePath?.()
  } catch {
    return undefined
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver, provided by @deepseek-ai/dsh-app-boot at boot. Optional in tests. */
    dshHomePath?: (...segments: string[]) => string
  }
}
