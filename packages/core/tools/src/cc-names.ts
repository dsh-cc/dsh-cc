/**
 * Claude Code → harness tool-name translation. CC-authored tool names flow
 * into `tools.restrict()` and other name-level seams through the preset and
 * skill-loading plugins; the harness registers its own authoritative,
 * mostly-lowercase global tool set, and a capitalized CC name handed verbatim
 * to `tools.restrict()` fails the whole session because restrict validates
 * names strictly. This module owns the canonical mapping between the two
 * vocabularies so plugins never hand-code the table.
 * @module @dsh-cc/tools/src/cc-names
 */

/**
 * The authoritative list of global tools the deepseek-harness registers,
 * observed from its web profile. This is the universe every CC name must be
 * translated INTO and the lenient policy uses it to distinguish a known
 * harness name from an unknown CC name. If the harness registry changes, the
 * {@link KNOWN_HARNESS_TOOLS} test fails loudly rather than silently drifting.
 */
const HARNESS_TOOLS = [
  'EnterWorktree', 'ExitWorktree', 'NotebookEdit', 'Sleep', 'ToolSearch',
  'ask_user_question', 'bash', 'create_goal', 'edit', 'exit_plan_mode',
  'get_goal', 'glob', 'grep', 'interrupt_agent', 'job_kill', 'job_list',
  'job_output', 'list_agents', 'ralph', 'read', 'read_image', 'send_message',
  'skill', 'subagent', 'subagent_fork', 'todo_write', 'update_goal',
  'web_fetch', 'web_search', 'workflow', 'write',
] as const

/**
 * The exact set of authoritative harness tool names {@link KNOWN_HARNESS_TOOLS}
 * is derived from, kept as a module-private source constant so the exported
 * set and the reverse index in {@link ccToolAliases} share one spelling.
 */
const HARNESS_TOOL_NAMES: readonly string[] = HARNESS_TOOLS

/**
 * The set of global tool names the deepseek-harness registers (see
 * {@link HARNESS_TOOLS}). The lenient translation policy uses it to pass a
 * known harness name through untouched instead of dropping it, since such a
 * name is already in the restrict vocabulary and needs no translation.
 */
export const KNOWN_HARNESS_TOOLS: ReadonlySet<string> = new Set(HARNESS_TOOL_NAMES)

/**
 * Claude Code tool name → harness tool name(s). One CC tool may answer through
 * several harness tools (e.g. `Read` covers both `read` and `read_image`), so
 * each value is a list; an entry that has no distinct harness equivalent maps
 * to its own capitalized form (the harness exposes it under that exact name,
 * e.g. `NotebookEdit`).
 *
 * Deliberately NOT mapped (and hence rejected-or-dropped by
 * {@link translateToolNames} depending on policy):
 * - `LS` — legacy Claude Code alias with no harness equivalent.
 * - `EnterPlanMode` — the harness has no plan-mode entry point (model-driven
 *   plan mode is not a tool).
 * - `CronCreate`/`CronDelete`/`CronList` — lifecycle utilities with no harness
 *   equivalent in the authoritative global set.
 * - `mcp__*` names — namespace-qualified MCP paths; the harness exposes MCP
 *   tools under their own names, which a caller should list explicitly.
 */
export const CC_TO_HARNESS_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Read: ['read', 'read_image'],
  Write: ['write'],
  Edit: ['edit'],
  MultiEdit: ['edit'],
  NotebookEdit: ['NotebookEdit'],
  Bash: ['bash'],
  BashOutput: ['job_output'],
  KillBash: ['job_kill'],
  Grep: ['grep'],
  Glob: ['glob'],
  WebFetch: ['web_fetch'],
  WebSearch: ['web_search'],
  TodoWrite: ['todo_write'],
  Task: ['subagent', 'subagent_fork'],
  Skill: ['skill'],
  AskUserQuestion: ['ask_user_question'],
  ExitPlanMode: ['exit_plan_mode'],
  Workflow: ['workflow'],
  Sleep: ['Sleep'],
  ToolSearch: ['ToolSearch'],
  EnterWorktree: ['EnterWorktree'],
  ExitWorktree: ['ExitWorktree'],
} satisfies Record<string, readonly string[]>

/**
 * Translation strictness. Strict callers run at config/agent load time over
 * trusted, developer-authored tool lists and want fail-fast: an unknown name
 * passes through verbatim so `tools.restrict()` itself rejects it loudly.
 * Lenient callers run on user/model-driven data where a fatal throw over one
 * unknown name would kill the whole session, so unknown names are dropped with
 * a diagnostic instead.
 */
export type ToolNameTranslationPolicy = 'strict' | 'lenient'

/**
 * Strip a trailing parenthesized argument specification from a CC name, e.g.
 * `Bash(git status)` → `Bash` and `WebFetch(domain:example.com)` → `WebFetch`.
 * `tools.restrict()` is name-level only, so stripping deliberately widens a
 * name+args constraint to name-level — this is a decision, not an accident: a
 * name-level restrict cannot honor a per-args constraint, and the alternative
 * (keeping the arg-spec) would produce a name `tools.restrict()` rejects.
 * @param name - the raw CC name as it appears in the tool list.
 * @returns the name with any trailing `(...)` argument specification removed.
 */
