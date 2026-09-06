/**
 * Parse Claude Code's event-to-matcher-group hook format into shared {@link MatcherGroup}s,
 * accepting all four executor kinds (`command`, `prompt`, `http`, `agent`). A hook with no
 * `type` is a command (CC's default). Plugin-root and project-directory substitutions are
 * applied to `command` strings at parse time.
 *
 * Parsing also SURFACES what would otherwise silently degrade ({@link HookConfigWarning}
 * warnings, safety-loop plan F6): unknown event keys, unknown group-level keys, and
 * per-handler keys outside the executor's allowlist; a `command` hook missing a string
 * `command` additionally lands in `skipped`. Nothing here is fatal except a malformed
 * matcher regex, which still throws so the bridge can reject the whole config.
 * @module @dsh-cc/hooks-claude-code/config
 */

import {
  matcherDiagnostic,
  type AgentHook,
  type CommandHook,
  type HookCommand,
  type HttpHook,
  type MatcherGroup,
  type PromptHook,
} from '@dsh-cc/hook-protocol'

const CLAUDE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'PostCompact',
  'SessionEnd',
  'StopFailure',
  'TaskCreated',
  'TeammateIdle',
  'Setup',
  'PostToolUseFailure',
  'SessionResume',
] as const

/**
 * The event keys this bridge parses — exposed (F7) so docs/doctor/tests can
 * compare their enumerations against the single source of truth,
 * {@link CLAUDE_EVENTS}.
 */
export const SUPPORTED_CLAUDE_EVENTS: readonly string[] = CLAUDE_EVENTS

/**
 * The handler keys each executor kind may legally carry (safety-loop plan F6):
 * `type`/`timeout` are shared, plus the kind's own wire fields. Anything else
 * on a hook object is silently dropped by the reference engines — here it
 * becomes a {@link HookConfigWarning} instead.
 */
const HANDLER_ALLOWED_KEYS: Record<string, ReadonlySet<string>> = {
  command: new Set(['type', 'timeout', 'command']),
  prompt: new Set(['type', 'timeout', 'prompt', 'model']),
  http: new Set(['type', 'timeout', 'url', 'headers', 'allowedEnvVars']),
  agent: new Set(['type', 'timeout', 'prompt', 'model']),
}

/** The only keys a matcher group may carry; anything else is read by no one. */
const GROUP_ALLOWED_KEYS = new Set(['matcher', 'hooks'])

/** A parsed CC config: event name → its matcher groups (any executor kind). */
export type ClaudeCodeHookConfig = Record<string, MatcherGroup[]>

/** A skipped malformed/unsupported hook, surfaced so the bridge can report it. */
export interface SkippedHook {
  event: string
  type: string
  /** Why the hook was dropped (`unknown hook type`, `malformed command`, …). */
  reason: string
}

/**
 * One parse-time degradation the bridge should log: handler keys outside the
 * executor's allowlist (`hookType` = the executor kind), unknown event keys
 * (`hookType: 'event'`, the event is silently dropped today), or unknown
 * group-level keys (`hookType: 'group'`; only `matcher`/`hooks` are read).
 * `matcher` is the group's pattern when present.
 */
export interface HookConfigWarning {
  event: string
  matcher?: string
  hookType: string
  keys: string[]
}

/** The outcome of parsing one config file: the runnable groups, what was skipped, and the F6 warnings. */
export interface ParsedClaudeConfig {
  config: ClaudeCodeHookConfig
  skipped: SkippedHook[]
  warnings: HookConfigWarning[]
}

/** Substitution variables applied to each `command` string at parse time. */
export interface SubstitutionVars {
  /** Replaces `${CLAUDE_PLUGIN_ROOT}` — the plugin's root dir. */
  pluginRoot?: string
  /** Replaces `${CLAUDE_PROJECT_DIR}` — the project root. */
  projectDir?: string
}

