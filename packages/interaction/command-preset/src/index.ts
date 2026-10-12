/**
 * Human-facing `/preset` command: list the agent-preset roster, and switch the
 * running session and/or the persisted default with `/preset <id>`.
 *
 * The transaction order is pinned (VWA design doc §3.2):
 *  1. validate the id against `registry.list()` — on failure report and list
 *     the valid ids;
 *  2. try `agentPresets.select(agent, id)` for the zero-turn session — an
 *     `agent-preset/locked` outcome DOWNGRADES to "change the default only"
 *     (not an error);
 *  3. write `vwa-preset.selectedDefault` through the settings-provider update
 *     semantics — on failure, report the manual-fallback guidance and mark hot
 *     activation as NOT achieved;
 *  4. only after a successful action branch, inject the announcement
 *     (`source.kind = 'command-preset'`) to the model, with the distinct
 *     "switched in this session" / "applies to new sessions" texts.
 *
 * The partial-success tri-state texts are pinned here:
 *  - T1 full success (hot switch + default written): SWITCHED_TEXT.
 *  - T2 locked downgrade (default written only): DEFAULT_ONLY_TEXT.
 *  - T3 settings write failed (hot switch may still have happened):
 *    SWITCHED_WRITE_FAILED_TEXT / DEFAULT_WRITE_FAILED_TEXT.
 *
 * The registry is read at APPLY time via `ctx.get('agentPresets')` with a loud
 * throw when absent. It is deliberately NOT declared in `inject`: injecting a
 * service into this plugin's scope re-composes that service inside the preset
 * scope (known cordis trap in this repo), which would fork the registry.
 * @module @dsh-cc/command-preset
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { helpable } from '@dsh-cc/command-usage'
import { VWA_PRESET_NAMESPACE, registerVwaPresetSettings } from './settings.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The /preset command's injected preset-switch announcement. */
    'command-preset': { kind: 'command-preset' }
  }
}

export const name = 'command-preset'
export const inject = ['commands']

/** Structural face of the agent-preset registry this command drives. */
type AgentPresetsLike = {
  readonly defaultId: string
  list(): Promise<Array<{ id: string; name?: string; description?: string; order?: number; broken?: string }>>
  select(agent: Agent, agentPreset: string): Promise<string>
}

/** Structural face of the settings-provider write path the command uses. */
type SettingsLike = {
  update(ns: string, patch: Record<string, unknown>): Promise<void>
}

export { VWA_PRESET_NAMESPACE, registerVwaPresetSettings } from './settings.ts'
export type { VwaPresetSettings } from './settings.ts'

/** The injected announcement's source kind. */
export const PRESET_SOURCE_KIND = 'command-preset'

/**
 * Pinned tri-state announcement texts (VWA design doc §3.2 step 4). Each is
 * injected AFTER the corresponding successful action branch, never on failure.
 */
/** T1: hot switch happened AND the persisted default was written. */
export const SWITCHED_TEXT = (id: string): string =>
  `Agent preset switched to "${id}" for this session; new sessions will also start with "${id}".`
/** T2: the session was locked (`agent-preset/locked`), so only the default changed. */
export const DEFAULT_ONLY_TEXT = (id: string): string =>
  `This session has already started and keeps its current preset; new sessions will start with "${id}".`
/** T3a: hot switch happened but the settings write failed — hot activation of new sessions NOT achieved. */
export const SWITCHED_WRITE_FAILED_TEXT = (id: string, reason: string): string =>
  `Agent preset switched to "${id}" for this session, but the persisted default could not be written (${reason}). `
    + `New sessions keep the previous default — hot activation is NOT achieved. Fix the settings provider `
    + `(it must be mounted and writable) and re-run /preset ${id}.`
/** T3b: locked AND the settings write failed — nothing changed. */
export const DEFAULT_WRITE_FAILED_TEXT = (id: string, reason: string): string =>
  `Nothing was changed: this session has already started, and the persisted default could not be written to "${id}" (${reason}). `
    + `Fix the settings provider (it must be mounted and writable) and re-run /preset ${id}.`

/** The one-line manual-fallback guidance appended when the settings write fails. */
export const MANUAL_FALLBACK_HINT =
  'Manual fallback: set `vwa-preset.selectedDefault` in your user settings file to switch the default.'

/** `/preset` bare invocation: the roster as presentation text. */
export function renderPresetList(
  rows: Awaited<ReturnType<AgentPresetsLike['list']>>,
  defaultId: string,
): string {
  const lines: string[] = [`Agent presets (current default: "${defaultId}"):`]
  for (const row of rows) {
    const marker = row.id === defaultId ? '*' : ' '
    const name = row.name ?? row.id
    const order = row.order === undefined ? '' : ` (order ${row.order})`
    const description = row.description === undefined ? '' : ` — ${row.description}`
    const broken = row.broken === undefined ? '' : ` [unavailable: ${row.broken}]`
    lines.push(`${marker} ${row.id} — ${name}${order}${description}${broken}`)
  }
  return lines.join('\n')
}

