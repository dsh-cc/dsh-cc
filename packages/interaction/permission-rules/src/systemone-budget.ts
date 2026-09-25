/**
 * Script-aware token budget for the System One lanes (design doc
 * 2026-09-25 §Fix A). The gateway bills tokens; the old gauge path capped in
 * characters (`window × 3`), so CJK-dense states blew the truncation
 * sentinel ~7× earlier than predicted. Pure, no deps.
 *
 * Calibration evidence (2026-09-25, orchestrix `/v1/systemone`,
 * `laya-rl-agent`):
 *
 * | Fixture                         | chars | tokens | tok/char marginal      |
 * | ------------------------------- | ----- | ------ | ---------------------- |
 * | state `"{}"` (envelope probe)   | 2     | 40     | — (envelope+question)  |
 * | ASCII word text, JSON-wrapped   | 1231  | 278    | ≈0.19                  |
 * | CJK repeated sentence           | 583   | 891    | ≈1.46 → weight 1.5     |
 * | realistic mixed bash+CJK        | 93    | 85     | sanity                 |
 * | bash-dense (quotes/pipes/braces)| 874   | 413    | ≈0.43                  |
 * | base64 payload 600              | 648   | 496    | ≈0.71 (known under-est)|
 *
 * Posture: the estimator is a lower-bound heuristic; underestimates land on
 * the unchanged `isTruncated` sentinel (today's safe behavior), never past
 * it. Base64/dense-alnum payloads are a documented underestimation class.
 *
 * @module @dsh-cc/permission-rules/systemone-budget
 */

/** Request envelope + state JSON keys; the question is counted separately. */
export const S1_ENVELOPE_TOKENS = 4
/** Estimator slack vs the truncation sentinel. */
export const S1_MARGIN_TOKENS = 16
/** Below this state budget the lane skips the wire call (honest ask/pass). */
export const MIN_STATE_TOKENS = 64

/** Per-codepoint weights (doc-frozen): word 0.22, digit 0.45, punct 0.45, space 0.15, non-ASCII 1.5. */
function codepointWeight(codePoint: string): number {
  if (codePoint.codePointAt(0)! > 0x7f) return 1.5
  if (/\s/.test(codePoint)) return 0.15
  if (/[a-zA-Z]/.test(codePoint)) return 0.22
  return 0.45 // digits + punctuation/symbols
}

/**
 * Lower-bound token estimate over CODEPOINTS (a surrogate pair iterates
 * once at the 1.5 non-ASCII weight — never split).
 */
export function estimateSystemOneTokens(text: string): number {
  let tokens = 0
  for (const codePoint of text) tokens += codepointWeight(codePoint)
  return tokens
}

/**
 * Middle-elision cut to a token budget: keep the head `headRatio` share and
 * the remaining tail, joined by `marker` (its tokens come out of the
 * budget). Codepoint-safe (never splits a surrogate pair). Under budget ⇒
 * the input verbatim.
 */
export function capMiddleToTokenBudget(text: string, budgetTokens: number, marker: string, headRatio = 2 / 3): string {
  if (budgetTokens <= 0) return ''
  if (estimateSystemOneTokens(text) <= budgetTokens) return text
  const markerTokens = estimateSystemOneTokens(marker)
  const keptTokens = Math.max(0, budgetTokens - markerTokens)
  const headBudget = keptTokens * headRatio
  const tailBudget = keptTokens * (1 - headRatio)
  let spent = 0
  let headEnd = 0
  for (const codePoint of text) {
    const weight = codepointWeight(codePoint)
    if (spent + weight > headBudget) break
    spent += weight
    headEnd += codePoint.length
  }
  let tailStart = text.length
  spent = 0
  for (let index = text.length; index > headEnd; ) {
    // Step back one CODEPOINT (not UTF-16 unit) so pairs stay intact.
    let start = index - 1
    while (start > headEnd && (text.codePointAt(start)! & 0xfc00) === 0xdc00) start -= 1
    const weight = codepointWeight(text.slice(start, index))
    if (spent + weight > tailBudget) break
    spent += weight
    tailStart = start
    index = start
  }
  return `${text.slice(0, headEnd)}${marker}${text.slice(tailStart)}`
}
