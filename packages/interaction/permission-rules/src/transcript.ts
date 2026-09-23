/**
 * Transcript-fold for the classifier input window (S3/D7): bounded human
 * `user_intent` and non-read-only `tool_history` folded from session events.
 * Pure — no I/O, never throws, malformed events skipped.
 * @module @dsh-cc/permission-rules/transcript
 */

import { ccToolAliases } from '@dsh-cc/tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** The folded classifier context sections (either may be empty). */
export type ClassifierContextFold = { userIntent: string; toolHistory: string }

/** Caps (D7/A3): per-message 400, per-subject 120, sections 1536. */
const MESSAGE_CAP = 400
const SUBJECT_CAP = 120
const SECTION_CAP = 1536
const INTENT_KEEP_LAST = 4
const HISTORY_KEEP_LAST = 10

/** The `user/message` wire face: content blocks + the injection source tag. */
type UserCallWire = { content?: unknown; source?: { kind?: unknown } }
type ToolCallWire = { name?: unknown; arguments?: unknown }

/** Extract the joined text of a content-block array. */
function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string') {
      parts.push((block as { text: string }).text)
    }
  }
  return parts.join('\n')
}

/** Subject of one tool call's raw arguments (bash command, file path, subagent prompt, JSON fallback). */
function subjectOf(name: string, rawArgs: unknown): string {
  let args: Record<string, unknown>
  if (typeof rawArgs === 'string') {
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>
    } catch {
      return rawArgs
    }
  } else if (typeof rawArgs === 'object' && rawArgs !== null) {
    args = rawArgs as Record<string, unknown>
  } else {
    return ''
  }
  const command = args['command']
  if (typeof command === 'string' && ccToolAliases(name).includes('Bash')) return command
  const filePath = args['file_path']
  if (typeof filePath === 'string') return filePath
  if (ccToolAliases(name).some(alias => alias === 'subagent' || alias === 'subagent_fork' || alias === 'Task' || alias === 'Agent')) {
    const prompt = args['prompt']
    if (typeof prompt === 'string') return prompt
    const description = args['description']
    if (typeof description === 'string') return description
  }
  return JSON.stringify(args)
}

/**
 * Fold session events into the D7 classifier context window.
 *
 * `userIntent`: only human-origin `user/message` events
 * (`data.source?.kind === 'user'` — plugin-injected announcements share the
 * event type with kind `'plugin'` and are excluded), ALWAYS keeping the first
 * admitted message plus the last 4 (the middle evicts), each capped at 400
 * chars, order preserved, section capped at 1536.
 *
 * `toolHistory`: the last 10 `tool/call` events whose alias-normalized name is
 * not in `readOnlyTools`, as `<name>: <subject>` lines.
 */
export function foldClassifierContext(events: readonly SessionEvent[], opts: { readOnlyTools: ReadonlySet<string> }): ClassifierContextFold {
  const messages: string[] = []
  const history: string[] = []
  try {
    for (const event of events) {
      if (typeof event !== 'object' || event === null) continue
      const type = (event as { type?: unknown }).type
      const data: unknown = (event as { data?: unknown }).data
      if (typeof data !== 'object' || data === null) continue
      if (type === 'user/message') {
        const wire = data as UserCallWire
        if (wire.source?.kind !== 'user') continue
        const text = textOfContent(wire.content)
        if (text.length === 0) continue
        messages.push(text.slice(0, MESSAGE_CAP))
      } else if (type === 'tool/call') {
        const wire = data as ToolCallWire
        const name = typeof wire.name === 'string' ? wire.name : undefined
        if (name === undefined) continue
        if (ccToolAliases(name).some(alias => opts.readOnlyTools.has(alias))) continue
        history.push(`${name}: ${subjectOf(name, wire.arguments).slice(0, SUBJECT_CAP)}`)
      }
    }
  } catch {
    // never throws: a malformed event shape degrades to what was folded so far
  }
  let intent = messages.length === 0
    ? ''
    : (messages.length <= INTENT_KEEP_LAST + 1 ? messages : [messages[0]!, ...messages.slice(-(INTENT_KEEP_LAST))]).join('\n')
  intent = intent.slice(0, SECTION_CAP)
  return { userIntent: intent, toolHistory: history.slice(-HISTORY_KEEP_LAST).join('\n').slice(0, SECTION_CAP) }
}
