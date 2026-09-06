/**
 * Pure `/export` transcript rendering: session events → markdown or JSON text.
 * No cordis imports, so both renderers are unit-testable in isolation.
 * @module @dsh-cc/command-export/transcript
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** The export file formats `/export` can render. */
export type ExportFormat = 'markdown' | 'json'

/**
 * Extract user-visible text from one content block: visible text and reasoning
 * as-is, everything else (image references, structured payloads) as compact JSON.
 * @param block - one message content block.
 * @returns its human-readable text.
 */
export function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return block.text
    default:
      return JSON.stringify(block)
  }
}

/**
 * Render a whole message content array into readable text.
 * @param blocks - the message's content blocks, in order.
 * @returns joined block text with blank-line separation.
 */
export function contentText(blocks: readonly ContentBlock[]): string {
  return blocks.map(blockText).filter(text => text.length > 0).join('\n')
}

/** Render one event into its markdown section body, or null for non-surface events. */
function eventMarkdown(event: SessionEvent): { heading: string; body: string } | null {
  switch (event.type) {
    case 'user/message':
      return { heading: 'User', body: contentText(event.data.content) }
    case 'assistant/message':
      return { heading: 'Assistant', body: contentText(event.data.message.content) }
    case 'tool/result':
      return { heading: 'Tool', body: contentText(event.data.message.content) }
    default:
      return null
  }
}

/**
 * Render the session log as a readable markdown transcript. Only model-visible
 * events (user, assistant, tool result) become sections; boundary, chunk, and
 * log-only records are trace data and are omitted from the transcript.
 * @param events - the session's durable event log, in sequence order.
 * @param title - the session id or title used for the document heading.
 * @returns the complete markdown document.
 */
export function renderMarkdown(events: readonly SessionEvent[], title: string): string {
  const lines = [`# Session transcript: ${title}`, '']
  let exported = 0
  for (const event of events) {
    const section = eventMarkdown(event)
    if (section === null) continue
    exported += 1
    lines.push(`## ${section.heading}`, '', section.body, '')
  }
  if (exported === 0) {
    lines.push('_No conversation events recorded yet._', '')
  }
  return `${lines.join('\n')}`
}

/**
 * Render the session log as a lossless JSON transcript (the raw event array).
 * @param events - the session's durable event log, in sequence order.
 * @returns the JSON document with stable indentation.
 */
export function renderJson(events: readonly SessionEvent[]): string {
  return `${JSON.stringify(events, null, 2)}\n`
}

/**
 * Render a transcript in either supported format.
 * @param events - the session's durable event log.
 * @param format - `'markdown'` or `'json'`.
 * @param title - session label used by the markdown renderer.
 * @returns the complete document text.
 */
export function renderTranscript(
  events: readonly SessionEvent[],
  format: ExportFormat,
  title: string,
): string {
  return format === 'markdown' ? renderMarkdown(events, title) : renderJson(events)
}
