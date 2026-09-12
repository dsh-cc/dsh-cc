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
 * package, CC rule-engine modes) drive different knobs. A CC session's slash
 * menu should show only `/permissions`: `commands.list` drops the host
 * `/permission` row when the session's selected agent preset is `cc`, while
 * `find`/`execute` stay on the global handler so the composer chip can still
 * switch sandbox presets.
 *
 * This package is mounted twice: the host-plane row (cc-permissions bundle)
 * exists so `dsh-client-modules` can discover the `dsh.client` browser half
 * (preset rows never appear in `ctx.loader.entries()`); that host apply is a
 * no-op besides the catalog wrap. The CC preset row registers the command.
 * @module @dsh-cc/command-permissions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@dsh-cc/permission-rules'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { PERMISSION_COMMAND_MODES } from './modes.ts'
import { planPhaseOf, type PlanPhase, type PlanUnitStateLike } from './plan-phase.ts'
import { renderPermissions } from './permissions.ts'
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
  setMode(agent: Agent, mode: string): void
}

/** The shared modes list — the switch list and the client popup both read it. */
const MODES = PERMISSION_COMMAND_MODES

/** Render the current rule state from a mounted engine. */
function renderState(service: PermissionRulesLike): CommandResult {
  return {
    kind: 'success',
    text: renderPermissions(service.ruleSet as never, service.ruleSet.bypassImmune.length),
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
    return renderState(service)
  }
  if (service === undefined) {
    return { kind: 'error', text: 'The permission-rules engine is not mounted in this composition.' }
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

/** Whether this session selected the CC agent preset (last `agent-preset/selected` wins, else the creation header). */
function isCcSession(agent: Agent): boolean {
  const events = agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]! as { type: string; data?: { agentPreset?: string } }
    if (event.type === 'agent-preset/selected') {
      return event.data?.agentPreset === 'cc'
    }
  }
  const header = agent.session.header as { agentPreset?: string }
  return header.agentPreset === 'cc'
}

/**
 * Hide the host `/permission` row from `commands.list` for CC sessions.
 * Installed once on the host-plane mount (`ctx.agent` unset). Preset mounts
 * skip this so a session-scoped apply cannot stack wraps on the same service.
 * `find`/`execute` are not wrapped, so `/permission workspace-write` and the
 * composer chip keep driving the sandbox-preset switcher.
 */
function installCatalogWrap(ctx: Context): void {
  const commands = ctx.commands
  const originalList = commands.list
  const wrappedList = function list(this: typeof commands, agent: Agent): ReturnType<typeof commands.list> {
    const listed = originalList.call(this, agent)
    const hidden = isCcSession(agent) ? 'permission' : 'permissions'
    const filtered = listed.filter(entry => entry.name !== hidden)
    return filtered.length === listed.length ? listed : Object.freeze(filtered)
  }
  commands.list = wrappedList as typeof commands.list
  ctx.effect(() => () => {
    commands.list = originalList
  }, 'command-permissions: hide /permission from the CC catalog')
}

/**
 * Register `/permissions`. The host-plane mount (`ctx.agent` unset, the
 * cc-permissions bundle row) also wraps `commands.list` so a CC session
 * hides `/permission` and a non-CC session hides `/permissions`. That host
 * fiber is what `dsh-client-modules` scans for `dsh.client`. A preset-scoped
 * mount only registers the command (so a composition without the host row
 * still works; the wrap is already on the service from the host row).
 * @param ctx - context carrying the command registry and permission engine.
 */
export function apply(ctx: Context): void {
  ctx.commands.register(helpable({
    name: 'permissions',
    description: 'show or switch the permission mode (default|acceptEdits|plan|auto|bypassPermissions)',
    input: { hint: '[mode]' },
    handler: (invocation: CommandInvocation) => executePermissions(ctx, invocation),
  }, {
    subcommands: PERMISSION_MODE_OPTIONS.map(option => ({ word: option.id, summary: option.detail })),
  }))
  if (ctx.get('agent') === undefined) installCatalogWrap(ctx)
}
