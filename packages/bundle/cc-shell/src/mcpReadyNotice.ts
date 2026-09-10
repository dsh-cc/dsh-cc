/**
 * MCP settle notice (follow-up to the section-3 "still connecting" one-shot
 * in the cc-shell glue): the initial notice claims tools "become available
 * once ready" but `McpConnectionsService.report()` used to mutate state
 * silently, so that claim went stale forever. This module mounts an
 * `agent/pre-step` listener that appends ONE settle-summary user message once
 * every announced deferred server has stopped handshaking — delivered by
 * REWRITING the enter decision's message batch (never `agent.inject()`: a
 * durable pending-inbox message re-opens turns when idle, the PR #31
 * phantom-wake bug). Text is built lazily at delivery time: `report('ready')`
 * fires before `setToolCount`, so a latch-time text would drop tool counts.
 *
 * @module cc-shell-glue/mcp-ready-notice
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { McpConnectionEntry } from '@dsh-cc/mcp-client'

/** The minimal registry surface this module needs (structural duck type). */
interface Registry {
  entries(): McpConnectionEntry[]
  onDidChange(listener: (entry: McpConnectionEntry) => void): () => void
}

/**
 * Build the settle summary line for the announced servers. For each announced
 * name the latest entry decides the wording: ready names the tool count when
 * known, error names the message, anything else (or a vanished server) names
 * the state (`gone` when unregistered).
 */
export function buildSettleText(entries: readonly McpConnectionEntry[], announced: readonly string[]): string {
  const describe = (name: string): string => {
    const entry = entries.find(candidate => candidate.name === name)
    if (entry === undefined) return `${name} (gone)`
    if (entry.state === 'ready') return entry.toolCount === undefined ? name : `${name} (${entry.toolCount} tools)`
    if (entry.state === 'error') return `${name} (error: ${entry.error ?? 'unknown'})`
    return `${name} (${entry.state})`
  }
  const descriptions = announced.map(describe)
  const ready = announced.filter(name => entries.find(candidate => candidate.name === name)?.state === 'ready')
  if (ready.length === announced.length) {
    return `MCP: servers ready — ${descriptions.join(', ')}. Load their mcp__* tools via ToolSearch.`
  }
  if (ready.length === 0) {
    return `MCP: servers unavailable — ${descriptions.join(', ')}. Retry with /mcp reconnect ${announced.join(' ')}.`
  }
  const notReady = announced.filter(name => !ready.includes(name)).map(describe)
  return `MCP: servers settled — ready: ${ready.map(describe).join(', ')}; unavailable/active: ${notReady.join(', ')}. Ready servers' mcp__* tools are loadable via ToolSearch.`
}

/**
 * Mount the settle-notice follow-up: subscribe to registry changes, latch
 * when no announced server is still `connecting`, then append the settle
 * text on the first matching `enter` pre-step and dispose both listeners.
 * @param ctx - the plug context (only `ctx.on` is used).
 * @param registry - the MCP connection registry.
 * @param announced - the deferred server names announced as "still connecting".
 * @param sid - only deliver to the agent with this session id (when known).
 */
export function mountMcpReadyNotice(
  ctx: Context,
  registry: Registry,
  announced: readonly string[],
  sid?: string,
): void {
  let delivered = false
  /** Announced names still handshaking right now. */
  const stillPending = (): string[] =>
    announced.filter((name) => {
      const entry = registry.entries().find(candidate => candidate.name === name)
      return entry !== undefined && entry.state === 'connecting'
    })
  // Event-armed latch: re-derived from live entries on every registry change
  // (register/report/unregister), so a re-entered 'connecting' un-latches and
  // a vanished server counts as settled. Init covers events fired before this
  // subscription (a settle between the announce snapshot and this mount).
  let latched = stillPending().length === 0
  const unsubscribe = registry.onDidChange(() => { latched = stillPending().length === 0 })

  const disposeStep = ctx.on('agent/pre-step', async (payload: {
    agent?: { session?: { id?: unknown } }
  }, next): Promise<PreStepDecision> => {
    const decision = await next()
    try {
      if (!latched || delivered || decision.kind !== 'enter') return decision
      if (sid !== undefined) {
        const payloadSid = (payload.agent as { session?: { id?: unknown } } | undefined)?.session?.id
        if (payloadSid !== sid) return decision
      }
      // Race guard: the latch is event-armed; re-check at delivery so a state
      // change between the last event and this step can never mislabel text.
      if (stillPending().length > 0) return decision
      // Text is built NOW (not at latch): report('ready') fires before
      // setToolCount, so only delivery-time reads see tool counts.
      const text = buildSettleText(registry.entries(), announced)
      delivered = true
      unsubscribe()
      disposeStep()
      return {
        ...decision,
        messages: [...decision.messages, createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'cc-shell-glue', form: 'notice', summary: text },
        })],
      }
    } catch {
      // Absent llm seam or decision surface: skip quietly.
    }
    return decision
  })
}
