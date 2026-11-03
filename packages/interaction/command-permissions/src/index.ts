/**
 * Human-facing `/permissions` command: render the effective permission rule
 * state (allow/deny/ask counts per source), or switch the session's permission
 * mode with `/permissions <mode>`. Switching is durable — engine modes route
 * through the permission-rules engine's `setMode`; `plan` routes through the
 * `/plan` command channel, the only cross-plane write seam plan-mode exposes
 * (its `planMode` service lives inside the preset's isolate realm, invisible
 * to `ctx.get` from here). See docs/plan-mode-command-channel.md.
 *
 * The host command remains the write path. A client decoration (see
 * `./client`) hangs the same popupSelect on the BARE invocation, mirroring the
 * `/permission` preset pattern — a pick submits `/permissions <mode>` through
 * here, so both surfaces write through one path. The TUI intercepts the same
 * bare invocation and opens an overlay that also submits `/permissions
 * <mode>` through here.
 *
 * `/permission` (host, sandbox+approval presets) and `/permissions` (this
 * package, CC rule-engine modes) drive different knobs, so dsh-cc retires the
 * host line from the user surface: `commands.list` drops the `/permission` row
 * in every session — the selected agent preset no longer decides which of the
 * two is advertised — and a typed `/permission …` line is rewritten onto
 * `/permissions …` before dispatch. The host handler stays registered, so a
 * composition that predates this package keeps working; only the surface users
 * see and type is ours.
 *
 * This package is mounted twice: the host-plane row (cc-permissions bundle)
 * exists so `dsh-client-modules` can discover the `dsh.client` browser half
 * (preset rows never appear in `ctx.loader.entries()`); that host apply is a
 * no-op besides the surface guard. The CC preset row registers the command.
 * @module @dsh-cc/command-permissions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@dsh-cc/permission-rules'
import type { CommandExecution, CommandInvocation, CommandResult, CommandSubmitAttachment } from '@deepseek-ai/dsh-commands'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { PERMISSION_COMMAND_MODES } from './modes.ts'
import { applyUserLint, lintRuleSet, lintUserSection, renderLint } from './lint.ts'
import { PERMISSION_SETTINGS_NAMESPACE } from '@dsh-cc/permission-rules'
import { foldPlanMode, foldPermissionMode } from '@dsh-cc/permission-rules'
import { planPhaseOf, type PlanPhase, type PlanUnitStateLike } from './plan-phase.ts'
import { renderPermissions, renderGrantList, renderGrantView } from './permissions.ts'
import type { TaskGrant } from '@dsh-cc/permission-rules'
import { helpable } from '@dsh-cc/command-usage'
import { PERMISSION_MODE_OPTIONS } from './modes.ts'

export {
  BYPASS_CONFIRMATION,
  BYPASS_MODE,
  PERMISSION_COMMAND_MODES,
  PERMISSION_MODE_OPTIONS,
  type PermissionCommandMode,
  type PermissionModeOption,
} from './modes.ts'
export { planPhaseOf, type PlanPhase, type PlanUnitStateLike } from './plan-phase.ts'

export const name = 'command-permissions'
/**
 * `commands` is required; the `permissionRules` engine and `planMode` are read
 * optionally via `ctx.get` so the command loads (and reports a friendly message)
 * even when the engine is not composed, mirroring `/status`'s optional
 * permission-preset read.
 */
export const inject = ['commands']

/** Structural face of the permission-rules engine the command drives. */
type PermissionRulesLike = {
  readonly ruleSet: { readonly allow: readonly unknown[]; readonly deny: readonly unknown[]; readonly ask: readonly unknown[]; readonly bypassImmune: readonly unknown[] }
  readonly defaultMode: string
  /** The D1 seam: the rule set `mode` evaluates against (auto suspends rules). */
  effectiveRuleSet(mode: string): PermissionRulesLike['ruleSet']
  setMode(agent: Agent, mode: string): void
  /** Task-grant surface (design §3.3) — absent on an engine without grants. */
  grants?: {
    of(agent: Agent): readonly TaskGrant[]
    propose(agent: Agent, descriptorPath: string): Promise<TaskGrant>
    create(agent: Agent, descriptorPath: string): Promise<TaskGrant>
    revoke(agent: Agent, grantId: string): boolean
  }
}

