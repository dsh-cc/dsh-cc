/**
 * Redactor: turns raw session-log events into byte-stable, commit-safe
 * sanitized fixtures for the replay tier (plan §3.2). Pure function over
 * `SessionLogEvent[]` — file reading (incl. zstd) is a later slice.
 *
 * Keep/drop decision table (minimal set the metrics fold consumes):
 *
 * | event type        | decision | kept data fields                                   |
 * |-------------------|----------|----------------------------------------------------|
 * | assistant/message | keep     | turn, step, usage (verbatim; usage-ABSENT is legal for interrupted turns) — body/stream dropped |
 * | request/context   | keep     | provider, model — exactly what analyzeSessionCache  |
 * |                   |          | reads for route attribution                        |
 * | request/header    | keep     | header.config.provider + .model only               |
 * | tool/result       | keep     | turn, step; message content text replaced by a     |
 * |                   |          | `[body redacted N chars]` placeholder EXCEPT lines |
 * |                   |          | matching the CCR marker (kept verbatim so replay-  |
 * |                   |          | tier ccr.* counters are structurally nonzero)      |
 * | everything else   | drop     | non-usage-bearing; kept as `{type, time?, data:{}}` |
 *                   metadata-stripped pass-through to preserve log order
 *
 * Loud failure (plan §7 residual risk): any event whose data carries a
 * usage-like key must either be an `assistant/message` with a well-formed
 * TokenUsage, or the run throws `RedactorDeviationError` — never silently
 * fold wrong numbers.
 *
 * @module @dsh-cc/token-efficiency/redactor
 */
import type { SessionLogEvent } from '@dsh-cc/cache-trajectory'

/** The only event type whose usage is folded by the metrics. */
const USAGE_KEEP_TYPE = 'assistant/message'

/** CCR provenance marker — pinned contract in @dsh-cc/context-crusher/marker. */
const CCR_MARKER_RE = /^\[dsh-cc compressed \d+→\d+ tokens\. Original: ccr:\/\/[0-9a-f]{16}\]$/

/** Thrown when a usage-bearing event deviates from the keep contract. */
export class RedactorDeviationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RedactorDeviationError'
  }
}

interface UsageLike { inputTokens?: unknown; outputTokens?: unknown }

function isUsageLike(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const u = value as UsageLike
  return 'inputTokens' in u || 'outputTokens' in u
}

/** Usage-like key present in data → the event claims to carry token traffic. */
function usageKeyOf(data: Record<string, unknown>): { key: string; usage: unknown } | undefined {
  for (const [key, value] of Object.entries(data)) {
    if (key === 'usage' || isUsageLike(value)) return { key, usage: value }
  }
  return undefined
}

function isWellFormedUsage(usage: unknown): usage is Record<string, number> {
  if (typeof usage !== 'object' || usage === null) return false
  const u = usage as UsageLike
  return typeof u.inputTokens === 'number' && Number.isFinite(u.inputTokens)
    && typeof u.outputTokens === 'number' && Number.isFinite(u.outputTokens)
}

function redactText(text: string): string {
  const lines = text.split('\n')
  const markerLines: string[] = []
  let redactedChars = 0
  for (const line of lines) {
    if (CCR_MARKER_RE.test(line)) markerLines.push(line)
    else redactedChars += line.length
  }
  const placeholder = `[body redacted ${redactedChars} chars]`
  return markerLines.length > 0 ? [placeholder, ...markerLines].join('\n') : placeholder
}

interface ContentBlock { type?: unknown; text?: unknown; content?: unknown }

function redactContent(content: unknown, depth = 0): unknown {
  if (typeof content === 'string') return redactText(content)
  if (!Array.isArray(content)) return undefined
  if (depth > 3) return undefined
  return content.map((block: ContentBlock) => {
    if (typeof block?.text === 'string') return { type: block.type, text: redactText(block.text) }
    // Real tool/result shape nests the output one level down:
    // content: [{ type: 'tool-result', content: [{ type: 'text', text }] }] —
    // without the recursion CCR markers living in that nested text are lost.
    if (Array.isArray(block?.content)) return { type: block.type, content: redactContent(block.content, depth + 1) }
    return { type: block?.type }
  })
}

function sanitizeData(event: SessionLogEvent, index: number): Record<string, unknown> | undefined {
  const data = event.data
  if (data === undefined) return undefined
  switch (event.type) {
    case 'assistant/message': {
      // usage-absent assistant messages are LEGAL (interrupted turns, plan §7
      // ruling): keep the event with usage absent; only a PRESENT-but-malformed
      // usage record throws.
      const usage = data['usage']
      if (usage === undefined) {
        const message = data['message'] as Record<string, unknown> | undefined
        return {
          turn: data['turn'],
          step: data['step'],
          ...(message === undefined ? {} : { message: { content: redactContent(message['content']) } }),
        }
      }
      if (!isWellFormedUsage(usage)) {
        throw new RedactorDeviationError(
          `${event.type} event #${index}: usage must be an object with numeric finite inputTokens/outputTokens`,
        )
      }
      return { turn: data['turn'], step: data['step'], usage }
    }
    case 'request/context':
      return keepStrings(data, ['provider', 'model'])
    case 'request/header': {
      const header = data['header'] as Record<string, unknown> | undefined
      const config = header?.['config'] as Record<string, unknown> | undefined
      if (config === undefined) return { header: {} }
      return { header: { config: keepStrings(config, ['provider', 'model']) } }
    }
    case 'tool/result': {
      const message = data['message'] as Record<string, unknown> | undefined
      return {
        turn: data['turn'],
        step: data['step'],
        message: message === undefined ? undefined : { content: redactContent(message['content']) },
      }
    }
    default:
      return {}
  }
}

function keepStrings(data: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (typeof data[key] === 'string') out[key] = data[key]
  }
  return out
}

/**
 * Sanitize a session log into the committed-fixture shape. Order-preserving;
 * `time` is kept on all events so gap detection keeps working.
 */
export function sanitizeSessionEvents(events: readonly SessionLogEvent[]): SessionLogEvent[] {
  return events.map((event, index) => {
    const usageKey = event.data === undefined ? undefined : usageKeyOf(event.data)
    if (usageKey !== undefined && event.type !== USAGE_KEEP_TYPE) {
      throw new RedactorDeviationError(
        `${event.type} event #${index}: carries usage-like key "${usageKey.key}" but is not in the usage keep-set`,
      )
    }
    const data = sanitizeData(event, index)
    const out: { type: string; time?: number; data?: Record<string, unknown> } = { type: event.type }
    if (event.time !== undefined) out.time = event.time
    if (data !== undefined) out.data = data
    return out
  })
}

/** Recursively sort object keys so the rendered JSONL is byte-stable. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

/** Render sanitized events as canonical JSONL: sorted keys, LF, trailing newline. */
export function renderCanonicalJsonl(events: readonly SessionLogEvent[]): string {
  if (events.length === 0) return ''
  return `${events.map(event => JSON.stringify(sortKeys(event))).join('\n')}\n`
}
