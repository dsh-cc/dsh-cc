/**
 * Subagent handoff store: the `handoff_put` / `handoff_get` tool pair plus a
 * disk-based content-addressed store under `$DSH_HOME/handoff/<projectKey>/`.
 *
 * A sandboxed or read-only subagent (e.g. critic, no Write) cannot put a long
 * report in a repo file; the parent's only channel back would otherwise be
 * the full final-message text. handoff_put parks the artifact and returns a
 * short summary embedding `handoff://<id>`; the orchestrator or a follow-up
 * child resolves it with handoff_get. Cross-session and cross-project
 * transfer follow the CCR precedent: the project bucket is keyed by the
 * session cwd, so fetches only resolve within the SAME working directory
 * (two git worktrees of one repo are different projects — caveat documented
 * in the package README).
 *
 * Plain cordis plugin (publishes no Service — mirror of @dsh-cc/memory): it
 * no-ops when the tools service, fs seam, or dshHomePath is absent. State is
 * entirely on disk (TTL 24 h + 500-entry disk-based LRU swept on put), so
 * spawned children in separate processes see the same store.
 *
 * @module @dsh-cc/handoff-store
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HandoffLedger } from './ledger.ts'
import { registerSettings } from './settings.ts'
import { HandoffStore } from './store.ts'
import { defineHandoffGetTool, defineHandoffPutTool, type HandoffDeps } from './tools.ts'

export { HandoffStore, MAX_ENTRIES, TTL_MS, projectKeyOf } from './store.ts'
export { HandoffLedger } from './ledger.ts'
export { registerSettings, SETTINGS_NAMESPACE, SettingsSchema, DEFAULTS, resolveHandoffConfig } from './settings.ts'
export {
  defineHandoffPutTool,
  defineHandoffGetTool,
  HANDOFF_PUT_TOOL,
  HANDOFF_GET_TOOL,
  THRESHOLD_NOTE,
  HandoffToolError,
  applyMaxChars,
  cwdProjectKey,
} from './tools.ts'
export type { HandoffDeps } from './tools.ts'
export type { HandoffConfig, HandoffError, HandoffLedgerRow, HandoffMeta } from './types.ts'

/** dshHomePath seam, read defensively (a providerless host must not crash the plugin). */
type HomeFn = (...segments: string[]) => string

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver, provided by @deepseek-ai/dsh-app-boot at boot. Optional in tests. */
    dshHomePath?: (...segments: string[]) => string
  }
}

function dshHomeFn(ctx: Context): HomeFn | undefined {
  try {
    return ctx.dshHomePath
  } catch {
    return undefined
  }
}

function sessionIdOf(agent?: Agent): string {
  return agent === undefined ? '' : String(agent.session.id)
}

/**
 * Mount the handoff tools. No-op when the host has no tools service, no fs
 * seam, or no dshHomePath (a providerless host keeps no handoff surface).
 * @param ctx - the plug context.
 * @returns the tools-registration disposer, or `undefined` when not registered.
 */
export function apply(ctx: Context): (() => void) | undefined {
  const tools = ctx.get('tools') as { register(def: unknown): () => void } | undefined
  const fs = ctx.get('fs')
  const home = dshHomeFn(ctx)
  if (tools === undefined || fs === undefined || home === undefined) return undefined

  const store = new HandoffStore(home('handoff'))
  const ledger = new HandoffLedger(home('handoff', 'ledger.jsonl'))
  const readSettings = registerSettings(ctx)
  const deps: HandoffDeps = {
    store,
    ledger,
    readSettings,
    sessionIdOf,
  }
  const offPut = tools.register(defineHandoffPutTool(deps))
  const offGet = tools.register(defineHandoffGetTool(deps))
  return () => {
    offPut()
    offGet()
  }
}

/** Cordis plugin id. */
export const name = 'cc-handoff'