/** The shared modes list — the switch list and the client popup both read it. */
const MODES = PERMISSION_COMMAND_MODES

/** Render the current rule state from a mounted engine. */
function renderState(service: PermissionRulesLike, agent?: Agent): CommandResult {
  const merged = service.ruleSet as never as { readonly allow: readonly unknown[] }
  const mode = foldPlanMode(agent?.session.snapshotEvents() ?? [])
    ? 'plan'
    : foldPermissionMode(agent?.session.snapshotEvents() ?? []) ?? service.defaultMode
  const effective = service.effectiveRuleSet(mode)
  return {
    kind: 'success',
    text: renderPermissions(effective as never, service.ruleSet.bypassImmune.length, {
      suspendedAllow: merged.allow.length - effective.allow.length,
    }),
  }
}

/**
 * Resolve the pending-aware plan phase for the invocation's agent. The plan
 * projection (host-plane registry) sees queued intent; without it the fold
 * sees only committed `plan/mode` events.
 */
function planPhaseFor(ctx: Context, agent: Agent): PlanPhase {
  const projections = ctx.get('sessionProjections') as
    | { stateOf(session: Agent['session'], key: string): unknown }
    | undefined
  const planState = projections?.stateOf(agent.session, 'plan') as PlanUnitStateLike | undefined
  return planPhaseOf(agent.session.snapshotEvents(), planState)
}

