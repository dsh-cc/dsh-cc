/**
 * The §4.7 post-execute listener: prefix gate-computed notices onto
 * `send_message` results, append the delegation-discipline advisory in the
 * delegator direction, and annotate `list_agents` for pinned children. rc.5
 * (plan §3.3, R2): `send_message` targets by NAME — the advisory's
 * child→parent suppression resolves the name (via {@link resolveSendTarget})
 * before comparing against the caller's parentSession, and list_agents rows
 * render names instead of durable ids, so the annotator matches pinned ids
 * against their rendered addresses (via {@link renderedAgentAddresses}).
 *
 * @module @dsh-cc/subagent-resume-pins/post-execute
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'
import { renderedAgentAddresses, resolveSendTarget } from './name-resolution.ts'
import type { ExecutionNoticeBus } from './serialize.ts'
import type { CorruptPin, PinStore } from './store.ts'
import type { ResumePin } from './pin.ts'

/** Delegation-discipline advisory suffixed to delegator-direction send_message results. */
const DELEGATION_DISCIPLINE_ADVISORY =
  'Delegation discipline: `send_message` continues this agent’s current assignment only; '
  + 'a NEW task needs a fresh `subagent_fork` spawn (a plain spawn, not `subagent_type: "fork"`).'

/** The list_agents counterpart of the advisory, appended once below the pin annotations. */
const LIST_DISCIPLINE_LINE =
  'Delegation discipline: an idle/ready child stays continuable for its CURRENT assignment only'
  + ' — a new task needs a fresh `subagent_fork` spawn (plain spawn, not `subagent_type: "fork"`).'

/** The text of one tool result's content blocks (for annotation matching). */
function resultText(result: { content: readonly ContentBlock[] }): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/**
 * The rc.5 post-execute accept replacement: an accept DECISION keeps the
 * dispatched result's rendered blocks unless it carries content, and either
 * decision may ferry `additionalContexts` — preserve both when annotating.
 */
function acceptWithContent(
  decision: Extract<PostToolDecision, { kind: 'accept' }>,
  content: ContentBlock[],
): Extract<PostToolDecision, { kind: 'accept' }> {
  return {
    kind: 'accept',
    ...(decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {}),
    content,
  }
}

/** Closures the listener needs from the plugin (store, gate, and fingerprint seam). */
export interface PostExecuteDeps {
  readonly store: PinStore
  readonly readPin: (childId: string) => ResumePin | CorruptPin | undefined
  /** Re-fingerprint a pin's definition in the CURRENT composition (gated persona). */
  readonly currentFingerprintOf: (pin: ResumePin) => Promise<string | 'missing' | null>
  readonly pendingNotices: ExecutionNoticeBus
}

/** Wire the annotated `tools/post-execute` listener. */
export function wirePostExecute(ctx: Context, deps: PostExecuteDeps): void {
  const { store, readPin, currentFingerprintOf, pendingNotices } = deps
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const out = await next()
    if (out.kind !== 'accept') return out
    // rc.5 pipeline contract: an accept DECISION carries replacement content
    // only when present; the dispatched RESULT holds the rendered blocks. A
    // gate/guard deny surfaces as an isError result whose reason text must
    // never be rewritten.
    if (result.isError === true) return out
    const baseContent = out.content ?? result.content
    if (exec.name === 'send_message') {
      const notices = pendingNotices.take(exec.token)
      const argument = (exec.arguments as { agent?: unknown } | null)?.agent
      const callerParent = (exec.agent as { session?: { header?: { parentSession?: unknown } } } | undefined)
        ?.session?.header?.parentSession
      // R2 (rc.5): `agent` is a NAME — resolve it so a child→parent report
      // addressed BY NAME (`lead` or a path) still matches the caller's
      // parentSession id; an unresolvable argument keeps the raw token (the
      // delegator direction must never be suppressed incorrectly).
      const resolved = typeof argument === 'string' && argument.length > 0
        ? await resolveSendTarget(ctx, exec.agent, argument, exec.signal)
        : undefined
      const target = resolved ?? (typeof argument === 'string' && argument.length > 0 ? argument : undefined)
      // Child→parent result reports (explicitly instructed by the harness continuable initial
      // prompt) are same-conversation sends: never annotate them. exec.agent === undefined or a
      // non-matching parentSession is the delegator direction → the advisory fires.
      const delegatorDirection = target !== undefined && String(callerParent) !== target
      if (notices.length > 0 || delegatorDirection) {
        return acceptWithContent(out, [
          ...notices.map(text => ({ type: 'text' as const, text })),
          ...(baseContent ?? []),
          ...(delegatorDirection ? [{ type: 'text' as const, text: DELEGATION_DISCIPLINE_ADVISORY }] : []),
        ])
      }
      return out
    }
    if (exec.name === 'list_agents') {
      const annotations: string[] = []
      const text = resultText(result)
      // R2 (rc.5): rows render the model-facing NAME, never the durable id
      // of a fully-named child — map pinned ids to their rendered addresses;
      // an unreadable tree degrades to id-only matching (unnamed history).
      const rendered = await renderedAgentAddresses(ctx, exec.agent, exec.signal)
      for (const childId of store.ids()) {
        const candidates = rendered?.get(childId) ?? [childId]
        // Substring matching is safe for ids but NOT for names: `agent-1`
        // must not match the `agent-10 [status]` row — anchor names to rows.
        const listed = candidates.some(candidate => candidate === childId
          ? text.includes(candidate)
          : text.split('\n').some(line => line === candidate || line.startsWith(`${candidate} [`)))
        if (!listed) continue
        const pin = readPin(childId)
        if (pin === undefined) continue
        if ('kind' in pin) {
          annotations.push(`[resume-pin] ${childId}: state blocked (pin unreadable)`)
          continue
        }
        const current = await currentFingerprintOf(pin)
        const pinnedFingerprint = pin.definition.kind === 'named' ? pin.definition.fingerprint : undefined
        const definitionChanged = current !== null && (pinnedFingerprint === undefined || current !== pinnedFingerprint)
        const parts = [`state ${pin.resume.state}`]
        if (definitionChanged) parts.push('definition changed')
        if (pin.lastNotice !== undefined) parts.push(pin.lastNotice)
        annotations.push(`[resume-pin] ${childId}: ${parts.join('; ')}`)
      }
      if (annotations.length > 0) {
        annotations.push(LIST_DISCIPLINE_LINE)
        return acceptWithContent(out, [...(baseContent ?? []), { type: 'text' as const, text: annotations.join('\n') }])
      }
    }
    return out
  })
}
