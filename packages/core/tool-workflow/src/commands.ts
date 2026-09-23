/**
 * Session-start mounting of saved workflows as `/<name>` slash commands
 * (plan §3.1). Scans the `savedWorkflowDirs` pair (project shadows user),
 * parses each `*.js` candidate with the package's strict meta parser, checks
 * the result against a local replication of the engine's meta shape rules,
 * and registers the survivors on the commands seam. Parse-fail, shape-fail,
 * name-fail, and collision skips are per-command: one warn each, siblings
 * never poisoned. A workflow stays reachable via the tool's `name`/`scriptPath`
 * even when its command is skipped.
 * @module @dsh-cc/tool-workflow/commands
 */

import { readdirSync, readFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { helpable } from '@dsh-cc/command-usage'
import { savedWorkflowDirs } from './launch.ts'
import { extractInlineMeta } from './meta-extract.ts'

/** Registry name rule (harness command registries; deepseek-harness `commands/src/index.ts`). */
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u

/**
 * Minimal duck-typed commands seam — the cc-plugin-loader posture
 * (`cc-plugin-loader/src/index.ts` resolves the same seam via `ctx.get`).
 * Deliberately NOT a package dependency on cc-plugin-loader or
 * @deepseek-ai/dsh-commands: the seam surface used here is
 * `register(definition) → disposer`.
 */
export interface CommandsSeamLike {
  register(definition: SavedWorkflowCommandDefinition): () => void
}

/** The minimal typed command definition this scan registers. */
export interface SavedWorkflowCommandDefinition {
  readonly name: string
  readonly description: string
  readonly handler: (invocation: SavedWorkflowCommandInvocation) => SavedCommandResult | Promise<SavedCommandResult>
}

/**
 * Minimal structural view of the upstream command invocation (duck-typed on
 * purpose, mirroring cc-plugin-loader's `CommandInvocationLike`).
 */
export interface SavedWorkflowCommandInvocation {
  /** The agent the command was executed against; the prompt injection target. */
  readonly agent: { followup(message: unknown): unknown }
  /** Raw argument text following the command name (empty when none given). */
  readonly rawInput: string
}

/** Result shape this scan's command handlers return (plugin-loader precedent). */
export type SavedCommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/**
 * The slice of the cordis context the scan reads. Structural so the real
 * `Context` satisfies it and tests can pass a stub; never imports cordis.
 */
export interface WorkflowCommandsContext {
  get(key: string): unknown
  logger: { warn(message: string): void }
}

/**
 * Local replication of the engine's meta shape rules.
 *
 * SOURCE OF TRUTH: deepseek-harness
 * `packages/workflow/workflow-worker-thread/src/meta.ts:13-44`
 * (`validateMetaShape`); kept in sync by the contract test in
 * `tests/saved-commands.spec.ts`, which pins this function's verdicts against
 * the harness `validateMeta` for a shared table of meta values.
 *
 * `extractInlineMeta` validates literal-ness only and returns `meta: unknown`,
 * so this check rejects: non-object meta, unknown fields, non-string/empty
 * `name`/`description`, mistyped `whenToUse`, and malformed `phases` entries
 * (unknown entry fields, non-string/empty `title`, mistyped
 * `detail`/`provider`/`model`). Without it a parse-ok/shape-invalid file would
 * mount a command whose every invocation the engine refuses — a
 * listed-but-always-broken command (plan §3.1).
 */
export function metaShapeViolations(meta: unknown): string[] {
  const violations: string[] = []
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return ['meta must be an object']
  }
  const record = meta as Record<string, unknown>
  const known = new Set(['name', 'description', 'whenToUse', 'phases'])
  for (const key of Object.keys(record)) {
    if (!known.has(key)) violations.push(`meta.${key} is not a recognized field (name/description/whenToUse/phases)`)
  }
  if (typeof record.name !== 'string' || record.name.length === 0) violations.push('meta.name must be a non-empty string')
  if (typeof record.description !== 'string' || record.description.length === 0) violations.push('meta.description must be a non-empty string')
  if (record.whenToUse !== undefined && typeof record.whenToUse !== 'string') violations.push('meta.whenToUse must be a string')
  if (record.phases !== undefined) {
    if (!Array.isArray(record.phases)) {
      violations.push('meta.phases must be an array')
    } else {
      record.phases.forEach((phase, index) => {
        if (typeof phase !== 'object' || phase === null || Array.isArray(phase)) {
          violations.push(`meta.phases[${index}] must be an object`)
          return
        }
        const entry = phase as Record<string, unknown>
        for (const key of Object.keys(entry)) {
          if (!['title', 'detail', 'provider', 'model'].includes(key)) violations.push(`meta.phases[${index}].${key} is not a recognized field`)
        }
        if (typeof entry.title !== 'string' || entry.title.length === 0) violations.push(`meta.phases[${index}].title must be a non-empty string`)
        if (entry.detail !== undefined && typeof entry.detail !== 'string') violations.push(`meta.phases[${index}].detail must be a string`)
        if (entry.provider !== undefined && typeof entry.provider !== 'string') violations.push(`meta.phases[${index}].provider must be a string`)
        if (entry.model !== undefined && typeof entry.model !== 'string') violations.push(`meta.phases[${index}].model must be a string`)
      })
    }
  }
  return violations
}

