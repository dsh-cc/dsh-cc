/**
 * Live session folds shared by the driver factory and its sections: the
 * effective permission mode (plan overlay, else the durable override) and the
 * LIVE session working directory (the session-cwd plugin's durable
 * `worktree/entered` fold, then the boot-time header cwd).
 *
 * @module @dsh-cc/tui/harness/driver-live
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { foldPlanMode } from '@deepseek-ai/dsh-plan-mode'
import { foldPermissionMode } from '@dsh-cc/permission-rules'
import { foldSessionCwd } from '@dsh-cc/session-cwd'

export function liveMode(agent: Agent, fallback: string): string {
  if (foldPlanMode(agent.session.events)) return 'plan'
  return foldPermissionMode(agent.session.events) ?? fallback
}

/** Duck-typed face of the host context carrying the permission-rules engine. */
type RulesHostCtx = { get(key: string): unknown }

/**
 * The LIVE merged settings `permissions.defaultMode` (the engine rebuilds it
 * on settings reload), falling back to the literal `'default'` when the
 * permission-rules engine is not mounted. Structural on purpose: the driver
 * must not depend on the engine's class shape.
 */
export function liveDefaultMode(ctx: RulesHostCtx): string {
  const rules = ctx.get('permissionRules') as { defaultMode?: string } | undefined
  return rules?.defaultMode ?? 'default'
}

/**
 * `liveMode` with the F1 fallback bound to the host context: sections call
 * `liveMode(agent)` and the fallback resolves to the permission-rules
 * engine's LIVE merged settings defaultMode (literal `'default'` when the
 * engine is not mounted). An explicit `fallback` still wins.
 */
export function liveModeWithDefault(
  ctx: RulesHostCtx,
): (agent: Agent, fallback?: string) => string {
  return (agent, fallback) => liveMode(agent, fallback ?? liveDefaultMode(ctx))
}

/**
 * The LIVE session working directory: the session-cwd plugin's durable
 * `worktree/entered` fold first (authoritative across EnterWorktree/
 * ExitWorktree moves), then the boot-time header cwd.
 */
export function liveSessionCwd(agent: Agent, fallback: string): string {
  return foldSessionCwd(agent.session.events) ?? agent.session.header.cwd ?? fallback
}
