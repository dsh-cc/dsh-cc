/**
 * Approval-prompt preview builders extracted from harness/driver.ts: argument
 * restoration from the session log, structured payload previews, permission
 * rule derivation, and settings-conflict detection. Pure functions over the
 * approval request and store view types — no I/O and no harness state.
 * @module @dsh-cc/tui/harness/approval-preview
 */

import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { canonicalizeHostname, isWebFetchRuleTool, ruleString } from '@dsh-cc/permission-rules'
import type { ApprovalPreview } from '../store.ts'

/**
 * Character cap for the pretty-printed raw-arguments preview of an approval
 * prompt (non-shell, non-file-edit tools).
 */
const ARGS_PREVIEW_MAX_CHARS = 500

/**
 * The restored arguments of an approved call: a parsed JSON object, or the
 * raw stored text when the arguments are not a JSON object (malformed JSON,
 * a bare scalar) so the preview degrades to the literal payload instead of
 * nothing.
 */
type RestoredArgs = { args: Record<string, unknown> } | { raw: string }

/**
 * Restore the approved call's arguments by scanning the session log backwards
 * for the `tool/call` event carrying the request's callId (`appendToolCall`
 * lands before the pre-execute approval, so the event is always present).
 * Returns undefined when the callId is missing, unpaired, or its arguments
 * are not stored as a string.
 */
function argsOf(req: ApprovalRequest): RestoredArgs | undefined {
  if (req.callId === undefined) return undefined
  const events = req.agent.session.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!
    if (event.type !== 'tool/call') continue
    if (String((event.data as { callId?: unknown }).callId) !== String(req.callId)) continue
    const raw = (event.data as { arguments?: unknown }).arguments
    if (typeof raw !== 'string') return undefined
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { args: parsed as Record<string, unknown> }
      }
    } catch {
      // Not JSON — fall through to the raw-text preview.
    }
    return { raw }
  }
  return undefined
}

/**
 * Build the approval prompt's structured payload preview from the restored
 * call arguments: shell-style `command` arguments map to the command kind;
 * Edit/MultiEdit/Write arguments map to per-file diffs (rendered with the
 * transcript's multi-hunk diff renderer); anything else pretty-prints the raw
 * arguments, and a failed recovery degrades to tool name + reason only.
 */
export function payloadOf(req: ApprovalRequest): ApprovalPreview {
  const restored = argsOf(req)
  if (restored === undefined) return { kind: 'none' }
  if ('raw' in restored) {
    return { kind: 'args', json: restored.raw.slice(0, ARGS_PREVIEW_MAX_CHARS) }
  }
  const args = restored.args
  if (typeof args.command === 'string') {
    return { kind: 'command', command: args.command }
  }
  const diffs = diffsOf(req.toolName.toLowerCase(), args)
  if (diffs !== undefined) return { kind: 'diff', diffs }
  return { kind: 'args', json: JSON.stringify(args, null, 2).slice(0, ARGS_PREVIEW_MAX_CHARS) }
}

/**
 * Extract per-file diffs from file-edit tool arguments, or undefined when the
 * arguments do not carry the expected shape (the preview then degrades to the
 * raw-arguments kind).
 */
function diffsOf(name: string, args: Record<string, unknown>): readonly { path: string; oldText: string | null; newText: string }[] | undefined {
  const path = typeof args.file_path === 'string' ? args.file_path : undefined
  if (name === 'write') {
    if (path === undefined || typeof args.content !== 'string') return undefined
    return [{ path, oldText: null, newText: args.content }]
  }
  if (name === 'edit') {
    if (path === undefined || typeof args.old_string !== 'string' || typeof args.new_string !== 'string') return undefined
    return [{ path, oldText: args.old_string, newText: args.new_string }]
  }
  if (name === 'multiedit' || name === 'multi_edit') {
    if (path === undefined || !Array.isArray(args.edits)) return undefined
    const diffs: { path: string; oldText: string | null; newText: string }[] = []
    for (const edit of args.edits) {
      if (edit === null || typeof edit !== 'object') continue
      const { old_string: oldText, new_string: newText } = edit as Record<string, unknown>
      if (typeof oldText !== 'string' || typeof newText !== 'string') continue
      diffs.push({ path, oldText, newText })
    }
    return diffs.length > 0 ? diffs : undefined
  }
  return undefined
}

