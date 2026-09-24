/**
 * The cheap-lane envelope and output contract (plan
 * docs/plans/2026-09-23-advisor-watchdog.md §4.2/§4.3): one-shot
 * `runSideQuery` with `onUnrouted: 'skip'` (THE no-inherit switch) and
 * `rejectToolCalls: true` (one-shot — no tool loop can exist), plus the
 * deterministic zod parse of the note list.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { runSideQuery } from '@dsh-cc/side-query'
import type { Severity } from './settings.ts'
import type { AdvisorNote } from './guard.ts'

/** The advisor system prompt (§4.3): role, input format, taxonomy, empty contract. */
export const ADVISOR_SYSTEM_PROMPT = [
  'You are a read-only reviewer of one completed turn of a coding session.',
  'Input: transcript delta lines of the form `[role] content`, oldest first.',
  'Emit notes at exactly one of three severities:',
  '- "nit": minor or stylistic.',
  '- "concern": a likely problem worth one mention.',
  '- "blocker": user-visible harm in progress, e.g. ignoring an explicit instruction or a destructive command about to run.',
  'Output ONLY raw JSON: {"notes": [{"severity": "nit|concern|blocker", "text": "<= 500 chars"}]}, at most 16 notes.',
  'When nothing is worth saying, answer {"notes": []} — empty is the common case.',
].join('\n')

/** The exact output contract (§4.3 step 2). */
const NotesSchema = z.object({
  notes: z.array(z.object({
    severity: z.enum(['nit', 'concern', 'blocker']),
    text: z.string().min(1).max(500),
  })).max(16),
})

/** Parse failure result (§4.3 step 3): deliver nothing. */
export type ParseOutcome =
  | { ok: true; notes: AdvisorNote[] }
  | { ok: false }

/**
 * Deterministic parse (§4.3): strip at most one surrounding fence, then
 * validate against the zod schema. Any failure ⇒ malformed.
 */
export function parseAdvisorNotes(raw: string): ParseOutcome {
  let text = raw.trim()
  if (text.startsWith('```')) {
    // Strip at most one surrounding fence (with optional language tag). The
    // closing fence is optional — an assembler may deliver only the opener.
    const firstNewline = text.indexOf('\n')
    if (firstNewline === -1) return { ok: false }
    text = text.slice(firstNewline + 1)
    const closing = text.lastIndexOf('```')
    if (closing !== -1) text = text.slice(0, closing).trim()
  }
  try {
    const parsed = NotesSchema.parse(JSON.parse(text))
    return { ok: true, notes: parsed.notes }
  } catch {
    return { ok: false }
  }
}

/** Options for the one-shot advisor call (§4.2 exact shape). */
export interface AdviseOptions {
  agent: Agent
  alias: string
  renderedDelta: string
}

/**
 * Run the one-shot advisor side query. Never throws (runSideQuery collapses
 * every failure). No caller signal: disposal is preset remount.
 */
export function runAdvisor(
  ctx: Context,
  opts: { agent: Agent; alias: string; renderedDelta: string },
): ReturnType<typeof runSideQuery> {
  return runSideQuery(ctx, {
    agent: opts.agent,
    alias: opts.alias,
    system: ADVISOR_SYSTEM_PROMPT,
    prompt: opts.renderedDelta,
    maxTokens: 512,
    timeoutMs: 10_000,
    onUnrouted: 'skip',
    rejectToolCalls: true,
  })
}

/** Re-export for the severity type consumer. */
export type { Severity }
