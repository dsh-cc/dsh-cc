/**
 * Delivery (design docs/plans/2026-10-09-structured-progress-and-post-compact-rebuild.md
 * §3.3 steps 1-4): Listener B (the `compaction/end` trigger with the
 * in-turn / idle path split), Listener C (the `agent/pre-step` splice),
 * the idle deferred inject, and the delivery ACK observer with the
 * `progress-rebuild/injected` measurement append.
 *
 * All paths no-op unless `progress-rebuild.enabled` (§3.3 round-9 gate);
 * every fault degrades to a debug log — delivery failure carries no
 * user-facing error (§3.6).
 *
 * @module @dsh-cc/progress-rebuild/delivery
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { renderBrief } from './brief.ts'
import { appendProgressRebuildInjected, type ProgressRebuildInjectedEventData } from './events.ts'
import type { ProgressRebuildSettings } from './settings.ts'

/** Delivery path recorded at splice/inject time, looked up by the ACK observer. */
export type DeliveryPath = 'pre-step' | 'inject'

/** Bounded path-stash capacity (§3.3 step 4). */
export const PATH_STASH_CAPACITY = 64

/** Max length of one debug line — never log full briefs. */
const DEBUG_HEAD = 120

/** Debug notice (fail-soft, advisor pattern). */
function debug(ctx: Context, message: string): void {
  try {
    ctx.logger.debug(`progress-rebuild: ${message.slice(0, DEBUG_HEAD)}`)
  } catch {
    // Never throw into a hot path.
  }
}

/**
 * Register the delivery listeners. Plain listeners — never throw into a
 * waterfall or an observer callback.
 * @param ctx - the plug context (needs `agents`, `sessionProjections`, `logger`).
 * @param readSettings - live settings reader (gate for B, C, and measurement).
 */