function stripArgSpec(name: string): string {
  const paren = name.indexOf('(')
  return paren === -1 ? name : name.slice(0, paren)
}

/**
 * Translate a list of Claude Code tool names into harness tool names for a
 * `tools.restrict()`-style name-level filter.
 *
 * Each entry is (optionally) stripped of its trailing arg-spec (see
 * {@link stripArgSpec}), then translated:
 * - A name in {@link CC_TO_HARNESS_TOOLS} expands to every mapped harness name.
 * - Under `'strict'`, every other name passes through VERBATIM (unknown names
 *   then fail loudly on `tools.restrict()`'s own strict validation — fail-fast
 *   is intended at config/agent load time).
 * - Under `'lenient'`, a name in {@link KNOWN_HARNESS_TOOLS} passes through,
 *   and any other name is dropped with a diagnostic via `onDiagnostic`, so a
 *   single unknown or model-invented name never kills the session.
 *
 * Results are deduplicated preserving first-occurrence order.
 *
 * @param names - the tool-name list to translate.
 * @param policy - `'strict'` (trusted config, fail-fast) or `'lenient'` (user/model data, drop unknown).
 * @param onDiagnostic - invoked for each dropped name (and for an empty lenient result); default no-op.
 * @returns the translated harness-name list, or `undefined` under `'lenient'`
 *   when every input was dropped (meaning "no restriction"). Under `'strict'`,
 *   always returns an array — an empty input yields an empty array copy, never `undefined`.
 */
export function translateToolNames(
  names: readonly string[],
  policy: ToolNameTranslationPolicy,
  onDiagnostic: (message: string) => void = (): void => {},
): string[] | undefined {
  const diagnose = onDiagnostic
  const results: string[] = []
  for (const rawName of names) {
    const name = stripArgSpec(rawName)
    const mapped = CC_TO_HARNESS_TOOLS[name]
    if (mapped !== undefined) {
      for (const harnessName of mapped) {
        if (!results.includes(harnessName)) results.push(harnessName)
      }
      continue
    }
    if (policy === 'strict') {
      if (!results.includes(name)) results.push(name)
      continue
    }
    if (KNOWN_HARNESS_TOOLS.has(name)) {
      if (!results.includes(name)) results.push(name)
      continue
    }
    diagnose(`dropping unknown tool name "${name}" from CC tool list`)
  }
  if (policy === 'lenient') {
    if (results.length === 0) {
      diagnose('dropping all CC tool names — resulting tool restriction is empty')
      return undefined
    }
  }
  return [...results]
}

/**
 * The distinct names one harness tool answers to for match-time comparison
 * (permission rules, hook matchers). Returns the input name itself plus every
 * CC name whose mapping includes the input, derived from
 * {@link CC_TO_HARNESS_TOOLS} via a reverse index — never a hand-written second
 * table. When the input IS a CC name found in the map, returns the CC name
 * first followed by its mapped harness names.
 *
 * Examples: `'read'` → `['read', 'Read']`; `'read_image'` → `['read_image',
 * 'Read']`; `'bash'` → `['bash', 'Bash']`; `'edit'` → `['edit', 'Edit',
 * 'MultiEdit']`; `'Bash'` → `['Bash', 'bash']`; `'pwsh'` → `['pwsh']`.
 * @param name - a harness tool name or Claude Code tool name.
 * @returns every distinct name the harness tool is matched by, input first.
 */
export function ccToolAliases(name: string): readonly string[] {
  const mapped = CC_TO_HARNESS_TOOLS[name]
  if (mapped !== undefined) return [name, ...mapped]
  const aliases = [name]
  for (const [ccName, harnessNames] of Object.entries(CC_TO_HARNESS_TOOLS)) {
    if (harnessNames.includes(name) && !aliases.includes(ccName)) aliases.push(ccName)
  }
  return aliases
}

/**
 * The CC canonical name for a harness tool — the first CC name in
 * {@link CC_TO_HARNESS_TOOLS} whose mapping contains the input. This is the
 * inverse of {@link translateToolNames} for the name-identity direction CC-facing
 * surfaces need (hook payloads, permissions reports): a hook script written for
 * Claude Code expects the CC spelling, not the harness's lowercase one.
 *
 * Examples: `'read'` → `'Read'`; `'read_image'` → `'Read'`; `'edit'` →
 * `'Edit'`; `'subagent'` → `'Task'`; `'subagent_fork'` → `'Task'`; `'Bash'` →
 * `'Bash'`; `'pwsh'` → `'pwsh'` (no CC alias, unchanged); `'ralph'` →
 * `'ralph'` (harness-only, unchanged).
 * @param name - a harness tool name (lowercase) or an already-CC canonical name.
 * @returns the first CC name matching the input, or the input unchanged when no
 *   CC alias exists (including when the input is itself an existing CC name).
 */
export function ccCanonicalToolName(name: string): string {
  for (const [ccName, harnessNames] of Object.entries(CC_TO_HARNESS_TOOLS)) {
    if (harnessNames.includes(name)) return ccName
  }
  return name
}
