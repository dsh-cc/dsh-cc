/**
 * In-process protocol driver: session/event → UI store, followup/steer/cancel
 * back into the agent. Only this directory imports `@deepseek-ai/*`.
 * @module @dsh-cc/tui/harness/driver
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type AgentSetup, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { composePreset } from './preset.ts'
import { bootBannerRows } from './boot-banner.ts'
import { createSessionsSection } from './driver-sessions.ts'
import { gitBranchOf } from './shell-output.ts'
import { runShellCommand as runShellCommandModule } from './driver-bash.ts'
import { createApprovalsSection } from './driver-approvals.ts'
import { createCatalogSection } from './driver-catalog.ts'
import type { DriverBashCtx, DriverQueueCtx, PermissionRulesLike } from './driver-ctx.ts'
import { createModeSection } from './driver-mode.ts'
import { liveModeWithDefault, liveSessionCwd } from './driver-live.ts'
import { createHudSection } from './driver-hud.ts'
import { createStatusLineWiring } from './statusline-wiring.ts'
import type { OnboardingGate } from './onboarding.ts'
import { createPickersSection } from './driver-pickers.ts'
import { createQueueSection } from './driver-queue.ts'
import { createRunLocalSection } from './driver-run-local.ts'
import { createAgentSection, attachSessionEvents } from './driver-agent.ts'
import { createPromoteSection } from './driver-promote.ts'
import type { ProviderRuntime } from '../provider-command.ts'

import type { Driver } from '../state/driver-types.ts'
export type { Driver } from '../state/driver-types.ts'
import type { DriverConfig } from '../state/driver-types.ts'

import { clearResumeTarget, readResumeTarget, writeResumeTarget } from '../resume-target.ts'
import { coldCutGlobalHistory, defaultTuiDir } from '../history.ts'
import { resolveProject } from '../project.ts'
import { recordProjectSessionId } from '../project-sessions.ts'
import type { ApprovalAnswerKind } from '../state/driver-types.ts'
import {
  closeTodoPanel,
  closeUsagePanel,
  createInitialState,
  markExitAttempt,
  moveTodoPanelFocus,
  openTodoPanel,
  setBusy,
  setDraft,
  setNotice,
  setPermissionMode,
  toggleGlobalCollapse,
  toggleThinking,
  upsertRow,
  type TuiState,
} from '../store.ts'

export type { DriverConfig, TokenUsageTotals } from '../state/driver-types.ts'
export {
  BASH_OUTPUT_LINE_CAP,
  BASH_STDOUT_MAX_BYTES,
  BASH_TIMEOUT_MS,
  gitBranchOf,
} from './shell-output.ts'
export { allowRuleOf, payloadOf } from './approval-preview.ts'

/** Default lifetime of a transient `showNotice` hint. */
const NOTICE_TTL_MS = 3000

/**
 * Create the TUI driver: one agent under the CC preset, interaction providers,
 * and a folded view model.
 */
