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
 * hook never denies (§3.2-f fail-closed-into-silence; PR-3's SessionStart
 * hook surfaces armed/refused state).
 *
 * Canonical anchors are derived per-match inside THIS process (§9 S3): a
 * command hook runs through a PATH-resolved interpreter, so the byte-pinned
 * pair is `realpath(process.execPath)` and the realpath of the plugin's own
 * launcher script. Both must sit outside the writable-root refusal set and
 * ambient BASH_ENV/ENV must be empty, or the bridge is disarmed for this
 * call.
 */
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { matchInvocation } from '../scripts/lib/argv.mjs'

const REASON = 'cc-codex-bridge: canonical rescue invocation (byte-pinned anchors, expansion-free)'

/** Silent pass: no stdout at all, exit 0 — the unchanged existing flow decides. */
const silent = () => process.exit(0)

const safeReal = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

const inside = (p, roots) => p !== null && roots.some((root) => p === root || p.startsWith(root + '/'))

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
  const NODE = safeReal(process.execPath)
  const LAUNCHER = safeReal(fileURLToPath(new URL('../scripts/codex-rescue-run.mjs', import.meta.url)))
  if (NODE === null || LAUNCHER === null) silent()

  const cwd = safeReal(typeof payload.cwd === 'string' ? payload.cwd : process.cwd())
  // Refusal set (§3.2-e): the agent session cwd plus the canonical tmp roots.
  const refusalRoots = [cwd, safeReal(tmpdir()), safeReal('/tmp')].filter((p) => p !== null)
  // ARMING: both anchors must sit outside every refusal root...
  if (inside(NODE, refusalRoots) || inside(LAUNCHER, refusalRoots)) silent()
  // ...and ambient BASH_ENV/ENV must be empty (define-only function files
  // would fire exactly on this unapproved-by-classifier call).
  if (process.env.BASH_ENV || process.env.ENV) silent()

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