/**
 * Dispatch the composed instruction as a user prompt on the invoking agent —
 * the plugin-loader's `dispatchCommandPrompt` pattern verbatim, including its
 * thenable/rejection folding (a synchronous followup throw and a rejected
 * schedule both fold into an error result, never an escaping throw).
 */
function dispatchCommandPrompt(invocation: SavedWorkflowCommandInvocation, text: string): SavedCommandResult | Promise<SavedCommandResult> {
  let scheduled: unknown
  try {
    scheduled = invocation.agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
  } catch (error) {
    return { kind: 'error', text: `could not dispatch command prompt: ${String(error)}` }
  }
  if (scheduled === null || scheduled === undefined || typeof (scheduled as { then?: unknown }).then !== 'function') {
    return { kind: 'success' }
  }
  return Promise.resolve(scheduled).then(
    () => ({ kind: 'success' } as const),
    (error: unknown) => ({ kind: 'error', text: `could not dispatch command prompt: ${String(error)}` }),
  )
}

/**
 * One process-level mount of the scanned command set, shared across session
 * fibers. `fingerprint` identifies the scanned set; `holders` is the number
 * of live plugin fibers that adopted this mount.
 */
interface ProcessMount {
  fingerprint: string
  disposers: (() => void)[]
  holders: number
}

/**
 * Process-level mounts keyed by the commands seam instance (a host-plane
 * singleton in production; fresh stubs per test give isolation). The harness
 * `CommandRuntime` scopes its layers by the SERVICE's construction ctx, so
 * every registration through the shared service lands in the GLOBAL layer —
 * while this plugin's apply runs once per session fiber. Naive per-fiber
 * registration would collide on every same-process session switch, and a
 * torn-down fiber's disposers would yank commands a surviving fiber still
 * uses. Instead: the first fiber registers; a later fiber with an identical
 * scan adopts the mount silently; a changed scan remounts (the registry is
 * live — the TUI re-lists on `commands/change`); teardown is refcounted so
 * only the last holder unregisters.
 */
const processMounts = new WeakMap<CommandsSeamLike, ProcessMount>()

/** One mountable command: the definition inputs plus its identity for fingerprints. */
interface ScannedCommand {
  name: string
  path: string
  description: string
}

/** Release one holder's claim; the last holder out unregisters the mount. */
function releaseMount(commands: CommandsSeamLike, mount: ProcessMount): void {
  if (mount.holders <= 0) return // already replaced by a remount
  if (--mount.holders === 0) disposeMount(commands, mount)
}

function disposeMount(commands: CommandsSeamLike, mount: ProcessMount): void {
  mount.holders = 0
  const disposers = mount.disposers
  mount.disposers = []
  for (const dispose of disposers) dispose()
  if (processMounts.get(commands) === mount) processMounts.delete(commands)
}

/**
 * Scan the saved-workflow directories (project first, so it shadows the user
 * directory on a name collision — silently, matching `resolveScriptSource`).
 * Returns mountable commands plus one warn line per skipped file. Never
 * throws: an unreadable directory (other than ENOENT, which just means
 * nothing saved there) degrades to a warn line.
 */
function scanSavedWorkflows(cwd: string): { commands: ScannedCommand[]; fingerprint: string; warnings: string[] } {
  const commands: ScannedCommand[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const dir of savedWorkflowDirs(cwd)) {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      // ENOENT = nothing saved there; anything else (EPERM/EACCES/…) on a
      // present directory must not vanish silently.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        warnings.push(`tool-workflow: saved workflow directory "${dir}" unreadable: ${String(error)}`)
      }
      continue
    }
    for (const entry of entries) {
      // Non-`.js` directory entries are ignored (plan §3.1).
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue
      const name = basename(entry.name, '.js')
      const path = join(dir, entry.name)
      if (seen.has(name)) continue // project shadows user (first dir wins)
      if (!COMMAND_NAME.test(name)) {
        warnings.push(`tool-workflow: saved workflow "${path}" skipped — file name does not match the command-name rule ${COMMAND_NAME} (rename the file to mount it)`)
        continue
      }
      seen.add(name)
      let script: string
      try {
        script = readFileSync(path, 'utf8')
      } catch (error) {
        warnings.push(`tool-workflow: saved workflow "${path}" skipped — unreadable: ${String(error)}`)
        continue
      }
      const parsed = extractInlineMeta(script)
      if (!parsed.ok) {
        warnings.push(`tool-workflow: saved workflow "${path}" skipped — invalid meta (parse check): ${parsed.error}`)
        continue
      }
      const violations = metaShapeViolations(parsed.meta)
      if (violations.length > 0) {
        warnings.push(`tool-workflow: saved workflow "${path}" skipped — invalid meta (shape check): ${violations.join('; ')}`)
        continue
      }
      const meta = parsed.meta as { name: string; description: string }
      commands.push({ name, path, description: meta.description })
    }
  }
  const fingerprint = commands.map(c => `${c.name}@${c.path}@${c.description}`).sort().join('\n')
  return { commands, fingerprint, warnings }
}