/** A plain (non-null, non-array) object, else undefined. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** A positive integer timeout in seconds, else undefined. */
function timeoutSecOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Apply `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}` substitution to a command string.
 * @param command - the raw command from config.
 * @param vars - the substitution values; a token whose variable is unset stays verbatim.
 * @returns the command with every occurrence of each set token replaced.
 */
export function substituteCommand(command: string, vars: SubstitutionVars): string {
  let out = command
  if (vars.pluginRoot !== undefined) out = out.split('${CLAUDE_PLUGIN_ROOT}').join(vars.pluginRoot)
  if (vars.projectDir !== undefined) out = out.split('${CLAUDE_PROJECT_DIR}').join(vars.projectDir)
  return out
}

/**
 * Parse one hook object into the matching {@link HookCommand}. Unknown `type`
 * values and malformed entries return `undefined` (dropped, not fatal). The
 * `command` kind applies substitution; the other (non-shell) kinds carry only
 * their wire fields plus a shared `timeoutSec`.
 * @param raw - the hook object from config.
 * @param vars - substitution values applied to a `command` value.
 * @returns the parsed hook, or `undefined` if malformed.
 */
function parseHook(raw: unknown, vars: SubstitutionVars): HookCommand | undefined {
  const hook = asObject(raw)
  if (!hook) return undefined
  const type = typeof hook.type === 'string' ? hook.type : 'command'
  const timeoutSec = timeoutSecOf(hook.timeout)
  if (type === 'command') {
    if (typeof hook.command !== 'string') return undefined
    const command: CommandHook = { command: substituteCommand(hook.command, vars) }
    if (timeoutSec !== undefined) command.timeoutSec = timeoutSec
    return command
  }
  if (type === 'prompt') {
    const prompt: PromptHook = { type: 'prompt', prompt: typeof hook.prompt === 'string' ? hook.prompt : '' }
    if (typeof hook.model === 'string') prompt.model = hook.model
    if (timeoutSec !== undefined) prompt.timeoutSec = timeoutSec
    return prompt
  }
  if (type === 'http') {
    if (typeof hook.url !== 'string') return undefined
    const http: HttpHook = { type: 'http', url: hook.url }
    if (typeof hook.headers === 'object' && hook.headers !== null && !Array.isArray(hook.headers)) {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(hook.headers)) if (typeof v === 'string') headers[k] = v
      if (Object.keys(headers).length > 0) http.headers = headers
    }
    if (Array.isArray(hook.allowedEnvVars)) {
      const names = hook.allowedEnvVars.filter((v): v is string => typeof v === 'string')
      if (names.length > 0) http.allowedEnvVars = names
    }
    if (timeoutSec !== undefined) http.timeoutSec = timeoutSec
    return http
  }
  if (type === 'agent') {
    const agent: AgentHook = { type: 'agent', prompt: typeof hook.prompt === 'string' ? hook.prompt : '' }
    if (typeof hook.model === 'string') agent.model = hook.model
    if (timeoutSec !== undefined) agent.timeoutSec = timeoutSec
    return agent
  }
  return undefined
}

/**
 * Parse either a settings `hooks` value or a bare `hooks.json` event map. Malformed entries are
 * ignored rather than failing boot; unsupported events are ignored before their groups are parsed,
 * and substitutions are applied to every surviving `command`. Matcher fields on UserPromptSubmit
 * and Stop are discarded because those events have no matcher subject. A matcher-bearing supported
 * runnable group with an invalid regex throws a `SyntaxError`, allowing the bridge to reject the
 * complete config before listener registration.
 *
 * Degrading-but-silent shapes are surfaced as {@link HookConfigWarning}s instead (F6): unknown
 * event keys, unknown group-level keys, per-handler keys outside the executor allowlist, and a
 * `command` hook missing its string `command` (which now also lands in `skipped`).
 *
 * @param raw - the parsed JSON config: a settings object with a `hooks` key, or the bare
 *   event map.
 * @param vars - substitution values applied to every surviving `command` (defaults to
 *   none).
 * @returns the runnable per-event groups, the skipped non-command (or command-less) hooks,
 *   and the parse warnings.
 */