/** Whether an error is the registry's `agent-preset/locked` downgrade signal. */
function isPresetLocked(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return code === 'agent-preset/locked'
    || (error instanceof Error && error.message.includes('agent-preset/locked'))
}

/** Whether an error is a RemoteError code other than `agent-preset/locked`. */
function remoteCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** The `/preset <id>` transaction (pinned order, VWA design doc §3.2). */
async function executePreset(
  presets: AgentPresetsLike,
  settings: SettingsLike | undefined,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const id = invocation.rawInput.trim().split(/\s+/)[0] ?? ''
  if (id === '') {
    return { kind: 'success', text: renderPresetList(await presets.list(), presets.defaultId) }
  }

  // (1) Validate against the registry roster; a failure reports and lists the
  // valid ids — it never writes.
  const roster = await presets.list()
  if (!roster.some((row) => row.id === id)) {
    const valid = roster.map((row) => row.id).join(', ')
    return {
      kind: 'error',
      text: `unknown agent preset "${id}"; valid ids: ${valid === '' ? '(none declared)' : valid}`,
    }
  }

  // (2) Hot activation for the zero-turn session. `agent-preset/locked` is a
  // downgrade to "change the default only", not an error; any other
  // RemoteError (e.g. `agent-preset/invalid`) aborts before the write, so a
  // broken preset never becomes the default.
  let switched = false
  try {
    await presets.select(invocation.agent, id)
    switched = true
  } catch (error) {
    if (!isPresetLocked(error)) {
      const code = remoteCode(error)
      const reason = error instanceof Error ? error.message : String(error)
      return {
        kind: 'error',
        text: `preset "${id}" could not be activated in this session${code === undefined ? '' : ` (${code})`}: ${reason}`,
      }
    }
  }

  // (3) Persist the default through the settings-provider update semantics.
  let defaultWritten = false
  let writeFailure = ''
  if (settings === undefined) {
    writeFailure = 'no settings provider is mounted'
  } else {
    try {
      await settings.update(VWA_PRESET_NAMESPACE, { selectedDefault: id })
      defaultWritten = true
    } catch (error) {
      writeFailure = error instanceof Error ? error.message : String(error)
    }
  }

  // (4) Announcement strictly after the successful action branch; a failed
  // settings write injects no "new sessions" claim (tri-state texts above).
  if (switched && defaultWritten) {
    invocation.agent.inject(createUserMessage({
      content: [{ type: 'text', text: SWITCHED_TEXT(id) }],
      source: { kind: PRESET_SOURCE_KIND },
    }))
    return { kind: 'success', text: SWITCHED_TEXT(id) }
  }
  if (switched && !defaultWritten) {
    invocation.agent.inject(createUserMessage({
      content: [{ type: 'text', text: SWITCHED_WRITE_FAILED_TEXT(id, writeFailure) }],
      source: { kind: PRESET_SOURCE_KIND },
    }))
    return { kind: 'success', text: SWITCHED_WRITE_FAILED_TEXT(id, writeFailure) }
  }
  if (!switched && defaultWritten) {
    invocation.agent.inject(createUserMessage({
      content: [{ type: 'text', text: DEFAULT_ONLY_TEXT(id) }],
      source: { kind: PRESET_SOURCE_KIND },
    }))
    return { kind: 'success', text: DEFAULT_ONLY_TEXT(id) }
  }
  return { kind: 'error', text: DEFAULT_WRITE_FAILED_TEXT(id, writeFailure) }
}

/**
 * Register `/preset`. The registry is read at APPLY time with a loud throw
 * when absent — a composition that mounts this row without the registry is a
 * wiring bug, not a runtime degrade. The settings service, by contrast, is
 * read LAZILY inside the handler: its host bundle row settles DURING the
 * preset mount sweep (rc.2 mount-order race, documented in
 * @dsh-cc/settings-ns: registerNamespaceSafe self-heals for the namespace
 * registration below, and the write path must not capture a dead handle).
 * @param ctx - context carrying the command registry and agent-preset registry.
 */
export function apply(ctx: Context): void {
  const presets = ctx.get('agentPresets') as AgentPresetsLike | undefined
  if (presets === undefined) {
    throw new Error(
      'dsh-cc-command-preset: the agent-preset registry is not mounted; '
        + 'boot with a composition that declares @deepseek-ai/dsh-agent-preset-registry (the tui profile does).',
    )
  }
  // Register the settings namespace at mount so the write in (3) never hits
  // `settings namespace "vwa-preset" is not registered`. registerNamespaceSafe
  // defers the registration to the settings provider's arrival, so the
  // mount-order race cannot strand the namespace.
  registerVwaPresetSettings(ctx)
  ctx.commands.register(helpable({
    name: 'preset',
    description: 'list the agent presets, or switch this session and the default with /preset <id>',
    input: { hint: '[id]' },
    handler: (invocation: CommandInvocation) =>
      executePreset(presets, ctx.get('settings') as SettingsLike | undefined, invocation),
  }))
}
