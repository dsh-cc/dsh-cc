/**
 * Skill-usage telemetry (design docs/plans/2026-10-09-skill-lifecycle-usage-gates.md
 * §3.1/§3.2): an observe-only cordis plugin that counts every committed skill
 * load — the tool form at the `tools/result` emit seam, the slash form at
 * persisted `skill-invocation` user messages — into a per-workspace JSONL
 * sidecar ledger under `<dshHome>/skill-usage/`, stamping an
 * observation-start marker (create-if-absent). Nothing is appended to session
 * transcripts (§3.6).
 *
 * Plain plugin (not a Service): `apply(ctx)`, no isolate key. Every failure
 * is swallowed + debug-logged; listeners never throw into an emitter and no
 * waterfall is joined (`tools/result` only).
 *
 * @module @dsh-cc/skill-usage
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { cwdProjectKey } from '@dsh-cc/handoff-store'
import { getSessionCwdForSession } from '@dsh-cc/session-cwd'
import { dshHomeFn, projectKeyOf } from '@dsh-cc/sidecar-io'
import { commitLoad, debug } from './ledger.ts'
import { registerRollup } from './rollup.ts'
import { registerSettings } from './settings.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver (see @dsh-cc/sidecar-io). Optional in tests. */
    dshHomePath?: (...segments: string[]) => string
  }
}

/** Cordis plugin id. */
export const name = 'cc-skill-usage'

/**
 * Cordis lazy-injection declaration: the rollup slice resolves `ctx.skills`
 * from THIS plugin's context — without `inject: ['skills']`, cordis throws
 * "cannot get property 'skills' without inject" at resolve time (trap
 * precedent: advisor-watchdog `inject = ['llm']`). Declared up front even
 * though v1's listeners do not touch the catalog yet.
 */
export const inject = ['skills']

export {
  DEFAULT_SKILL_USAGE_SETTINGS,
  SETTINGS_NAMESPACE,
  SettingsSchema,
  registerSettings,
  readUserSettingsSync,
  type SkillUsageSettings,
} from './settings.ts'
export {
  commitLoad,
  createMarkerIfAbsent,
  ledgerPath,
  markerPath,
  type SkillLoadRow,
} from './ledger.ts'

/**
 * Mount the plugin: register the settings namespace and the two observe-only
 * listeners. Plain plugin — no Service, no isolate key.
 * @param ctx - the plug context.
 */
export function apply(ctx: Context): void {
  // /config UX + validation + rollup-time cascade knobs; the per-event gate
  // reads the raw user file instead (§3.5).
  const readSettings = registerSettings(ctx)
  registerListeners(ctx)
  registerRollup(ctx, readSettings)
}

/**
 * Register both listeners (§3.2). Observe-only; every failure contained.
 * @param ctx - the plug context.
 */
export function registerListeners(ctx: Context): void {
  // Tool form: a load counts only when the FINAL canonical outcome is success
  // (post-waterfall, post-cancellation; `tools/result` is an emit seam — no
  // waterfall participation, never `tools/post-execute`).
  ctx.on('tools/result', (exec, result) => {
    try {
      if (exec.name !== 'skill' || result.isError !== false) return
      const args = exec.arguments as { name?: unknown } | undefined
      const skill = typeof args?.name === 'string' ? args.name : undefined
      if (skill === undefined) {
        debug(ctx, 'skill-usage: skill tool result without a string name — row skipped')
        return
      }
      // Returns undefined for agent-less executions; unresolvable ⇒ skip (D-J).
      const projectKey = cwdProjectKey(exec.agent)
      if (projectKey === undefined) {
        debug(ctx, 'skill-usage: tool-form load without a resolvable project key — row skipped')
        return
      }
      const value = result.value as { provider?: unknown } | undefined
      const provider = typeof value?.provider === 'string' ? value.provider : undefined
      commit(ctx, projectKey, {
        sessionId: sessionIdOf(exec.agent),
        skill,
        via: 'tool',
        ...(provider !== undefined ? { provider } : {}),
      })
    } catch (error: unknown) {
      debug(ctx, `skill-usage: tool-form listener failed: ${String(error)}`)
    }
  })

  // Slash form: persisted injected instructions messages carry a
  // `skill-invocation` source. Gesture semantics live in tool-skill — this
  // listener never re-parses user text.
  ctx.on('session/event', (session, event) => {
    try {
      if (event.type !== 'user/message') return
      // The skill-invocation source is declared upstream; narrow defensively
      // so a widened payload type cannot break the listener.
      const data = event.data as { source?: { kind?: unknown; name?: unknown } } | undefined
      if (data?.source?.kind !== 'skill-invocation') return
      const skill = typeof data.source.name === 'string' ? data.source.name : undefined
      if (skill === undefined) {
        debug(ctx, 'skill-usage: skill-invocation event without a string name — row skipped')
        return
      }
      // Resolve the cwd FIRST: projectKeyOf takes a string, so the undefined
      // guard must precede the call. Unresolvable ⇒ skip (D-J).
      const cwd = getSessionCwdForSession(session)
      if (typeof cwd !== 'string') {
        debug(ctx, 'skill-usage: slash-form load without a resolvable session cwd — row skipped')
        return
      }
      commit(ctx, projectKeyOf(cwd), {
        sessionId: String(session.id),
        skill,
        via: 'slash',
      })
    } catch (error: unknown) {
      debug(ctx, `skill-usage: slash-form listener failed: ${String(error)}`)
    }
  })
}

/** Shared per-match commit path: dshHome gate → raw enabled gate → ledger + marker. */
function commit(ctx: Context, projectKey: string, base: Parameters<typeof commitLoad>[3]): void {
  // Providerless host / bare tests ⇒ complete no-op, debug-logged.
  const home = dshHomeFn(ctx)?.()
  if (home === undefined) {
    debug(ctx, 'skill-usage: no dshHomePath — telemetry is a no-op')
    return
  }
  commitLoad(ctx, home, projectKey, base)
}

/** Session id of the owning agent (empty for agent-less executions). */
function sessionIdOf(agent: Agent | undefined): string {
  return agent === undefined ? '' : String(agent.session.id)
}