/** Execute `/permissions` against the mounted permission-rules engine. */
async function executePermissions(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const service = ctx.get('permissionRules') as PermissionRulesLike | undefined
  const raw = invocation.rawInput.trim()
  if (raw === '') {
    if (service === undefined) {
      return { kind: 'success', text: 'The permission-rules engine is not mounted in this composition.' }
    }
    return renderState(service, invocation.agent)
  }
  if (service === undefined) {
    return { kind: 'error', text: 'The permission-rules engine is not mounted in this composition.' }
  }
  if (raw === 'lint' || raw.startsWith('lint ')) return executeLint(ctx, raw)
  if (raw === 'grants' || raw.startsWith('grants ')) return executeGrants(service, invocation)
  if (raw === 'revoke' || raw.startsWith('revoke ')) return executeRevoke(service, invocation, raw.slice('revoke'.length).trim())
  if (raw === 'grant' || raw.startsWith('grant ')) {
    return executeGrant(service, invocation, raw.slice('grant'.length).trim())
  }
  const [mode = ''] = raw.split(/\s+/)
  if (!(MODES as readonly string[]).includes(mode)) {
    return { kind: 'error', text: `unknown permission mode "${mode}"; available: ${MODES.join(', ')}` }
  }
  const agent = invocation.agent
  try {
    // `plan` is owned by plan-mode, never the engine's setMode. The write
    // goes through the /plan command channel — the only cross-plane seam —
    // dispatched bare ('/plan', never '/plan on'): the upstream handler
    // steers any non-'off' argument into the conversation as a user message.
    if (mode === 'plan') {
      if (planPhaseFor(ctx, agent) === 'on') {
        return { kind: 'success', text: 'Permission mode is now "plan".' }
      }
      const execution = await ctx.commands.execute(agent, '/plan', [], invocation.signal)
      if (execution === undefined) {
        return { kind: 'error', text: 'plan mode is not mounted in this composition' }
      }
      return execution.result
    }
    // Leave plan first: the engine overlays plan over every other mode at
    // evaluation time, so switching underneath an active (or queued) plan is
    // invisible work at best. A failed or unmatched exit aborts the switch.
    if (planPhaseFor(ctx, agent) !== 'off') {
      const execution = await ctx.commands.execute(agent, '/plan off', [], invocation.signal)
      if (execution === undefined) {
        return { kind: 'error', text: 'plan mode is not mounted in this composition' }
      }
      if (execution.result.kind === 'error') return execution.result
    }
    service.setMode(agent, mode)
    return { kind: 'success', text: `Permission mode is now "${mode}".` }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Execute `/permissions grant <descriptorPath> [--confirm]` (design §3.3):
 * derive the complete grant, render EVERY derived field, and create it only on
 * the user's explicit `--confirm` re-run. There is no agent-callable grant
 * tool — this typed command is the only creation path.
 */
async function executeGrant(
  service: PermissionRulesLike,
  invocation: CommandInvocation,
  rest: string,
): Promise<CommandResult> {
  const grants = service.grants
  if (grants === undefined) {
    return { kind: 'error', text: 'Task grants are not available in this composition.' }
  }
  // Token-boundary parse: only a standalone trailing `--confirm` confirms
  // (`x--confirm` or `--confirm extra` stays propose-only, no silent create).
  const tokens = rest.split(/\s+/).filter(token => token !== '')
  const confirm = tokens[tokens.length - 1] === '--confirm'
  const descriptorPath = (confirm ? tokens.slice(0, -1) : tokens).join(' ').trim()
  if (descriptorPath === '') {
    return { kind: 'error', text: 'usage: /permissions grant <descriptorPath> [--confirm]' }
  }
  try {
    if (!confirm) {
      const draft = await grants.propose(invocation.agent, descriptorPath)
      return { kind: 'success', text: renderGrantView(draft, { confirmed: false, descriptorPath }) }
    }
    const grant = await grants.create(invocation.agent, descriptorPath)
    return { kind: 'success', text: renderGrantView(grant, { confirmed: true }) }
  } catch (error: unknown) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/** Execute `/permissions grants` — list the session's live grants. */
function executeGrants(service: PermissionRulesLike, invocation: CommandInvocation): CommandResult {
  const grants = service.grants
  if (grants === undefined) {
    return { kind: 'error', text: 'Task grants are not available in this composition.' }
  }
  return { kind: 'success', text: renderGrantList(grants.of(invocation.agent)) }
}

/** Execute `/permissions revoke <grantId>` — revoke ONE grant. */
function executeRevoke(service: PermissionRulesLike, invocation: CommandInvocation, grantId: string): CommandResult {
  const grants = service.grants
  if (grants === undefined) {
    return { kind: 'error', text: 'Task grants are not available in this composition.' }
  }
  if (grantId === '') return { kind: 'error', text: 'usage: /permissions revoke <grantId>' }
  return grants.revoke(invocation.agent, grantId)
    ? { kind: 'success', text: `Task grant ${grantId} revoked.` }
    : { kind: 'error', text: `No live task grant ${grantId} in this session.` }
}

/**
 * Read the raw user-layer `permissions` section from the settings provider's
 * `describe()` descriptors (the raw user file section, never the merged one).
 */
function userSectionOf(settings: unknown): Record<string, unknown> {
  const descriptor = (settings as { describe?: () => Array<{ ns: unknown; user?: unknown }> })
    .describe?.()
    ?.find(entry => String(entry.ns) === String(PERMISSION_SETTINGS_NAMESPACE))
  return descriptor !== undefined && descriptor.user !== null && typeof descriptor.user === 'object'
    ? descriptor.user as Record<string, unknown>
    : {}
}

/**
 * Execute `/permissions lint [--apply]`. Read-only by default; `--apply`
 * performs only the user-layer cleanup through `editUserSection`.
 */
async function executeLint(ctx: Context, raw: string): Promise<CommandResult> {
  const service = ctx.get('permissionRules') as PermissionRulesLike | undefined
  if (service === undefined) {
    return { kind: 'error', text: 'The permission-rules engine is not mounted in this composition.' }
  }
  const settings = ctx.get('settings') as unknown
  const userLint = settings === undefined ? undefined : lintUserSection(userSectionOf(settings))
  const report = renderLint(lintRuleSet(service.ruleSet as never), userLint)
  if (!raw.includes('--apply')) return { kind: 'success', text: report }
  const result = await applyUserLint(settings)
  return { kind: 'success', text: `${report}\n${result}` }
}

/** The retired host command name (sandbox+approval preset switcher). */
const RETIRED_COMMAND = 'permission'

/** The dsh-cc surface that replaces it. */
const SURFACE_COMMAND = 'permissions'

/**
 * Rewrite a typed `/permission …` line onto `/permissions …`.
 *
 * The rewrite keeps the raw input verbatim, so `/permission acceptEdits`
 * still switches the engine mode and a sandbox-preset argument such as
 * `workspace-write` settles as the mode list's own "unknown permission mode"
 * error. Any other line — including the `hookSpecificOutput`-style prose some
 * tools emit — is returned unchanged.
 * @param line - one submitted composer line.
 * @returns the line to dispatch, `/permission` calls redirected.
 */
function retirePermissionLine(line: string): string {
  const parsed = parseCommand(line.trim())
  if (parsed === undefined || parsed.name !== RETIRED_COMMAND) return line
  const redirected = `/${SURFACE_COMMAND}${parsed.rawInput === '' ? '' : ` ${parsed.rawInput.trim()}`}`
  // Keep the leading indentation of the original line irrelevant: `execute`
  // parses its own trimmed input.
  return redirected
}

/**
 * Retire the host `/permission` command from the dsh-cc user surface.
 *
 * Installed once on the host-plane mount (`ctx.agent` unset); preset mounts
 * skip this so a session-scoped apply cannot stack guards on the same service.
 * The policy is preset-independent on purpose: `/permissions` is the one
 * permission command dsh-cc users are meant to reach, and a `vwa` (or any
 * other non-`cc`) session used to advertise the host line instead — leaving
 * `/permissions` executable but invisible.
 *
 * - `list` drops the `permission` row, so no catalog (TUI autocomplete, web
 *   slash menu, `/help`) advertises it.
 * - `execute` redirects a typed `/permission …` line onto `/permissions …`,
 *   so muscle memory and older scripts reach the supported surface instead of
 *   the sandbox-preset handler. The redirect delegates to the registry's own
 *   `execute`, so the real `command/run`/`command/done` lifecycle is kept.
 *
 * `find` is left alone: the host definition stays resolvable, which is what a
 * surface needing the definition metadata would read.
 */
function installPermissionSurfaceGuard(ctx: Context): void {
  const commands = ctx.commands
  const originalList = commands.list
  const wrappedList = function list(this: typeof commands, agent: Agent): ReturnType<typeof commands.list> {
    const listed = originalList.call(this, agent)
    const filtered = listed.filter(entry => entry.name !== RETIRED_COMMAND)
    return filtered.length === listed.length ? listed : Object.freeze(filtered)
  }
  commands.list = wrappedList as typeof commands.list

  const originalExecute = commands.execute
  const wrappedExecute = async function execute(
    this: typeof commands,
    agent: Agent,
    line: string,
    attachments: readonly CommandSubmitAttachment[],
    signal: AbortSignal,
  ): Promise<CommandExecution | undefined> {
    return originalExecute.call(this, agent, retirePermissionLine(line), attachments, signal)
  }
  commands.execute = wrappedExecute as typeof commands.execute

  ctx.effect(() => () => {
    commands.list = originalList
    commands.execute = originalExecute
  }, 'command-permissions: retire /permission from the user surface')
}

/**
 * Register `/permissions`. The host-plane mount (`ctx.agent` unset, the
 * cc-permissions bundle row) also installs the surface guard, which hides
 * `/permission` from every catalog and redirects a typed `/permission` line.
 * That host fiber is what `dsh-client-modules` scans for `dsh.client`. A
 * preset-scoped mount only registers the command (so a composition without the
 * host row still works; the guard is already on the service from the host row).
 * @param ctx - context carrying the command registry and permission engine.
 */
export function apply(ctx: Context): void {
  ctx.commands.register(helpable({
    name: 'permissions',
    description: 'show or switch the permission mode (default|acceptEdits|plan|auto|bypassPermissions); manage task grants',
    input: { hint: '[mode|lint [--apply]|grant <descriptorPath> [--confirm]|grants|revoke <grantId>]' },
    handler: (invocation: CommandInvocation) => executePermissions(ctx, invocation),
  }, {
    subcommands: [
      ...PERMISSION_MODE_OPTIONS.map(option => ({ word: option.id, summary: option.detail })),
      { word: 'lint', summary: 'report rule-hygiene findings; --apply cleans the user layer' },
      { word: 'grant', summary: 'derive a task grant from a descriptor and render it for confirmation (--confirm creates it)' },
      { word: 'grants', summary: 'list the session\'s live task grants' },
      { word: 'revoke', summary: 'revoke one task grant by id' },
    ],
  }))
  if (ctx.get('agent') === undefined) installPermissionSurfaceGuard(ctx)
}
