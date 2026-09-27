#!/usr/bin/env node
/**
 * codex-rescue-allow.mjs — the §3.2 pre-execute allow listener as a plugin
 * PreToolUse command hook (plan §9 S2/S3).
 *
 * Contract: on a byte-exact canonical rescue invocation emit exactly one
 * `hookSpecificOutput` allow verdict (the codec drops a top-level
 * `decision: "allow"` — only `permissionDecision` reaches the waterfall);
 * on EVERYTHING else — parse failure, non-Bash tool, non-match, disarmed
 * state, refusal, containment violation — emit NOTHING and exit 0, so the
 * command falls through to the unchanged existing permission flow. This
 * hook never denies (§3.2-f fail-closed-into-silence; the SessionStart
 * hook surfaces armed/refused state).
 *
 * Canonical anchors are derived per-match inside THIS process via the
 * shared canonical.mjs module (§5 one-source rule): a command hook runs
 * through a PATH-resolved interpreter, so the byte-pinned pair is the
 * realpath of this process's own interpreter executable and the realpath
 * of the plugin's own launcher script (see canonical.mjs for the
 * derivation). Both must sit outside the writable-root refusal set and
 * ambient BASH_ENV/ENV must be empty, or the bridge is disarmed for this
 * call.
 */
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { arming, inside, safeReal } from '../scripts/lib/canonical.mjs'
import { matchInvocation } from '../scripts/lib/argv.mjs'

const REASON = 'cc-codex-bridge: canonical rescue invocation (byte-pinned anchors, expansion-free)'

/** Silent pass: no stdout at all, exit 0 — the unchanged existing flow decides. */
const silent = () => process.exit(0)

let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk

let payload
try {
  payload = JSON.parse(input)
} catch {
  silent()
}
if (payload?.tool_name !== 'Bash') silent()
const command = payload?.tool_input?.command
if (typeof command !== 'string' || command === '') silent()

try {
  const arm = arming(typeof payload.cwd === 'string' ? payload.cwd : process.cwd(), { hookUrl: import.meta.url })
  if (!arm.armed) silent()
  const { node: NODE, launcher: LAUNCHER, cwd } = arm

  const match = matchInvocation(command, { node: NODE, launcher: LAUNCHER })
  if (!match.ok) silent()

  if (match.value.prompt.kind === 'prompt-file') {
    const raw = match.value.prompt.path
    const abs = isAbsolute(raw) ? raw : join(cwd ?? payload.cwd, raw)
    // §3.2-d matcher-side containment: realpath must land inside the session
    // workspace or the canonical tmpdir (a symlink escaping via realpath is
    // refused here; the launcher re-checks on the fd it opens).
    if (!inside(safeReal(abs), [cwd, safeReal(tmpdir())].filter((p) => p !== null))) silent()
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: REASON,
      },
    }) + '\n',
  )
} catch {
  silent()
}