export function registerDelivery(
  ctx: Context,
  readSettings: () => ProgressRebuildSettings,
): void {
  /** In-turn path: one pending brief per session id, cleared on splice (in-memory only, §3.3). */
  const pendingBrief = new Set<string>()
  /** Path stash: brief messageId → delivery path (§3.3 step 4). */
  const pathStash = new Map<string, DeliveryPath>()

  const rememberPath = (messageId: string, path: DeliveryPath): void => {
    if (pathStash.size >= PATH_STASH_CAPACITY) {
      const oldest = pathStash.keys().next().value
      if (oldest !== undefined) pathStash.delete(oldest)
    }
    pathStash.set(messageId, path)
  }

  /** Resolve the live agent for one session (registry is sessionId-keyed). */
  const agentOf = (session: Session): Agent | undefined => {
    try {
      return (ctx.get('agents') as { get(id: unknown): Agent | undefined } | undefined)
        ?.get(session.header.id)
    } catch {
      return undefined
    }
  }

  /** Build the brief message from the CURRENT projection state. */
  const buildBriefMessage = (session: Session): { message: UserMessage; sections: number } | undefined => {
    try {
      const projections = ctx.get('sessionProjections') as SessionProjectionRegistry | undefined
      if (projections === undefined) return undefined
      const state = projections.stateOf(session, 'progress-rebuild')
      if (state === undefined) return undefined
      const settings = readSettings()
      const brief = renderBrief(state, { maxLines: settings.maxLines, includeVerified: settings.includeVerified })
      const text = brief.text
      return {
        message: createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'progress-rebuild' },
        }),
        sections: brief.sections,
      }
    } catch (error: unknown) {
      debug(ctx, `brief build failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  // Listener B (§3.3 step 1): the compaction/end trigger with the path split.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    try {
      if (event.type !== 'compaction/end') return
      const settings = readSettings()
      if (!settings.enabled) return
      // Skip failed compactions FIRST: nothing was amputated, so no resume
      // brief (a resume label on intact history would mislead).
      if ((event.data as { error?: unknown }).error !== undefined) return
      const agent = agentOf(session)
      if (agent === undefined) {
        debug(ctx, 'compaction/end with no resolvable agent; skipping')
        return
      }
      const turn = (event.data as { turn: number | null }).turn
      if (turn === null) {
        // Idle path: DEFERRED durable inject — a synchronous agent.inject
        // appends `agent/inbox/spliced` inside the publication window and
        // throws reentry, silently contained (§3.3 step 1).
        queueMicrotask(() => {
          try {
            const brief = buildBriefMessage(session)
            if (brief === undefined) return
            rememberPath(brief.message.id, 'inject')
            agent.inject(brief.message)
          } catch (error: unknown) {
            debug(ctx, `idle inject failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        })
      } else {
        // In-turn path: the step's inbox claim already happened before the
        // pre-step waterfall — deliver via Listener C, never inject here.
        pendingBrief.add(String(session.header.id))
      }
    } catch (error: unknown) {
      debug(ctx, `listener B failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // Listener C (§3.3): in-turn delivery on the pre-step waterfall. `await
  // next()` resolves after the whole chain (compaction included) ran, so a
  // pendingBrief set by an in-flight compaction is visible regardless of
  // registration order.
  ctx.on('agent/pre-step', async ({ agent }: { agent: Agent }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
    // `await next()` sits OUTSIDE the try: if the downstream chain already
    // threw, the waterfall is failing — re-invoking next() here would run
    // every downstream hook a second time. Only our post-processing is
    // fail-soft (it degrades to the unspliced decision).
    const decision = await next()
    try {
      const sessionId = String(agent.session.header.id)
      if (!pendingBrief.has(sessionId)) return decision
      if (decision.kind !== 'enter') return decision // reject leaves the flag set (next step delivers)
      const brief = buildBriefMessage(agent.session)
      if (brief === undefined) return decision
      pendingBrief.delete(sessionId)
      rememberPath(brief.message.id, 'pre-step')
      return { ...decision, messages: [...decision.messages, brief.message] }
    } catch (error: unknown) {
      debug(ctx, `listener C failed: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })

  // Delivery ACK (§3.3 step 4): fires only when a progress-rebuild-sourced
  // user/message is COMMITTED — both delivery paths end in that append; a
  // cancelled step between splice and append yields no row. The append is
  // DEFERRED out of the observer callback (session.append reentry inside
  // the publication window throws, silently).
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    try {
      if (event.type !== 'user/message') return
      if (!readSettings().enabled) return
      const message = event.data as { id?: unknown; source?: { kind?: unknown } }
      if (message.source?.kind !== 'progress-rebuild' || typeof message.id !== 'string') return
      const path = pathStash.get(message.id)
      if (path === undefined) return
      const text = (event.data as { content?: { type?: unknown; text?: unknown }[] }).content
        ?.find((block) => block?.type === 'text')?.text
      if (typeof text !== 'string') return
      const payload: ProgressRebuildInjectedEventData = {
        bytes: Buffer.byteLength(text, 'utf8'),
        sections: countSections(text),
        path,
      }
      queueMicrotask(() => {
        try {
          appendProgressRebuildInjected(session, payload)
        } catch (error: unknown) {
          debug(ctx, `measurement append failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
    } catch (error: unknown) {
      debug(ctx, `ack observer failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // Cleanup: a disposed session leaves no pending flag behind.
  ctx.on('session/disposed', (session: Session) => {
    try {
      pendingBrief.delete(String(session.header.id))
    } catch {
      // Never throw from cleanup.
    }
  })
}

/**
 * Count the brief's top-level sections for the measurement event — the same
 * accounting as {@link renderBrief} (goal / verified / todos / last-user).
 */
export function countSections(text: string): number {
  let sections = 0
  if (/^- Goal: /m.test(text)) sections += 1
  if (text.includes('Verified commands (executed, exit 0')) sections += 1
  if (text.includes('- Todo snapshot (verbatim):')) sections += 1
  if (/^- Last user instruction at /m.test(text)) sections += 1
  return sections
}
