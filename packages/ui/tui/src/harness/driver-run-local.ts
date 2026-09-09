/**
 * /export-md, /copy, local slash-command (runLocal) and host-command
 * (runHarness) pipeline of the in-process protocol driver.
 *
 * Moved out of harness/driver.ts's createDriver factory so the factory stays
 * under the line budget. All shared state arrives on `rt` (DriverRunLocalCtx)
 * and is read through getters / by-reference holders — never a stale snapshot —
 * because createDriver rebinds `state` on every emit.
 *
 * @module @dsh-cc/tui/harness/driver-run-local
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { rowsToMarkdown } from '../export-markdown.ts'
import { defaultExportDir, exportStamp } from './shell-output.ts'
import {
  breakdownOf,
  occupancyOf,
  totalsOf,
  usageViewOf,
} from './usage-view.ts'
import { isHelpRequest } from '@dsh-cc/command-usage'
import { localHelpFor } from '../slash-help.ts'
import { parseModelChoice } from '../model-catalog.ts'
import { parseEffortChoice } from '../effort-catalog.ts'
import { shouldEchoCommandResult } from '../compact-fold.ts'
import { createAgentsSection } from './driver-agents.ts'
import { createProviderSection, type ProviderRuntime } from '../provider-command.ts'
import { wireOnboarding, type OnboardingHandle } from './onboarding.ts'
import { enqueue, moveWorktreeExitFocus, openUsagePanel, setBusy, setTurnActive, setWorktreeExit, upsertRow } from '../store.ts'
import {
  createWorktreeExitHooks,
  ownsBranch,
  type WorktreeExitSession,
} from './worktree-exit.ts'
import type {
  ContextPressureStateLike,
  TokenUsageStateLike,
} from '../state/driver-types.ts'
import type { DriverRunLocalCtx } from './driver-ctx.ts'

/**
 * Duck-typed surface for the optional cc-shell plugin-commands service (see
 * CcPluginsService in cc-shell). Only the run seam is named here; the catalog
 * half lives in driver-catalog.ts. A missing service or a non-plugin name
 * falls off the end of runLocal silently — same as an unknown local name.
 */
type CcPluginsRunLike = {
  runPluginCommand(
    name: string,
    input: { agent: unknown; rawInput: string },
  ): Promise<{ ok: true } | { ok: false; reason: string }>
}

/** Host slash-command registry surface runHarness dispatches through. */
type CommandsLike = {
  execute(
    agent: Agent,
    line: string,
    images: readonly unknown[],
    signal: AbortSignal,
  ): Promise<{ result?: { kind: string; text?: string } } | undefined>
}

/**
 * OSC 52 clipboard-write prefix: `ESC ] 52 ; c ;` + base64 payload, closed
 * with BEL. The sequence is zero-width — writing it inline never disturbs the
 * rendered frame. Only /copy uses it.
 */
const OSC52_PREFIX = '\x1b]52;c;'

export interface RunLocalSection {
  exportTranscript(rawInput: string): void
  copyLatestReply(): void
  runLocal(name: string, rawInput: string): Promise<void>
  runHarness(line: string): Promise<{ kind: string; text?: string } | undefined | null>
  /** `/provider` runtime (read path + action wizards); mounted onto the driver. */
  providerRuntime: ProviderRuntime
  /** Move the `/quit` worktree-exit confirmation focus by one row. */
  worktreeExitMove(delta: -1 | 1): void
  /** Confirm the focused worktree-exit option (keep / remove / cancel). */
  worktreeExitSubmit(): Promise<void>
  /** Dismiss the `/quit` worktree-exit overlay without quitting. */
  worktreeExitCancel(): void
  /** First-run onboarding handle (welcome gate + /onboard re-run). */
  onboarding: OnboardingHandle
}