export async function createDriver(ctx: Context, config: DriverConfig = {}): Promise<Driver & { providerRuntime: ProviderRuntime }> {
  const listeners = new Set<(state: TuiState) => void>()
  let state = createInitialState()
  const emit = (next: TuiState): void => {
    state = next
    for (const listener of listeners) listener(state)
  }

  // Transient notice: parked in state.notice with a self-clearing timer. The
  // timer handle lives here so dispose() can cancel it (reversible effect),
  // and a newer notice replaces the pending timer of the previous one.
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  const showNotice = (text: string, ttlMs = NOTICE_TTL_MS): void => {
    if (noticeTimer !== undefined) clearTimeout(noticeTimer)
    emit(setNotice(state, text))
    noticeTimer = setTimeout(() => {
      noticeTimer = undefined
      // Same-reference guard: no churn when the notice was already cleared.
      if (state.notice !== undefined) emit(setNotice(state, undefined))
    }, ttlMs)
  }

  const composition = await composePreset(ctx, config.agentPreset ?? 'cc')
  const cwd = config.cwd ?? process.cwd()
  const selection: ModelSelectionRef = { assembled: undefined, current: undefined }

  const presetSetup = composition.setup
  const withSelection: AgentSetup = async (agentCtx, agent) => {
    if (presetSetup !== undefined) await presetSetup(agentCtx, agent)
    installModelSelection(agentCtx, selection)
  }

  const agentOptions = config.provider !== undefined && config.model !== undefined
    ? { provider: config.provider, model: config.model }
    : undefined
  const createHandle = (id: SessionId, extras: { cwd: string; agentOptions?: { provider: string; model: string } }) =>
    ctx.agents.create({
      sessionId: id,
      meta: { cwd: extras.cwd, ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset } },
      setup: withSelection,
      ...(extras.agentOptions === undefined ? {} : { agentOptions: extras.agentOptions }),
    })
  const createArgs = (id: SessionId) => ({
    sessionId: id,
    meta: { cwd, ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset } },
    setup: withSelection,
    ...agentOptions === undefined ? {} : { agentOptions },
  })

  // Boot session resolution (§2.3): non-empty sessionId → resume that id;
  // '' → explicit fresh (never read the marker); undefined + autoResume →
  // read the project marker; else fresh. `SessionId` is never built from ''.
  let resumeSession: SessionId | undefined
  let attemptedAutoResume = false
  let markerFound = false
  if (config.sessionId !== undefined && config.sessionId.length > 0) {
    resumeSession = SessionId(config.sessionId)
  } else if (config.sessionId === '') {
    resumeSession = undefined
  } else if (config.autoResume === true) {
    attemptedAutoResume = true
    const markerId = readResumeTarget({ cwd })
    markerFound = markerId !== undefined && markerId.length > 0
    resumeSession = markerFound ? SessionId(markerId!) : undefined
  }

  let resumed = false
  let handle: AgentHandle
  if (resumeSession !== undefined) {
    try {
      handle = await ctx.agents.resume({
        resumeSessionId: resumeSession,
        setup: withSelection,
        ...agentOptions === undefined ? {} : { agentOptions },
      })
      resumed = true
    } catch {
      // Stale marker: the recorded session is gone. Clear it so the next boot
      // does not loop on the same failure, then degrade to a fresh session
      // (which must not steal the marker — persist only fires on real content).
      clearResumeTarget({ cwd })
      showNotice('上次会话已失效，已开启新会话，可 /resume 手动选择')
      handle = await ctx.agents.create(createArgs(SessionId(`tui-${randomUUID()}`)))
    }
  } else {
    handle = await ctx.agents.create(createArgs(SessionId(`tui-${randomUUID()}`)))
  }

  // `-c`/`--continue` on a bare boot with nothing to continue → point at
  // /resume (a stale-marker degrade already surfaced its own notice above).
  if (attemptedAutoResume && !markerFound && config.continueRequested === true) {
    showNotice('没有可继续的上一会话，可 /resume 手动选择')
  }

  // Rebindable holder: switchSession replaces handle/agent in-place so every
  // event handler and closure reads the LIVE agent at fire time.
  const current: { handle: AgentHandle; agent: Agent } = { handle, agent: handle.agent }
  if (current.agent.options.provider !== undefined && current.agent.options.model !== undefined) {
    selection.current = { provider: current.agent.options.provider, model: current.agent.options.model }
  }
  // Deployment default-model service, effort resolution, history binding, and
  // the resume marker now live in the agent section (harness/driver-agent.ts).
  // Per-project input history: prompts and bash commands are bucketed by the
  // session's project (the main git root — worktrees collapse onto it), so
  // ↑/↓ recall never leaks across working directories. An explicit
  // config.historyDir stays an override (tests, embedding).
  let historyDir = config.historyDir
  let historyProjectKey: string | undefined
  if (historyDir === undefined) {
    const bootProject = resolveProject(cwd)
    const tuiDir = defaultTuiDir()
    coldCutGlobalHistory(tuiDir)
    historyProjectKey = bootProject.projectKey
    historyDir = join(tuiDir, 'projects', bootProject.projectKey)
  }
  // First-run onboarding gate: buffered boot flag + late-bound run-local handle.
  const onboardingGate: OnboardingGate = { modelMissing: false }
  const agent = createAgentSection({
    emit,
    state: () => state,
    ctx,
    current,
    selection,
    agentOptions,
    liveMode: liveModeWithDefault(ctx),
    historyDir,
    cwd,
    onModelMissing: () => { onboardingGate.modelMissing = true; onboardingGate.handle?.onModelMissing() },
  })
  // W4 fire-early: kick the default-model seed — submits and /effort await the
  // settled seed before dispatch; banner upsert + gated notice in continuation.
  void agent.waitForModel()
  // /resume rebinds history onto the switched session's project; the tracked
  // key makes same-project switches no-ops.
  const rebindHistory = (sessionCwd: string | undefined): void => {
    if (config.historyDir !== undefined) return
    const key = resolveProject(sessionCwd ?? cwd).projectKey
    if (key === historyProjectKey) return
    historyProjectKey = key
    agent.bindHistoryDir(join(defaultTuiDir(), 'projects', key))
  }
  // Pin a session in its project's sidecar index (exact picker membership,
  // complementing the cwd-prefix heuristic for legacy sessions).
  const recordProjectSession = (sessionId: string, sessionCwd: string | undefined): void => {
    const key = resolveProject(sessionCwd ?? cwd).projectKey
    recordProjectSessionId(join(defaultTuiDir(), 'projects', key), sessionId)
  }
  // Every "real content arrived" path (submit, run-local, dispose) writes
  // the resume marker AND pins the live session in its project's index.
  const persistResumeTargetAndIndex = (): void => {
    agent.persistResumeTarget()
    recordProjectSession(String(current.agent.session.id), liveSessionCwd(current.agent, cwd))
  }
  // Marker semantics: write on resume (self-heal) and after the first real
  // user prompt — never on an empty fresh boot; seed true + persist only on resume.
  if (resumed) {
    agent.setMarkedContent(true)
    agent.persistResumeTarget()
    // The marker can attach a session whose recorded cwd differs from the
    // process cwd (e.g. launched from another directory of the same repo):
    // scope history to the LIVE session's project and pin it in that
    // project's sidecar index.
    rebindHistory(liveSessionCwd(current.agent, cwd))
    recordProjectSession(String(current.agent.session.id), liveSessionCwd(current.agent, cwd))
  }
  emit(setPermissionMode(state, liveModeWithDefault(ctx)(current.agent)))

  // Boot banner: art + status rows before the resume fold (row 0); the
  // settled seed upserts the label + gated notice (driver-agent continuation).
  const modelLabel = selection.current?.model ?? 'default model'
  for (const row of bootBannerRows(modelLabel, cwd)) emit(upsertRow(state, row))

  // Replay the durable event log so a resumed session shows its prior
  // conversation via the agent section's presenter-bound fold. One emit for
  // the whole fold — folding is a reduce, not a per-event broadcast.
  emit(agent.foldHistory())
  // A historical log may end mid-turn if the process crashed; sync busy from
  // the ground-truth agent status before live events continue.
  emit(setBusy(state, current.agent.status === 'running'))

  // W4 await-late bound: a microtask-fast seed lands before the frame; a slow
  // seed never blocks it.
  await agent.awaitBootFrame()

  // --- Statusline: custom command wiring + HUD (branch + projections feed) ---
  const statusline = createStatusLineWiring({ emit, state: () => state, ctx, cwd, current, selection, listeners })
  const hud = createHudSection({
    emit, state: () => state, ctx, cwd, current, selection,
    branchProbe: config.branchProbe ?? gitBranchOf,
    statusline,
  })
  const { refreshBranch, seedHud, seedTodos, applyUsage, projections, statusLineOf } = hud
  // Late-bound cross-section handles: runHarness (mode/pickers) and flushQueue
  // (session/event listener) are wired after their sections are constructed.
  const actions: {
    runHarness(line: string): Promise<{ kind: string; text?: string } | undefined | null>
    flushQueue(): void
  } = {
    runHarness: async () => { throw new Error('runHarness used before init') },
    flushQueue: (): void => {},
  }

  // session/event listener (fold + working-line anchor/step + outbox flush).
  // Presenters come from the agent section; flush is late-bound through the
  // actions holder because the queue section is constructed later.
  attachSessionEvents({
    emit,
    state: () => state,
    ctx,
    current,
    liveMode: liveModeWithDefault(ctx),
    presenters: agent.presenters,
    flushQueue: () => actions.flushQueue(),
    showNotice,
  })

  // --- Modal pipeline: approvals + questions share one FIFO ------------------
  const approvals = createApprovalsSection({ emit, state: () => state, ctx, current, showNotice })
  const modeSection = createModeSection({
    emit,
    state: () => state,
    current,
    projections,
    showNotice,
    runHarness: (line) => actions.runHarness(line),
    getRules: () => ctx.get('permissionRules') as PermissionRulesLike | undefined,
    liveMode: liveModeWithDefault(ctx),
  })
  // Slash-command catalog + subagent lifecycle listeners.
  const catalog = createCatalogSection({ emit, state: () => state, current, ctx })

  // Model/effort/permission pickers; resolveEfforts/stalePair/loadCatalog come
  // from the agent section (they read `llm` off the host ctx).
  const pickers = createPickersSection({
    emit,
    state: () => state,
    selection,
    current,
    liveMode: liveModeWithDefault(ctx),
    resolveEfforts: agent.resolveEfforts,
    stalePair: agent.stalePair,
    loadCatalog: agent.loadCatalog,
    runHarness: (line) => actions.runHarness(line),
  })
  const { openModelPicker, applyModelSwitch, openEffortPicker, openPermissionPicker } = pickers

  // --- Session switching: /resume overlay + driver.switchSession ----------
  const sessions = createSessionsSection({
    emit,
    state: () => state,
    ctx,
    cwd,
    current,
    selection,
    liveMode: liveModeWithDefault(ctx),
    seedDefaultModel: agent.seedDefaultModel,
    foldHistory: agent.foldHistory,
    seedHud,
    seedTodos,
    refreshBranch,
    writeResumeTarget: (id: string) => writeResumeTarget(id, {
      // Keys off the LIVE session's project (a switch into a session
      // created elsewhere writes its own bucket).
      cwd: current.agent.session.header.cwd ?? cwd,
    }),
    setMarkedContent: agent.setMarkedContent,
    rebindHistory,
    recordProjectSession,
    spliceAll: () => approvals.spliceAll(),
    refreshCatalog: () => catalog.refreshCatalog(),
    createHandle,
    reapplyMode: (mode: string) => { modeSection.applyMode(mode as never); return modeSection.modeWrites },
    withSelection,
    agentOptions,
  })
  const switchSession = sessions.switchSession
  const openSessionSwitcher = sessions.openSessionSwitcher

  // Local slash commands (/export-md, /copy, runLocal) + host-command dispatch.
  const runLocalSection = createRunLocalSection({
    emit,
    state: () => state,
    ctx,
    cwd,
    config,
    current,
    selection,
    projections,
    applyUsage,
    showNotice,
    switchSession,
    startFreshSession: sessions.startFreshSession,
    openSessionSwitcher,
    openModelPicker,
    applyModelSwitch,
    openEffortPicker,
    loadCatalog: agent.loadCatalog,
    resolveEfforts: agent.resolveEfforts,
    waitForModel: agent.waitForModel,
    persistResumeTarget: persistResumeTargetAndIndex,
    getMarkedContent: agent.getMarkedContent,
    setMarkedContent: agent.setMarkedContent,
    listeners,
    onboardingGate,
  })
  const { runLocal, runHarness } = runLocalSection
  actions.runHarness = runHarness

  // --- `!` bash mode: local shell commands -----------------------------------
  const bashCtx: DriverBashCtx = {
    state: () => state,
    emit,
    cwd,
    shell: agent.shell,
    appendBashHistory: agent.appendBashHistory,
  }
  const runShellCommand = (raw: string): Promise<void> => runShellCommandModule(bashCtx, raw)

  // Outbox queue + submit/interrupt pipeline; history rebinds through the agent
  // section's get/set seams.
  const queue = createQueueSection({
    emit,
    state: () => state,
    current,
    ctx,
    runLocal,
    runHarness,
    openPermissionPicker,
    showNotice,
    runShellCommand,
    getHistory: agent.getHistory,
    setHistory: agent.setHistory,
    // Live getter, not a snapshot: /resume may rebind the history directory
    // onto the switched session's project between submits.
    get historyDir() { return agent.historyDir },
    persistResumeTarget: persistResumeTargetAndIndex,
    setMarkedContent: agent.setMarkedContent,
    waitForModel: agent.waitForModel,
  } satisfies DriverQueueCtx)
  actions.flushQueue = () => queue.flushQueue()

  // --- Ctrl+B promotion (UX plan §3.4): see harness/driver-promote.ts --------
  // The collect path (Task tool) registers each in-flight foreground collect
  // of this session in the root-realm `ccCollectorRegistry`; promote() on a
  // handle releases the wait and leaves the child untouched.
  const promoteForegroundCollects = createPromoteSection(ctx, current)

  return {
    get state() { return state },
    get statusLine() { return statusLineOf() },
    statusLineIn: (width?: number) => statusLineOf(width),
    get cwd() { return cwd },
    get promptHistory() { return agent.getHistory() },
    get bashHistory() { return agent.getBashHistory() },
    subscribe(listener) {
      listeners.add(listener)
      listener(state)
      return () => { listeners.delete(listener) }
    },
    setDraft: (draft) => { emit(setDraft(state, draft)) },
    submit: queue.submit,
    interrupt: queue.interrupt,
    steerQueued: queue.steerQueued,
    recallQueued: queue.recallQueued,
    promoteForegroundCollects,
    cyclePermissionMode: () => modeSection.cyclePermissionMode(),
    toggleGlobalCollapse() { emit(toggleGlobalCollapse(state)) },
    toggleThinking() { emit(toggleThinking(state)) },
    answerApproval: (kind: ApprovalAnswerKind) => approvals.answerApproval(kind),
    questionMove: (delta) => approvals.questionMove(delta),
    questionToggle: () => approvals.questionToggle(),
    questionPick: (index) => approvals.questionPick(index),
    questionType: (text) => approvals.questionType(text),
    questionBackspace: () => approvals.questionBackspace(),
    questionSubmit: () => approvals.questionSubmit(),
    questionCancel: () => approvals.questionCancel(),
    openModelPicker: () => pickers.openModelPicker(),
    modelPickerMove: (delta) => pickers.modelPickerMove(delta),
    modelPickerSubmit: () => pickers.modelPickerSubmit(),
    modelPickerCancel: () => pickers.modelPickerCancel(),
    openEffortPicker: () => pickers.openEffortPicker(),
    effortPickerMove: (delta) => pickers.effortPickerMove(delta),
    effortPickerSubmit: () => pickers.effortPickerSubmit(),
    effortPickerCancel: () => pickers.effortPickerCancel(),
    openPermissionPicker: async () => { pickers.openPermissionPicker() },
    permissionPickerMove: (delta) => pickers.permissionPickerMove(delta),
    permissionPickerSubmit: () => pickers.permissionPickerSubmit(),
    permissionPickerCancel: () => pickers.permissionPickerCancel(),
    openSessionSwitcher: () => sessions.openSessionSwitcher(),
    sessionSwitcherMove: (delta) => sessions.sessionSwitcherMove(delta),
    sessionSwitcherType: (text) => sessions.sessionSwitcherType(text),
    sessionSwitcherBackspace: () => sessions.sessionSwitcherBackspace(),
    sessionSwitcherToggleScope: () => sessions.sessionSwitcherToggleScope(),
    sessionSwitcherSubmit: () => sessions.sessionSwitcherSubmit(),
    sessionSwitcherCancel: () => sessions.sessionSwitcherCancel(),
    toggleTodoPanel() {
      if (state.todoPanel !== undefined) { emit(closeTodoPanel(state)); return }
      emit(openTodoPanel(state))
    },
    todoPanelMove: (delta) => emit(moveTodoPanelFocus(state, delta)),
    todoPanelClose: () => emit(closeTodoPanel(state)),
    usagePanelClose: () => emit(closeUsagePanel(state)),
    worktreeExitMove: (delta) => runLocalSection.worktreeExitMove(delta),
    worktreeExitSubmit: () => runLocalSection.worktreeExitSubmit(),
    worktreeExitCancel: () => runLocalSection.worktreeExitCancel(),
    showNotice,
    // `/provider` read path + action flows; the section is created in driver-run-local
    providerRuntime: runLocalSection.providerRuntime,
    markExitAttempt: (now) => emit(markExitAttempt(state, now ?? Date.now())),
    switchSession: (id) => sessions.switchSession(id),
    listSessions: () => sessions.listSessions(),
    loadModelCatalog: () => pickers.loadModelCatalog(),
    loadModelEfforts: () => pickers.loadModelEfforts(),
    listCommands: () => catalog.listCommands(),
    async dispose() {
      statusline.dispose()
      runLocalSection.onboarding.dispose()
      if (noticeTimer !== undefined) { clearTimeout(noticeTimer); noticeTimer = undefined }
      approvals.dispose()
      if (agent.getMarkedContent()) persistResumeTargetAndIndex()
      await current.handle.dispose()
    },
  }
}