/** Register one scanned command; per-command failure never aborts siblings. */
function registerScanned(ctx: WorkflowCommandsContext, seam: CommandsSeamLike, scanned: ScannedCommand, disposers: (() => void)[]): void {
  const { name, path } = scanned
  const run = (invocation: SavedWorkflowCommandInvocation): SavedCommandResult | Promise<SavedCommandResult> =>
    dispatchCommandPrompt(
      invocation,
      `Run the workflow named \`${name}\` via the workflow tool. User arguments, verbatim, are: ${invocation.rawInput}`,
    )
  // `helpable()` gives `/<name> help` for free: the meta description plus
  // the mounted file path (the staleness antidote — help names exactly
  // which file won). Cast bridges the duck-typed seam to the harness
  // descriptor shape the helper targets (same posture as cc-plugin-loader).
  const definition = helpable(
    { name, description: scanned.description, handler: run as never },
    { notes: [`Mounted from file: ${path}`] },
  ) as unknown as SavedWorkflowCommandDefinition
  try {
    disposers.push(seam.register(definition))
  } catch (error) {
    if (error instanceof TypeError) {
      // normalizeDefinition's own validation (e.g. a whitespace-only
      // description passes the engine's shape rules but is refused here).
      ctx.logger.warn(`tool-workflow: saved workflow command "/${name}" skipped — invalid command definition: ${String(error)}`)
      return
    }
    // Registry-scoped collision (harness registries throw on duplicates):
    // the already-registered command is the winner; skip-warn this one
    // (plugin-loader precedent).
    ctx.logger.warn(`tool-workflow: saved workflow command "/${name}" skipped — the name is already registered (existing registration wins; rename the file to mount it): ${String(error)}`)
  }
}

/**
 * Scan the saved-workflow directories and mount each valid `*.js` file as a
 * `/<name>` slash command (name = file basename; file name governs lookup, per
 * the core slice's disagreement rule). Returns one release disposer for the
 * caller to fold into its effect-scoped teardown.
 *
 * The command body never inlines the script: the handler composes a fixed
 * instruction with the invocation's raw input passed through verbatim in the
 * args slot, and the tool's `name` resolution does the fetch — the file stays
 * the single source of truth.
 *
 * Mounts are process-level and shared across session fibers (see
 * `processMounts`): an identical scan adopts the live mount silently (no warn
 * spam on session switch), a changed scan remounts, and only the last
 * holder's teardown unregisters. Scan warnings print only on a
 * (re)registration, so a permanently broken file doesn't warn on every
 * adopt.
 *
 * @param ctx - cordis-like context probed for the `commands` seam; absent seam
 *   skips the whole mount with one logger line (`inject` stays unchanged).
 * @param cwd - scan root; the caller pins `process.cwd()` (plan §3.1: no
 *   agent/session exists at apply time and the only apply-time directory-scan
 *   precedent uses `process.cwd()` — `ccPluginManager.ts:43`). The tool's
 *   `name` resolution instead uses `exec.agent.session.header.cwd ??
 *   process.cwd()` at launch (`launch.ts`), so in a session whose header cwd
 *   differs from the process cwd (API/headless compositions; a resumed session
 *   started elsewhere) the mounted `/<name>` set can diverge from what the
 *   tool resolves — a recorded deviation (plan §3.1).
 */
export function mountSavedWorkflowCommands(ctx: WorkflowCommandsContext, cwd: string): (() => void)[] {
  const seam = ctx.get('commands') as CommandsSeamLike | undefined
  if (seam === undefined || typeof seam.register !== 'function') {
    ctx.logger.warn('tool-workflow: commands seam not mounted — saved workflows are not invocable as /<name> (run them via the workflow tool name parameter)')
    return []
  }
  const scanned = scanSavedWorkflows(cwd)
  const existing = processMounts.get(seam)
  if (existing !== undefined && existing.fingerprint === scanned.fingerprint) {
    existing.holders++
    return [() => releaseMount(seam, existing)]
  }
  for (const warning of scanned.warnings) ctx.logger.warn(warning)
  if (existing !== undefined) disposeMount(seam, existing)
  const mount: ProcessMount = { fingerprint: scanned.fingerprint, disposers: [], holders: 1 }
  for (const command of scanned.commands) registerScanned(ctx, seam, command, mount.disposers)
  processMounts.set(seam, mount)
  return [() => releaseMount(seam, mount)]
}
