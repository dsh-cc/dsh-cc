#!/usr/bin/env node
/**
 * grok-review-context.mjs — the SessionStart context hook.
 *
 * Contract: read the stdin JSON payload; on ANY failure (parse error, bad
 * shape, derivation throw) stay silent and exit 0. On success emit exactly
 * one line `{"hookSpecificOutput":{"hookEventName":"SessionStart",
 * "additionalContext": <text>}}` where the text is the armed block (the
 * exact canonical invocation to type) or the refused block (machine reason
 * in plain words). Arming comes from the shared canonical.mjs — the same
 * derivation the PreToolUse allow hook applies per call.
 */
import { armedText, arming, refusedText } from '../scripts/lib/canonical.mjs'

let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk

let payload
try {
  payload = JSON.parse(input)
} catch {
  process.exit(0)
}
const cwd = typeof payload?.cwd === 'string' && payload.cwd !== '' ? payload.cwd : process.cwd()

let text
try {
  const arm = arming(cwd, { hookUrl: import.meta.url })
  text = arm.armed ? armedText(arm) : refusedText(arm.reason)
} catch {
  process.exit(0)
}

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }) + '\n',
)
process.exit(0)
