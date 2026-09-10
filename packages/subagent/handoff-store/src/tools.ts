/**
 * The `handoff_put` / `handoff_get` agent tools over the handoff store.
 *
 * `handoff_put` parks a large artifact (review body, long plan, bulk
 * findings) in the store and returns a short summary embedding the
 * `handoff://<id>` handle; the orchestrator or a follow-up child resolves it
 * with `handoff_get({ id })` — the sibling-transfer path. The threshold in
 * the description is the ADVISORY contract only (see cc-handoff.threshold-chars):
 * put never enforces or rejects on size. `handoff_get` derives the project
 * bucket from the FETCHING session's cwd (CCR `context_retrieve` precedent),
 * so only sessions in the SAME working directory can fetch — two git
 * worktrees of one repo are different projects by design.
 *
 * @module @dsh-cc/handoff-store/tools
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@dsh-cc/tools'
import { getSessionCwd } from '@dsh-cc/session-cwd'
import { HandoffLedger } from './ledger.ts'
import { resolveHandoffConfig } from './settings.ts'
import { HandoffStore, projectKeyOf } from './store.ts'
import type { HandoffConfig, HandoffMeta } from './types.ts'

export const HANDOFF_PUT_TOOL = 'handoff_put'
export const HANDOFF_GET_TOOL = 'handoff_get'

/** Advisory-threshold sentence shared by the put description and the tool note. */
export const THRESHOLD_NOTE =
  'Default 8192 (see cc-handoff.threshold-chars). The threshold is advisory: '
  + 'handoff_put never rejects or truncates on size.'

/** A model-visible handoff failure (maps to an isError tool result). */
export class HandoffToolError extends Error {}

export interface HandoffDeps {
  store: HandoffStore
  ledger: HandoffLedger
  readSettings: () => HandoffConfig | undefined
  sessionIdOf(agent?: Agent): string
}

/** sha256(session cwd), 16 hex — or undefined when the cwd is unavailable. */
export function cwdProjectKey(agent: Agent | undefined): string | undefined {
  if (agent === undefined) return undefined
  try {
    return projectKeyOf(getSessionCwd(agent))
  } catch {
    return undefined
  }
}

/** Head-truncate with a trailing note when `maxChars` cuts the text. */
export function applyMaxChars(text: string, maxChars: number | undefined): string {
  if (maxChars === undefined || !Number.isFinite(maxChars) || maxChars < 1 || text.length <= maxChars) {
    return text
  }
  return `${text.slice(0, maxChars)}\n\n[dsh-cc handoff truncated at ${maxChars} of ${text.length} chars; full text: use handoff_get]`
}

export function defineHandoffPutTool(deps: HandoffDeps) {
  return defineTool({
    name: HANDOFF_PUT_TOOL,
    description:
      'Park a large artifact (a long review, plan, or report that would flood the parent context) in the '
      + 'durable handoff store and return a short summary with a `handoff://<id>` handle. Use it BEFORE '
      + 'writing a big report into your final message: return the summary (at most ~2 KB) and embed the '
      + 'handle; the orchestrator or a follow-up child fetches the full text with handoff_get. '
      + 'Retention 24 h; visible to sessions in the SAME working directory only. '
      + `Threshold: ${THRESHOLD_NOTE}`,
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: 'The full artifact text to store. Stored verbatim; never truncated by the tool.',
      },
      label: {
        type: 'string',
        description: 'Short one-line label describing the artifact (e.g. "review of PR #12").',
      },
      agent: {
        type: 'string',
        description: 'Originating agent name, when known (defaults to the calling agent, if it has one).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: { message: string }) => [{ type: 'text', text: value.message }],
    },
    async execute(args: { content: string; label?: string; agent?: string }, exec: { agent?: Agent }) {
      const cfg = resolveHandoffConfig(deps.readSettings())
      if (!cfg.enabled) throw new HandoffToolError('handoff_put unavailable: cc-handoff.enabled is false')
      const projectKey = cwdProjectKey(exec.agent)
      if (projectKey === undefined) throw new HandoffToolError('handoff_put unavailable: no session cwd')
      const content = args.content
      if (typeof content !== 'string' || content.length === 0) {
        throw new HandoffToolError('handoff_put: content must be a non-empty string')
      }
      const agentName = args.agent ?? (exec.agent === undefined ? undefined : (exec.agent as { name?: string }).name)
      const meta: HandoffMeta = {
        ...(args.label === undefined ? {} : { label: args.label }),
        ...(agentName === undefined ? {} : { agent: agentName }),
      }
      const id = await deps.store.put(projectKey, content, meta)
      const chars = content.length
      await deps.ledger.append({
        ts: new Date().toISOString(),
        project: projectKey,
        sessionId: deps.sessionIdOf(exec.agent),
        id,
        ...(meta.label === undefined ? {} : { label: meta.label }),
        ...(meta.agent === undefined ? {} : { agent: meta.agent }),
        chars,
      })
      // Advisory note only — the threshold is never enforced (design decision 5).
      const over = chars > cfg.thresholdChars
        ? ` Over the ${cfg.thresholdChars}-char advisory threshold: your final message should carry only a short summary (≤2 KB) plus the handoff://<id> handle below.`
        : ''
      return {
        id,
        message: `Stored handoff artifact ${id} (${chars} chars, retention 24h). Reference: handoff://${id}`
          + `${over} Fetch it with handoff_get({ id: "${id}" }) — same working directory only.`,
      }
    },
  })
}

export function defineHandoffGetTool(deps: HandoffDeps) {
  return defineTool({
    name: HANDOFF_GET_TOOL,
    description:
      'Fetch the FULL text of an artifact a subagent parked with handoff_put, using the 20-hex id from its '
      + '`handoff://<id>` handle. Only sessions in the SAME working directory as the putting session can '
      + 'resolve a handle. Pass maxChars to read a head-truncated prefix when you only need an overview. '
      + 'Artifacts expire after 24 hours.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'The 20-hex id from a `handoff://<id>` handle.',
      },
      maxChars: {
        type: 'number',
        description: 'Head-truncate the returned text to this many chars, with a trailing truncation note. Omit for the full text.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
    },
    async execute(args: { id: string; maxChars?: number }, exec: { agent?: Agent }) {
      const projectKey = cwdProjectKey(exec.agent)
      if (projectKey === undefined) throw new HandoffToolError('handoff_get unavailable: no session cwd')
      const outcome = await deps.store.get(projectKey, args.id)
      if (!outcome.ok) throw new HandoffToolError(`handoff_get failed: ${outcome.error}`)
      return { text: applyMaxChars(outcome.text, args.maxChars) }
    },
  })
}