export function parseClaudeCodeConfig(raw: unknown, vars: SubstitutionVars = {}): ParsedClaudeConfig {
  const config: ClaudeCodeHookConfig = {}
  const skipped: SkippedHook[] = []
  const warnings: HookConfigWarning[] = []
  // Accept either `{ hooks: { … } }` (a settings file) or the bare event map.
  const root = asObject(raw)
  const hooksMap = root ? asObject(root.hooks) ?? root : undefined
  if (!hooksMap) return { config, skipped, warnings }

  for (const event of CLAUDE_EVENTS) {
    const rawGroups = hooksMap[event]
    if (!Array.isArray(rawGroups)) continue
    const groups: MatcherGroup[] = []
    for (const rawGroup of rawGroups) {
      const group = asObject(rawGroup)
      if (!group || !Array.isArray(group.hooks)) continue
      // Group-level keys nobody reads (only matcher/hooks are known) surface as a warning.
      const groupKeys = Object.keys(group).filter((k) => !GROUP_ALLOWED_KEYS.has(k))
      if (groupKeys.length > 0) {
        warnings.push({
          event,
          ...typeof group.matcher === 'string' ? { matcher: group.matcher } : {},
          hookType: 'group',
          keys: groupKeys,
        })
      }
      const matcher = event === 'UserPromptSubmit' || event === 'Stop'
        ? undefined
        : typeof group.matcher === 'string' ? group.matcher : undefined
      const hooks: MatcherGroup['hooks'] = []
      for (const rawHook of group.hooks) {
        // Per-handler keys outside the executor's allowlist surface as a warning
        // (even when the handler itself turns out malformed — the keys are the
        // author's intent and belong in the log).
        const rawObj = asObject(rawHook)
        if (rawObj) {
          const hookType = typeof rawObj.type === 'string' ? rawObj.type : 'command'
          const allowed = HANDLER_ALLOWED_KEYS[hookType]
          if (allowed !== undefined) {
            const keys = Object.keys(rawObj).filter((k) => !allowed.has(k))
            if (keys.length > 0) {
              warnings.push({
                event,
                ...matcher !== undefined ? { matcher } : {},
                hookType,
                keys,
              })
            }
          }
        }
        const hook = parseHook(rawHook, vars)
        if (hook === undefined) {
          // A malformed hook vanishes from `config`; keep a trace in `skipped`
          // for every typed object (unknown executor kinds AND a command hook
          // missing its string `command` — previously the latter left no trace).
          const h = asObject(rawHook)
          const type = h && typeof h.type === 'string' ? h.type : 'command'
          const reason = !h
            ? 'malformed hook'
            : type === 'command'
              ? 'malformed command'
              : type === 'http'
                ? 'malformed http'
                : type === 'prompt' || type === 'agent' ? 'malformed hook' : 'unknown hook type'
          skipped.push({ event, type, reason })
          continue
        }
        hooks.push(hook)
      }
      if (hooks.length === 0) continue
      const diagnostic = matcherDiagnostic(matcher, 'claude-code')
      if (diagnostic !== undefined) throw new SyntaxError(`${diagnostic} on event ${JSON.stringify(event)}`)
      groups.push({
        ...matcher !== undefined ? { matcher } : {},
        hooks,
      })
    }
    if (groups.length > 0) config[event] = groups
  }

  // Unknown event keys are silently dropped pre-parse (typos included); surface
  // each one so the author learns nothing ran.
  for (const event of Object.keys(hooksMap)) {
    if (!(CLAUDE_EVENTS as readonly string[]).includes(event)) {
      warnings.push({ event, hookType: 'event', keys: [] })
    }
  }

  return { config, skipped, warnings }
}