/**
 * Derive the permission rule an "always" answer persists for the approved
 * call. Shell commands get a trailing-space first-word prefix rule
 * (`Bash(npm )` matches `npm install …` but not `npmx …` — the deliberate
 * trailing space replaces the colon-carrying `:*` legacy form, which would
 * otherwise embed the colon in the prefix and never match). Environment
 * variable prefixes (e.g., `FOO=bar`) are stripped before extracting the
 * first word, so `FOO=bar npm install` derives a rule for `npm`, not `FOO=bar`.
 * A WebFetch call derives a `WebFetch(domain:<host>)` rule on the exact host
 * from its `url` argument; every other tool gets a whole-tool rule. Undefined
 * (stay once-only) when nothing usable remains, e.g. a blank command.
 */
export function allowRuleOf(toolName: string, preview: ApprovalPreview | undefined): string | undefined {
  const name = toolName.trim()
  if (name === '') return undefined
  if (preview?.kind === 'command') {
    const command = preview.command.trim()
    if (command === '') return undefined
    
    // Strip environment variable prefixes (FOO=bar, FOO=bar BAZ=qux, etc.)
    // These are assignments that appear before the actual command.
    let remaining = command
    while (true) {
      const match = remaining.match(/^[A-Z_][A-Z0-9_]*=\S*\s+/)
      if (!match) break
      remaining = remaining.slice(match[0].length)
    }
    
    // Handle common command prefixes that should be stripped
    // sudo: run as root, but rule should match the actual command
    // npx/yarn: package runners, but rule should match the underlying tool
    const prefixesToStrip = ['sudo ', 'npx ', 'yarn ']
    for (const prefix of prefixesToStrip) {
      if (remaining.startsWith(prefix)) {
        remaining = remaining.slice(prefix.length)
        break // Only strip one prefix
      }
    }
    
    // For compound commands (&&, ||, ;), only consider the first segment
    // This is a simplification - the rule will match any command starting
    // with the first segment's command, which is the desired behavior.
    const firstSegment = remaining.split(/&&|\|\||;/)[0]?.trim() ?? ''
    
    const firstWord = firstSegment.split(/\s+/)[0] ?? ''
    if (firstWord === '') return undefined
    // ruleString escapes parens/backslashes so a subshell-opening first word
    // round-trips through parseRuleString.
    return ruleString(name, `${firstWord} `)
  }
  // WebFetch persists a domain rule on the exact host (not `*.host`): the
  // args preview carries the URL, whose hostname is canonicalized here. An
  // unparsable payload keeps today's whole-tool rule.
  if (isWebFetchRuleTool(name) && preview?.kind === 'args') {
    try {
      const parsed: unknown = JSON.parse(preview.json)
      const url = (parsed as Record<string, unknown>).url
      if (typeof url === 'string') {
        const hostname = canonicalizeHostname(url)
        if (hostname !== undefined) return ruleString('WebFetch', `domain:${hostname}`)
      }
    } catch {
      // Malformed JSON or missing url — fall through to the whole-tool rule.
    }
  }
  return name
}

/** Whether an error is the settings provider's revision-conflict rejection. */
export function isSettingsConflict(error: unknown): boolean {
  const candidate = error as { name?: unknown; code?: unknown } | null
  if (candidate === null || typeof candidate !== 'object') return false
  return candidate.code === 'SETTINGS_CONFLICT' || candidate.name === 'SettingsConflictError'
}