export function createRunLocalSection(rt: DriverRunLocalCtx): RunLocalSection {
  const { emit, showNotice } = rt
  const { agentsSlash } = createAgentsSection(rt)
  // `/provider` section (read path + action wizards). Created here so runLocal
  // can dispatch without a cycle; createDriver re-exports it on the driver.
  const providerRuntime = createProviderSection({ emit: rt.emit, state: rt.state, ctx: rt.ctx, selection: rt.selection })
  // First-run onboarding: rides the provider runtime (same emit/state/listener
  // seams) so the wizard gate reacts to the boot seed's no-model settle.
  const onboarding = wireOnboarding({
    ctx: rt.ctx,
    emit: rt.emit,
    state: rt.state,
    selection: rt.selection,
    listeners: rt.listeners,
    providerRuntime,
    modelMissing: () => rt.onboardingGate.modelMissing,
  })
  rt.onboardingGate.handle = onboarding
  const worktreeExit = rt.config.worktreeExit ?? createWorktreeExitHooks()

  // The section owns the quit finalizer: after a `/quit` decision settles it
  // persists the resume target (unless the worktree is being removed), tears
  // down the session handle, then hands control to `config.onQuit` (the
  // plugin's shutdown) when wired. `persist` is false on the remove path —
  // resuming into a deleted worktree is meaningless.
  const finalizeQuit = async (persist: boolean): Promise<void> => {
    if (persist && rt.getMarkedContent()) {
      rt.persistResumeTarget()
    }
    await rt.current.handle.dispose()
    rt.config.onQuit?.()
  }


  // --- /export-md: local transcript utilities --------------------------------
  // /export-md serializes the live rows via rowsToMarkdown — an explicit path
  // is resolved against the session cwd; no argument lands under the export
  // dir as <sessionId>-<timestamp>.md. Failures degrade to a notice, never a
  // throw into the composer path.
  const exportTranscript = (rawInput: string): void => {
    const target = rawInput.length > 0
      ? resolve(rt.cwd, rawInput)
      : join(rt.config.exportDir ?? defaultExportDir(), `${String(rt.current.agent.session.id)}-${exportStamp()}.md`)
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, rowsToMarkdown(rt.state().rows))
      showNotice(`Exported to ${target}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      showNotice(`Export failed: ${message}`)
    }
  }

  // /copy re-emits the latest assistant reply through an OSC 52 sequence so
  // the terminal itself owns the clipboard (no child process, no permissions).
  // The write sink is injected; without a sink the command still reports — it
  // just has nowhere to hand the payload.
  const copyLatestReply = (): void => {
    const last = [...rt.state().rows].reverse().find(row => row.kind === 'assistant')
    if (last === undefined || last.kind !== 'assistant' || last.text.trim().length === 0) {
      showNotice('Nothing to copy yet — no assistant reply in the transcript.')
      return
    }
    const payload = Buffer.from(last.text, 'utf8').toString('base64')
    rt.config.copyWrite?.(`${OSC52_PREFIX}${payload}\x07`)
    showNotice('Copied latest reply')
  }

  const runLocal = async (name: string, rawInput: string): Promise<void> => {
    // Trailing `help` / `-h` / `--help` answers the command's own help text
    // as a status row instead of entering the argument parsers.
    if (rawInput !== '' && isHelpRequest(rawInput)) {
      const help = localHelpFor(name)
      if (help !== undefined) {
        emit(upsertRow(rt.state(), { kind: 'status', text: help }))
        return
      }
    }
    if (name === 'quit' || name === 'exit') {
      // When the session cwd is a recognized worktree, `/quit` parks a
      // confirmation overlay instead of exiting: the user decides whether to
      // keep the worktree or remove it (with its owned branch) on exit.
      let session: WorktreeExitSession | undefined
      try {
        session = await worktreeExit.probe(rt.cwd)
      } catch {
        session = undefined
      }
      if (session !== undefined) {
        const evidence = await worktreeExit.evidence(session)
        emit(setWorktreeExit(rt.state(), {
          repoRoot: session.repoRoot,
          worktreePath: session.worktreePath,
          branch: session.branch,
          managed: session.kind === 'managed',
          ownsBranch: ownsBranch(session),
          ...(session.baseHead === undefined ? {} : { baseHead: session.baseHead }),
          ...(evidence.dirtyFiles === undefined ? {} : { dirtyFiles: evidence.dirtyFiles }),
          ...(evidence.commitsAhead === undefined ? {} : { commitsAhead: evidence.commitsAhead }),
          focused: 0,
          busy: false,
        }))
        return
      }
      await finalizeQuit(true)
      return
    }
    if (name === 'clear' || name === 'new' || name === 'reset') {
      await rt.startFreshSession()
      return
    }
    if (name === 'tui-help') {
      emit(upsertRow(rt.state(), {
        kind: 'status',
        text: 'Shift+Tab cycles permission modes. /permissions opens the mode picker. /model lists adapters. /agents lists background agents. /resume lists sessions. /clear starts a new conversation. /quit exits.',
      }))
      return
    }
    if (name === 'resume') {
      if (rawInput.length > 0) {
        await rt.switchSession(rawInput)
        return
      }
      await rt.openSessionSwitcher()
      return
    }
    if (name === 'model') {
      if (rawInput.length === 0) {
        await rt.openModelPicker()
        return
      }
      const catalog = await rt.loadCatalog()
      const chosen = parseModelChoice(rawInput, catalog)
      if (chosen === undefined) {
        showNotice(`Unknown model "${rawInput}". Try /model for the catalog.`)
        return
      }
      // Validates + preserves a carried effort when possible (never blocks the
      // switch itself — see applyModelSwitch).
      await rt.applyModelSwitch(chosen.provider, chosen.model)
    }
    if (name === 'effort') {
      // W4 await-late seam: identical to the submit path — the seed must be
      // settled before this branch reads `selection.current`, or a boot-window
      // /effort would resolve against an undefined route.
      await rt.waitForModel()
      if (rawInput.length === 0) {
        await rt.openEffortPicker()
        return
      }
      const route = rt.selection.current
      if (route === undefined) {
        emit(upsertRow(rt.state(), { kind: 'status', text: 'No model configured. Use /model first.' }))
        return
      }
      // `default` is a reserved keyword (it wins even over a model effort
      // literally named "default"): reset to the bare pair with ZERO
      // validation and zero adapter calls — the provider default is always
      // legal, even when the llm service is unreachable.
      if (parseEffortChoice(rawInput, [])?.kind === 'default') {
        rt.selection.current = { provider: route.provider, model: route.model }
        emit(upsertRow(rt.state(), { kind: 'status', text: 'Reasoning effort reset to the provider default.' }))
        return
      }
      // Fail closed: resolve before validating — selection must never hold an
      // effort the llm layer would reject.
      const efforts = await rt.resolveEfforts(route.provider, route.model)
      if (efforts === undefined || efforts.length === 0) {
        emit(upsertRow(rt.state(), { kind: 'status', text: `Cannot resolve effort levels for ${route.model}.` }))
        return
      }
      const choice = parseEffortChoice(rawInput, efforts.map(level => level.id))
      // `choice.kind === 'default'` cannot occur here: the reserved keyword
      // already returned above, so anything non-level is unknown.
      if (choice?.kind !== 'level') {
        emit(upsertRow(rt.state(), {
          kind: 'status',
          text: `Unknown effort "${rawInput.trim()}" for ${route.model}. Try /effort.`,
        }))
        return
      }
      const level = efforts.find(candidate => candidate.id === choice.level)!
      // Single branding seam: view layers stay plain strings.
      rt.selection.current = {
        provider: route.provider,
        model: route.model,
        reasoningEffort: ReasoningEffortId(level.id),
      }
      // User-facing text carries the effort NAME, not the raw id.
      emit(upsertRow(rt.state(), { kind: 'status', text: `Reasoning effort is now ${level.name}.` }))
    }
    if (name === 'usage') {
      // Seed from the live projections before opening: a resumed session (or
      // one with no projection change since boot) already holds data the
      // change feed has never delivered. From here on the onChanged feed
      // keeps the snapshot fresh, so an open panel refreshes live.
      if (rt.projections !== undefined) {
        rt.applyUsage(usageViewOf(
          totalsOf(rt.projections.stateOf(rt.current.agent.session, 'tokenUsage') as TokenUsageStateLike | undefined),
          occupancyOf(rt.projections.stateOf(rt.current.agent.session, 'contextPressure') as ContextPressureStateLike | undefined),
          breakdownOf(rt.projections.stateOf(rt.current.agent.session, 'contextBreakdown')),
        ))
      }
      emit(openUsagePanel(rt.state()))
      return
    }
    if (name === 'agents') {
      emit(upsertRow(rt.state(), { kind: 'status', text: await agentsSlash(rawInput) }))
      return
    }
    if (name === 'export-md') {
      exportTranscript(rawInput)
      return
    }
    if (name === 'provider') {
      await providerRuntime.openProviderPanel(rawInput)
      return
    }
    if (name === 'onboard') {
      // Manual re-run of the first-run flow: clears cc-onboarding.suppressed
      // (when the section is writable), then re-opens the provider panel.
      await onboarding.reRun()
      return
    }
    if (name === 'copy') {
      copyLatestReply()
      return
    }
    // Plugin commands (colon form `plugin:command`) dispatch through the
    // optional ccPlugins service. The agent is read from the LIVE holder at
    // fire time — never a cached boot reference — so a post-switch session
    // receives the command, not the one booted with the driver.
    const plugins = rt.ctx.get('ccPlugins') as CcPluginsRunLike | undefined
    if (plugins === undefined || typeof plugins.runPluginCommand !== 'function') return
    const s = rt.state()
    if (s.busy) {
      // Mirror Enter-on-prompt while busy: park the full line in the outbox
      // instead of dispatching. Nothing is injected into the running turn.
      emit(enqueue(s, `/${name}${rawInput.length === 0 ? '' : ` ${rawInput}`}`))
      return
    }
    let result: { ok: true } | { ok: false; reason: string }
    try {
      result = await plugins.runPluginCommand(name, { agent: rt.current.agent, rawInput })
    } catch (error) {
      // A throwing plugin must not reject into `void driver.submit()` — show
      // a notice and stop, mirroring the {ok:false} path below.
      const reason = error instanceof Error ? error.message : String(error)
      showNotice(`Plugin command /${name} failed: ${reason}`)
      return
    }
    if (result !== null && typeof result === 'object' && (result as { ok?: unknown }).ok === false) {
      const reason = (result as { reason?: string }).reason ?? 'unknown error'
      showNotice(`Plugin command /${name} failed: ${reason}`)
      return
    }
    // Turn tail mirroring the prompt path (driver-queue.submit): anchor the
    // working line at dispatch, token delta from the pre-dispatch HUD total.
    emit(setTurnActive(setBusy(rt.state(), true), { startedAt: Date.now(), outputBase: s.hud?.tokens?.output }))
  }

  /**
   * Execute a slash command line through the host registry and echo its
   * result text as a status row. Tri-state return:
   * - `null` — no command registry is mounted (already noticed here).
   * - `undefined` — the registry matched nothing. The submit path falls
   *   through to a user prompt so a typed `/skill-name` can load through
   *   dsh-tool-skill's gesture boundary; do not notice here.
   * - otherwise the command result.
   */
  const runHarness = async (line: string): Promise<{ kind: string; text?: string } | undefined | null> => {
    const commands = rt.ctx.get('commands') as CommandsLike | undefined
    if (commands === undefined) {
      showNotice('No command registry is mounted.')
      return null
    }
    const execution = await commands.execute(rt.current.agent, line, [], new AbortController().signal)
    if (execution === undefined) return undefined
    const result = execution.result
    // A successful `/compact` already painted its compact boundary row —
    // echoing `Compacted N history items…` on top would duplicate it.
    if (result !== undefined && result.text !== undefined && result.text.length > 0
      && shouldEchoCommandResult(result, rt.state().rows)) {
      emit(upsertRow(rt.state(), {
        kind: 'status',
        text: result.text,
        ...(result.kind === 'error' ? { error: true } : {}),
      }))
    }
    return result
  }

  // --- /quit worktree-exit confirmation overlay ------------------------------
  // Parked by the quit branch above when the session cwd is a recognized
  // worktree; these three methods drive the overlay. State is re-read fresh
  // via rt.state() (createDriver rebinds it on every emit).
  const worktreeExitMove = (delta: -1 | 1): void => {
    const view = rt.state().worktreeExit
    if (view === undefined || view.busy) return
    emit(moveWorktreeExitFocus(rt.state(), delta))
  }

  const worktreeExitCancel = (): void => {
    const view = rt.state().worktreeExit
    if (view === undefined || view.busy) return
    emit(setWorktreeExit(rt.state(), undefined))
  }

  const worktreeExitSubmit = async (): Promise<void> => {
    const view = rt.state().worktreeExit
    if (view === undefined || view.busy) return
    // Cancel row: just dismiss, session stays.
    if (view.focused === 2) {
      emit(setWorktreeExit(rt.state(), undefined))
      return
    }
    // Keep row: standard quit with resume persistence.
    if (view.focused === 0) {
      emit(setWorktreeExit(rt.state(), undefined))
      await finalizeQuit(true)
      return
    }
    // Remove row: destructive — gather the session back, run the cleanup,
    // and only tear down on success. A failed removal leaves the session
    // and the worktree fully intact (never a half-disposed TUI).
    emit(setWorktreeExit(rt.state(), { ...view, busy: true }))
    const session: WorktreeExitSession = {
      kind: view.managed ? 'managed' : 'detected',
      repoRoot: view.repoRoot,
      worktreePath: view.worktreePath,
      branch: view.branch,
      ...(view.baseHead === undefined ? {} : { baseHead: view.baseHead }),
    }
    try {
      await worktreeExit.cleanup(session)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      emit(setWorktreeExit(rt.state(), undefined))
      showNotice(`Worktree cleanup failed: ${message}. Session kept alive; worktree left in place.`)
      return
    }
    emit(setWorktreeExit(rt.state(), undefined))
    // The worktree is gone; clear the marked-content flag so dispose() (which
    // the plugin's shutdown invokes) does not re-persist a resume marker that
    // points into the deleted worktree.
    rt.setMarkedContent(false)
    await finalizeQuit(false)
  }

  return {
    exportTranscript,
    copyLatestReply,
    runLocal,
    runHarness,
    providerRuntime,
    worktreeExitMove,
    worktreeExitSubmit,
    worktreeExitCancel,
    onboarding,
  }
}
