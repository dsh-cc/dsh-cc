/**
 * Normalize a durable/live `tool/result` event payload into the flat shape the
 * transcript fold needs. Handles the legacy top-level shape (harness <0.1.2-rc.1)
 * and the message-wrapped shape (fbf87e660c) side by side, because resume-replay
 * of older durable logs must keep folding.
 * @module @dsh-cc/tui/tool-result-payload
 */

/** Normalized tool/result payload. */
export interface ToolResultPayload {
  /** '' when unresolvable (garbage, obsolete logs). */
  callId: string
  /** Legacy shape only; wrapped results carry no tool name. */
  name?: string
  /** Result content blocks. */
  content?: { type: string; text?: string }[]
  isError: boolean
  /** Pass-through for presenters. */
  meta?: unknown
  /** Concatenated text of text blocks, no separator. */
  text: string
}

type Rec = Record<string, unknown>

function isObject(value: unknown): value is Rec {
  return value !== null && typeof value === 'object'
}

function textOfBlocks(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block): block is { type?: unknown; text?: unknown } =>
      isObject(block) && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/**
 * Normalize a tool/result event payload. Never throws: garbage or absent
 * fields degrade to `{ callId: '', text: '', isError }` (this runs during
 * resume-replay of obsolete logs).
 */
export function normalizeToolResult(data: unknown): ToolResultPayload {
  const hasError = isObject(data) && data.error !== undefined
  if (!isObject(data)) return { callId: '', isError: hasError, text: '' }
  const meta = data.meta
  const withMeta = (payload: ToolResultPayload): ToolResultPayload =>
    meta === undefined ? payload : { ...payload, meta }

  // Wrapped shape: { message: { source?, content: [tool-result] }, meta }.
  if (isObject(data.message)) {
    const blocks = Array.isArray(data.message.content) ? data.message.content : []
    const block = blocks.find(candidate => isObject(candidate) && candidate.type === 'tool-result')
    const blockRec = isObject(block) ? block : undefined
    const source = data.message.source
    const sourceCallId = isObject(source) && source.callId !== undefined
      ? String(source.callId)
      : ''
    const blockCallId = blockRec?.toolCallId !== undefined ? String(blockRec.toolCallId) : ''
    const callId = sourceCallId !== '' ? sourceCallId : blockCallId
    if (callId === '') return { callId: '', isError: hasError, text: '' }
    const content = Array.isArray(blockRec?.content) ? blockRec.content : undefined
    return withMeta({
      callId,
      ...(content !== undefined ? { content } : {}),
      isError: blockRec?.isError === true || hasError,
      text: textOfBlocks(blockRec?.content),
    })
  }

  // Legacy shape: top-level callId/name/content(+text).
  const callId = data.callId !== undefined
    ? String(data.callId)
    : data.id !== undefined ? String(data.id) : ''
  const name = typeof data.name === 'string'
    ? data.name
    : typeof data.toolName === 'string' ? data.toolName : undefined
  const content = typeof data.content === 'string'
    ? [{ type: 'text', text: data.content }]
    : Array.isArray(data.content)
      ? data.content as { type: string; text?: string }[]
      : undefined
  const text = typeof data.text === 'string'
    ? data.text
    : typeof data.content === 'string' ? data.content : textOfBlocks(data.content)
  return withMeta({ callId, ...(name !== undefined ? { name } : {}), ...(content !== undefined ? { content } : {}), isError: hasError, text })
}
