/**
 * Post-compaction progress rebuild — plugin wiring (design §3.3/§3.4).
 *
 * Plain plugin (no Service, no isolate key): registers the settings
 * namespace, then rides the `session/event` firehose (register-events.ts:264
 * registration shape). Every event updates the per-session shadow reducer
 * (process-lifetime Map — no snapshotEvents/eventAt/ownEvents backfill, pin
 * 6); on a SUCCESSFUL `compaction/end` the derived brief is injected into the
 * live agent and measured to the sidecar file — the injection runs in a
 * `queueMicrotask` (agent.inject logs an inbox-splice session append itself,
 * so it must leave the publishing append's reentry window first; see the
 * pin-5 note below) and NO `session.append` happens on our own path (custom
 * event types poison the log under 0.2.0-rc.x persistence; see src/types.ts).
 *
 * @module @dsh-cc/progress-rebuild
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { renderBrief } from './brief.ts'
import { applyEvent, createShadow, type ShadowState } from './shadow.ts'
import { DEFAULT_SETTINGS, registerSettings, type ProgressRebuildSettings } from './settings.ts'
import './types.ts'

export { SETTINGS_NAMESPACE, SettingsSchema, DEFAULT_SETTINGS, registerSettings, type ProgressRebuildSettings } from './settings.ts'
export { renderBrief, BRIEF_TITLE, MICROCOMPACT_STUB_SENTENCE, NOT_VERIFIED_WARNING, type BriefOptions } from './brief.ts'
export { applyEvent, createShadow, todoMark, VERIFIED_CAP, LAST_USER_MAX_CHARS, type ShadowState, type ShadowTodo, type ShadowGoal, type VerifiedReceipt } from './shadow.ts'
export { parseExitMarker, isProofCommand } from './receipts.ts'

/** Cordis plugin id. */
export const name = 'cc-progress-rebuild'

/** Agents registry structural seam (`ctx.get('agents')?.get(id)`, register-events.ts:222 shape). */
interface AgentsLike {
  get?(id: unknown): Agent | undefined
  inject?(message: unknown): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver, provided by @deepseek-ai/dsh-app-boot at boot. Optional in tests. */
    dshHomePath?: (...segments: string[]) => string
  }
}

/** dshHomePath seam, read defensively (handoff-store/src/index.ts:56-62 precedent). */
function dshHomeFn(ctx: Context): ((...segments: string[]) => string) | undefined {
  try {
    return (ctx as { dshHomePath?: (...segments: string[]) => string }).dshHomePath
  } catch {
    return undefined
  }
}

/**
 * Sidecar dogfood line: one JSON object `{ ts, bytes, sections }` appended to
 * `$DSH_HOME/progress-rebuild/<sessionId>.jsonl` (§3.3 step 4). Detached
 * write; dshHome absent → no-op; all errors swallowed (fail-soft).
 */
async function writeSidecar(home: (...segments: string[]) => string, sessionId: string, brief: string): Promise<void> {
  const [{ mkdir, appendFile }, { join }] = await Promise.all([import('node:fs/promises'), import('node:path')])
  const dir = home('progress-rebuild')
  await mkdir(dir, { recursive: true })
  const line = JSON.stringify({
    ts: Date.now(),
    bytes: Buffer.byteLength(brief, 'utf8'),
    sections: brief.split('\n').length,
  })
  await appendFile(join(dir, `${sessionId}.jsonl`), `${line}\n`, 'utf8')
}

/**
 * Mount the plugin: settings namespace + the session-event firehose listener.
 * @param ctx - the plug context.
 */
export function apply(ctx: Context): void {
  const readSettings = registerSettings(ctx) ?? (() => ({ ...DEFAULT_SETTINGS }))
  const shadows = new Map<string, ShadowState>()

  ctx.on('session/event', (session: Session, event: SessionEvent): void => {
    const sessionId = String(session.id)
    try {
      const shadow = shadows.get(sessionId) ?? createShadow()
      shadows.set(sessionId, applyEvent(shadow, event))
    } catch (error) {
      ctx.logger.debug(`progress-rebuild: applyEvent failed: ${String(error)}`)
      return
    }

    if ((event.type as string) !== 'compaction/end') return

    // Pin 5 (verified live): `agent.inject` itself logs a `user/message` via
    // `session.append`, so the whole injection path must leave the publishing
    // append's reentry window first — hence the queueMicrotask.
    queueMicrotask(() => {
      try {
        // §3.3 step 1: the FAILED compaction path also appends compaction/end
        // with an `error` field — never inject after a failed compaction.
        if ((event.data as { error?: unknown }).error !== undefined) return
        const agents = ctx.get('agents')?.get(session.id) as AgentsLike | undefined
        if (agents === undefined) {
          ctx.logger.debug(`progress-rebuild: no live agent for session ${sessionId}; skipping injection`)
          return
        }
        const settings: ProgressRebuildSettings = readSettings()
        if (!settings.enabled) return
        const shadow = shadows.get(sessionId) ?? createShadow()
        const brief = renderBrief(shadow, { maxLines: settings.maxLines, includeVerified: settings.includeVerified })
        agents.inject?.(createUserMessage({ content: [{ type: 'text', text: brief }], source: { kind: 'progress-rebuild' } }))
        // Sidecar measurement, fully detached (handoff-store precedent);
        // dshHome absent → no-op. NO session.append on this path (types.ts).
        const home = dshHomeFn(ctx)
        if (home === undefined) return
        void writeSidecar(home, sessionId, brief).catch((error: unknown) => {
          ctx.logger.debug(`progress-rebuild: sidecar write failed: ${String(error)}`)
        })
      } catch (error) {
        ctx.logger.debug(`progress-rebuild: compaction/end handler failed: ${String(error)}`)
      }
    })
  })
}
