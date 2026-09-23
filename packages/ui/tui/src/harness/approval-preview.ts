/**
 * Approval-prompt preview builders extracted from harness/driver.ts: argument
 * restoration from the session log, structured payload previews, permission
 * rule derivation, and settings-conflict detection. Pure functions over the
 * approval request and store view types — no I/O and no harness state.
 * @module @dsh-cc/tui/harness/approval-preview
 */

import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import {
  canonicalizeHostname,
  contentMatches,
  isWebFetchRuleTool,
  parseRuleString,
  ruleString,
} from '@dsh-cc/permission-rules'
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
 * Result of allow-rule derivation: a persisted rule string, a deliberate
 * never-persist tool (EnterWorktree — CC v2.1.206 parity, the outside-path ask
 * must always fire), or a call no safe rule could be derived for.
 */
export type AllowRuleResult =
  | { kind: 'rule'; rule: string }
  | { kind: 'never-persist' }
  | { kind: 'underivable' }

/**
 * The restored call arguments when they parsed as a JSON object (the shape
 * rule synthesis reads `url` etc. from), else undefined. Attached to the
 * approval entry at push time so synthesis sees untruncated args while the
 * display preview stays capped.
 */
export function restoredArgsOf(req: ApprovalRequest): Record<string, unknown> | undefined {
  const restored = argsOf(req)
  return restored !== undefined && 'args' in restored ? restored.args : undefined
}

/**
 * Derive the permission rule an "always" answer persists for the approved
 * call. Shell commands get a trailing-space first-word prefix rule
 * (`Bash(npm )` matches `npm install …` but not `npmx …` — the deliberate
 * trailing space replaces the colon-carrying `:*` legacy form). The stripped
 * first-word rule is verified to content-match the RAW command; on mismatch
 * (env prefixes, stripped wrappers) it falls back to a raw prefix — the
 * original command from offset 0 through the end of the stripped first word
 * plus a trailing space (`sudo FOO=bar npm x` → `Bash(sudo FOO=bar npm )`) —
 * which matches by construction. A WebFetch call derives a
 * `WebFetch(domain:<host>)` rule on the exact host from its UNTRUNCATED `url`
 * argument (underivable — never a whole-tool persistent fallback — when the
 * URL is missing or unparseable); every other tool gets a whole-tool rule.
 */
export function allowRuleOf(
  toolName: string,
  preview: ApprovalPreview | undefined,
  args?: Record<string, unknown>,
): AllowRuleResult {
  const name = toolName.trim()
  if (name === '') return { kind: 'underivable' }
  // WS-6: EnterWorktree's outside-worktrees-dir ask must ALWAYS fire (CC
  // v2.1.206 parity) — never persist a rule for it, so "don't ask again"
  // cannot suppress later prompts (bypassPermissions is the only bypass).
  if (name === 'EnterWorktree') return { kind: 'never-persist' }
  if (preview?.kind === 'command') {
    const command = preview.command.trim()
    if (command === '') return { kind: 'underivable' }

    // Strip leading env assignments (FOO=bar …) and common wrapper prefixes
    // (sudo/npx/yarn) repeatedly, so the first word of the fully stripped
    // remainder is the underlying command.
    const prefixesToStrip = ['sudo ', 'npx ', 'yarn ']
    let remaining = command
    while (true) {
      const env = remaining.match(/^[A-Z_][A-Z0-9_]*=\S*\s+/)
      if (env !== null) {
        remaining = remaining.slice(env[0].length)
        continue
      }
      const wrapper = prefixesToStrip.find(prefix => remaining.startsWith(prefix))
      if (wrapper === undefined) break
      remaining = remaining.slice(wrapper.length)
    }

    // For compound commands (&&, ||, ;), only consider the first segment
    // This is a simplification - the rule will match any command starting
    // with the first segment's command, which is the desired behavior.
    const firstSegment = remaining.split(/&&|\|\||;/)[0]?.trim() ?? ''

    const firstWord = firstSegment.split(/\s+/)[0] ?? ''
    if (firstWord === '') return { kind: 'underivable' }
    // ruleString escapes parens/backslashes so a subshell-opening first word
    // round-trips through parseRuleString.
    const strippedRule = ruleString(name, `${firstWord} `)
    // Verify the stripped rule content-matches the RAW command; the raw
    // subject is what evaluation matches, so a stripped derivation that no
    // longer covers the raw command would persist a dead rule.
    try {
      const parsed = parseRuleString(strippedRule)
      if (parsed.matcher !== undefined && contentMatches(parsed.matcher, command)) {
        return { kind: 'rule', rule: strippedRule }
      }
    } catch {
      // Not parseable — fall through to the raw-prefix fallback.
    }
    // Raw-prefix fallback: slice the original command from 0 through the end
    // of the stripped first word (its offset inside the raw command) plus a
    // trailing space, so the prefix matches the raw command by construction.
    const stripOffset = command.length - remaining.length
    const leading = remaining.length - remaining.trimStart().length
    const end = Math.min(command.length, stripOffset + leading + firstWord.length)
    // Trailing space only when something follows the first word — a bare
    // `yarn build` must still match its own prefix rule.
    const tail = command.slice(end)
    return { kind: 'rule', rule: ruleString(name, tail === '' ? command.slice(0, end) : `${command.slice(0, end)} `) }
  }
  // WebFetch persists a domain rule on the exact host (not `*.host`) derived
  // from the untruncated restored args (display args previews are truncated).
  // An unparsable/missing URL is underivable — no silent whole-tool
  // broadening of a narrow intent.
  if (isWebFetchRuleTool(name)) {
    let url = typeof args?.url === 'string' ? args.url : undefined
    if (url === undefined && preview?.kind === 'args') {
      try {
        const parsed: unknown = JSON.parse(preview.json)
        const candidate = (parsed as Record<string, unknown>).url
        if (typeof candidate === 'string') url = candidate
      } catch {
        // Malformed JSON — stays underivable.
      }
    }
    const hostname = url === undefined ? undefined : canonicalizeHostname(url)
    return hostname === undefined ? { kind: 'underivable' } : { kind: 'rule', rule: ruleString('WebFetch', `domain:${hostname}`) }
  }
  return { kind: 'rule', rule: name }
}

/** Whether an error is the settings provider's revision-conflict rejection. */
export function isSettingsConflict(error: unknown): boolean {
  const candidate = error as { name?: unknown; code?: unknown } | null
  if (candidate === null || typeof candidate !== 'object') return false
  return candidate.code === 'SETTINGS_CONFLICT' || candidate.name === 'SettingsConflictError'
}
