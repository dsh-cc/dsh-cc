/**
 * Deterministic receipt verifier for the evidence-preserving reducer.
 * @module @dsh-cc/context-crusher/verifier
 */

import { parseReceipt, renderReceipt } from './receipt.ts'
import type { Receipt } from './receipt.ts'

/** Rejection reasons are ledgered as `verify:<reason>`. */
export type VerifyResult = { ok: true } | { ok: false; reason: string }

/** Exit-code patterns the view's tail may carry (plan §3.4.3b, conservative set). */
const EXIT_CODE_PATTERNS = [/exit(?:ed with)? code (\d+)/i, /make.*Error (\d+)/]

/** Number of trailing lines considered for exit-code verification. */
const TAIL_LINES = 64

/** Minimum quote length for evidence / key_output entries (stops vacuous matches). */
const MIN_QUOTE_LENGTH = 8

/**
 * Pure verifier (plan §3.4) — no I/O, no service imports. `estimate` is
 * injected (the call site binds the tokenMeter estimator; Phase 0 tests use a
 * deterministic stub). Checks run in order, first failure wins:
 *
 * 1. `schema` — parse + explicit unknown-key rejection;
 * 2. `quote` — every evidence/key_output string (≥ 8 chars, NFC-normalized)
 *    is a verbatim substring of the view;
 * 3. `exit` — `exit.ok === !isError`, and an `exit.code` is present only when
 *    the view's tail (last 64 lines) verifiably carries that exact code;
 * 4. `size` — `estimate(rendered)` < `minSavingsRatio` (default 0.5) ×
 *    `estimate(view)`;
 * 5. `counts` — when `counts` present, `fail` must equal `failures.length`.
 */
export function verifyReceipt(
  view: string,
  receipt: unknown,
  isError: boolean,
  estimate: (text: string) => number,
  opts?: { minSavingsRatio?: number },
): VerifyResult {
  // 1. schema (types + exact key sets at every object level).
  const r: Receipt | null = parseReceipt(receipt)
  if (r === null) return { ok: false, reason: 'schema' }

  // 2. exact quotes, NFC-normalized on both sides.
  const normView = view.normalize('NFC')
  for (const q of [...r.failures.map((f) => f.evidence), ...r.key_output]) {
    if (q.length < MIN_QUOTE_LENGTH) return { ok: false, reason: 'quote' }
    if (!normView.includes(q.normalize('NFC'))) return { ok: false, reason: 'quote' }
  }

  // 3. exit consistency: exactly two decidable rules.
  if (r.exit.ok !== !isError) return { ok: false, reason: 'exit' }
  if (r.exit.code !== undefined) {
    const tail = normView.split('\n').slice(-TAIL_LINES).join('\n')
    const match = EXIT_CODE_PATTERNS.map((p) => p.exec(tail)).find((m) => m !== null)
    if (match === undefined || Number(match[1]) !== r.exit.code) return { ok: false, reason: 'exit' }
  }

  // 4. size gain against the view (the same text the quotes verified against).
  const ratio = opts?.minSavingsRatio ?? 0.5
  if (estimate(renderReceipt(r)) >= ratio * estimate(view)) return { ok: false, reason: 'size' }

  // 5. count consistency.
  if (r.counts && r.counts.fail !== r.failures.length) return { ok: false, reason: 'counts' }

  return { ok: true }
}
