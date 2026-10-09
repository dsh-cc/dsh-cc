/**
 * Receipt construction from one settled tool execution (plan
 * docs/plans/2026-10-09-runtime-verified-completion.md §3.2). Pure — the
 * wiring computes the receipt BEFORE calling `next()` so the recorded hashes
 * are independent of downstream content rewrites (CCR composition, §3.2/§5.12).
 * `stableJson` is a LOCAL sorted-key canonical JSON helper — not imported
 * across packages (§3.2 pin).
 *
 * @module @dsh-cc/completion-gate/receipts
 */

import { createHash } from 'node:crypto'
import { scrubHead } from './scrub.ts'
import type { Receipt } from './events.ts'

/** Canonical JSON: sorted keys, no whitespace. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/** sha256 hex digest truncated to 16 chars. */
export function digest16(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/** Text blocks of a content list, joined by newline (turn-rules idiom). */
function textOf(content: readonly { type: string; text?: string }[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

/** Owning session id, or null when no session is reachable (§3.6). */
function sessionIdOf(exec: ToolExecutionLike): string | null {
  const id = exec.agent?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/** Structural minimum of `ToolExecution` used here (avoids a runtime dep). */
interface ToolExecutionLike {
  callId: string
  name: string
  arguments: unknown
  agent?: { session?: { id?: unknown } }
}

/**
 * Build one receipt. `head` is written ONLY for bash rows (the CC-alias bash
 * variant maps to the same canonical tool name and the same `command` field)
 * and only when `cc-completion-gate.enabled` was true at execute time (§3.5).
 */
export function buildReceipt(
  exec: ToolExecutionLike,
  result: Readonly<{ isError: boolean; error?: { info?: { code?: string } }; content: readonly { type: string; text?: string }[] }>,
  opts: { headEnabled: boolean },
): Receipt {
  const text = textOf(result.content)
  const receipt: Receipt = {
    v: 1,
    ts: Date.now(),
    sessionId: sessionIdOf(exec),
    callId: exec.callId,
    tool: exec.name,
    argsDigest: digest16(stableJson(exec.arguments ?? null)),
    outcome: result.isError ? 'error' : 'ok',
    errorCode: result.isError ? result.error?.info?.code ?? null : null,
    contentHash: digest16(text),
    textBytes: Buffer.byteLength(text, 'utf8'),
  }
  if (opts.headEnabled && exec.name === 'bash') {
    const command = (exec.arguments as { command?: unknown } | null)?.command
    if (typeof command === 'string' && command.length > 0) {
      receipt.head = scrubHead(command)
    }
  }
  return receipt
}

