/**
 * Driver wiring for the custom status line (plan §4/Slice 4): settings
 * registration (`statusline` namespace via installSettingsSection, tolerant
 * when no settings provider is mounted), the lazily-created command runner,
 * the refreshInterval timer (owned here — a documented deviation from the
 * plan's "inside the runner" phrasing; same observable behavior, and the
 * runner stays timer-free beyond its own debounce/cap), payload assembly at
 * fire time from live state, and the trigger seams: projections onChanged +
 * boot/rebind (hooked by driver-hud.ts), and the emit-diff wrapper (S1) over
 * the driver's listener fan-out diffing permissionMode and the model/effort
 * selection. Feature stays inert when the shell service is absent (D6/N3 —
 * never the execFileAsync fallback).
 * @module @dsh-cc/tui/harness/statusline-wiring
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import type { TuiState } from '../store.ts'
import {
  type ContextPressureStateLike,
  type SessionProjectionsLike,
  type ShellExecutorLike,
  type TokenUsageStateLike,
} from '../state/driver-types.ts'
import { lastBucketsOf, tokensOf } from './usage-view.ts'
import { createStatusLineCommand, type StatusLineCommand } from './statusline-command.ts'
import { buildStatusLinePayload } from './statusline-payload.ts'
import { createCcTranscriptMirror, type CcTranscriptMirror } from './statusline-cc-transcript.ts'
import {
  STATUSLINE_SECTION_SCHEMA,
  STATUSLINE_SETTINGS_NAMESPACE,
  describeStatusLine,
  statusLineSectionSchema,
  type StatusLineDescription,
} from './statusline-settings.ts'

/** Handle driver-hud.ts uses to consult/trigger the custom status line. */
export type StatusLineSectionHandle = {
  /** The custom line when active (`' '.repeat(padding) + latest()`); else undefined. */
  override(): string | undefined
  /** A projection unit changed for the live session (debounced trigger). */
  onProjection(key: string): void
  /** The session was (re)bound — run once for the new session (C4). */
  onRebind(): void
}

/** The slice of createDriver's closed-over state the wiring needs. */
export type StatusLineWiringCtx = {
  emit(next: TuiState): void
  state(): TuiState
  ctx: Context
  cwd: string
  current: { agent: Agent }
  selection: ModelSelectionRef
  /** The driver's emit listener set — the wiring rides it as the S1 diff seam. */
  listeners: Set<(state: TuiState) => void>
}

/** Fallback terminal dimensions when stdout is not a TTY. */
const FALLBACK_COLUMNS = 80
const FALLBACK_ROWS = 24

export function createStatusLineWiring(
  rt: StatusLineWiringCtx,
  options: { transcriptDir?: string } = {},
): StatusLineSectionHandle & { dispose(): void } {
  const { state, emit, ctx, cwd, current, selection } = rt
  const executor = ctx.get('shell') as ShellExecutorLike | undefined
  const projections = ctx.get('sessionProjections') as SessionProjectionsLike | undefined
  const bindTimeMs = Date.now()

  let description: StatusLineDescription = { active: false }
  let runner: StatusLineCommand | undefined
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  let source: (() => unknown) | undefined
  // The session id the runner was last fired for — a /resume-style rebind
  // re-runs only when it actually changed (the boot-time seedHud call must
  // not discard the initial activation's run via the generation guard).
  let boundSessionId = String(current.agent.session.id)
  // The CC transcript mirror (Slice C) — created lazily on first activation so
  // users without a statusline never write files.
  let mirror: CcTranscriptMirror | undefined
  let unsubscribeEvents: (() => void) | undefined

  /**
   * Bind the transcript mirror to the CURRENT session: subscribe the live
   * event tap (guarded by session id), snapshot + rebuild from the full event
   * log, then re-drain the tail so a live append landing between snapshot and
   * subscribe (or to the old inode before rename) is not lost — append is
   * idempotent under the seq watermark guard. Idempotent; safe on rebind.
   */
  function bindTranscriptMirror(): void {
    const sessionId = String(current.agent.session.id)
    if (mirror === undefined) {
      mirror = options.transcriptDir === undefined
        ? createCcTranscriptMirror()
        : createCcTranscriptMirror({ dir: options.transcriptDir })
    }
    unsubscribeEvents?.()
    unsubscribeEvents = undefined
    unsubscribeEvents = ctx.on('session/event', (session, event) => {
      // Guard against late events from a disposed/rebound session.
      if (String((session as { id?: unknown })?.id) !== String(current.agent.session.id)) return
      mirror?.append(event)
    })
    const eventsOf = (): readonly unknown[] => {
      const events = (current.agent.session as { events?: unknown }).events
      return Array.isArray(events) ? events : []
    }
    // Snapshot, rebuild, then re-drain: the watermark was taken at snapshot
    // time inside rebind, so any event appended since (live tap raced the
    // snapshot, or wrote to the pre-rename inode) re-flows through append.
    const snapshot = eventsOf()
    mirror.rebind(sessionId, snapshot)
    for (const event of eventsOf()) mirror.append(event)
  }

  /** Assemble the CC-shaped payload at fire time from live state (§3.4). */
  function payloadFor(): Record<string, unknown> {
    const session = current.agent.session
    const header = session.header as { cwd?: string; createdAt?: number }
    const pressure = projections?.stateOf(session, 'contextPressure') as ContextPressureStateLike | undefined
    // One read of the tokenUsage projection feeds both the cumulative totals
    // and the last step's buckets (the CC current_usage source).
    const tokenUsage = projections?.stateOf(session, 'tokenUsage') as TokenUsageStateLike | undefined
    const tokens = tokensOf(tokenUsage)
    const currentUsage = lastBucketsOf(tokenUsage)
    const sessionCwd = header.cwd ?? cwd
    // transcript_path is advertised only while the CC-shape mirror is ready
    // (an unreadable/empty file would yield all-zeros that shadow the stdin
    // fallbacks above — ccstatusline's `??` chain passes zeros through).
    const model = selection.current?.model
    const effort = selection.current?.reasoningEffort
    return buildStatusLinePayload({
      driverCwd: cwd,
      sessionCwd,
      projectDir: cwd,
      sessionId: String(session.id),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(tokens === undefined ? {} : { inputTokens: tokens.input, outputTokens: tokens.output }),
      ...(currentUsage === undefined ? {} : { currentUsage }),
      ...(pressure?.contextWindow === undefined ? {} : { contextWindowTokens: pressure.contextWindow }),
      ...(pressure?.pressureTokens === undefined ? {} : { pressureTokens: pressure.pressureTokens }),
      ...(mirror?.isReady() === true && mirror.getPath() !== undefined
        ? { transcriptPath: mirror.getPath()! }
        : {}),
      ...(header.createdAt === undefined ? {} : { sessionCreatedAtMs: header.createdAt }),
      bindTimeMs,
      nowMs: Date.now(),
    })
  }

  /** Trigger a run with a fresh payload (no-op while inactive). */
  function fire(options?: { immediate?: boolean }): void {
    if (runner === undefined || !description.active) return
    runner.update(
      { command: description.command },
      payloadFor(),
      {
        ...(options?.immediate === true ? { immediate: true } : {}),
        workdir: current.agent.session.header.cwd ?? cwd,
      },
    )
  }

  function clearRefreshTimer(): void {
    if (refreshTimer !== undefined) {
      clearInterval(refreshTimer)
      refreshTimer = undefined
    }
  }

  /** Arm exactly one SECONDS-based refresh interval while active. */
  function restartRefreshTimer(): void {
    clearRefreshTimer()
    if (!description.active || description.refreshIntervalSec === undefined) return
    refreshTimer = setInterval(() => fire(), description.refreshIntervalSec! * 1000)
  }

  /** Tear the runner down (deactivation or dispose) and restore the built-in line. */
  function deactivate(reEmit = true): void {
    clearRefreshTimer()
    unsubscribeEvents?.()
    unsubscribeEvents = undefined
    runner?.dispose()
    runner = undefined
    // Same-reference re-emit so root re-reads the built-in lane; suppressed
    // on dispose — teardown must not produce emissions.
    if (reEmit) emit(state())
  }

  function activate(): void {
    runner = createStatusLineCommand({
      executor: executor!,
      terminalSize: () => ({
        columns: process.stdout.columns ?? FALLBACK_COLUMNS,
        rows: process.stdout.rows ?? FALLBACK_ROWS,
      }),
      onSettled: () => {
        // Same store→emit path the HUD uses (R6): a same-reference re-emit
        // re-notifies subscribers so root re-reads statusLineIn.
        if (description.active) emit(state())
      },
    })
    restartRefreshTimer()
    // Mirror first, then the first frame (immediate fire) reads a ready path.
    bindTranscriptMirror()
    // Session start runs once, immediately (C4/C5).
    fire({ immediate: true })
  }

  /** Re-judge the live description; drives the whole activation state machine. */
  function resolve(): void {
    const next = executor === undefined
      ? ({ active: false } as const)
      : describeStatusLine(statusLineSectionOf(source?.()))
    const prev = description
    description = next
    if (!next.active) {
      if (prev.active) deactivate()
      return
    }
    if (!prev.active) {
      activate()
      return
    }
    if (prev.command !== next.command) {
      // A command change skips the debounce (C5).
      restartRefreshTimer()
      fire({ immediate: true })
      return
    }
    restartRefreshTimer()
    fire()
  }

  // Settings registration (D5): tolerated when no settings provider is
  // mounted — installSettingsSection only wires while a provider exists, and
  // test/host ctxs without `inject` keep the feature fully inert.
  if (typeof (ctx as { inject?: unknown }).inject === 'function') {
    installSettingsSection(ctx, STATUSLINE_SETTINGS_NAMESPACE, STATUSLINE_SECTION_SCHEMA, {}, {
      setSource: (currentSection) => {
        source = () => currentSection()
      },
      onChange: () => resolve(),
    })
  }

  // S1 emit-diff seam: fire on permission-mode and model/effort changes by
  // diffing across each emission (fires for every emit path by construction).
  let seenEmit = false
  let lastMode: string | undefined
  let lastSelection: ModelSelectionRef['current']
  rt.listeners.add((_) => {
    const mode = state().permissionMode
    const currentSelection = selection.current
    if (seenEmit && (mode !== lastMode || currentSelection !== lastSelection)) fire()
    seenEmit = true
    lastMode = mode
    lastSelection = currentSelection
  })

  return {
    override(): string | undefined {
      if (!description.active || runner === undefined) return undefined
      // Pad each content row (multi-row runner output, plan D2); the
      // client-drawn mode row is never padded (added in driver-hud).
      const pad = ' '.repeat(description.padding)
      return runner.latest().split('\n').map(row => pad + row).join('\n')
    },
    onProjection(_key: string): void {
      fire()
    },
    onRebind(): void {
      const sessionId = String(current.agent.session.id)
      if (sessionId === boundSessionId) return
      boundSessionId = sessionId
      // Rebind the transcript mirror to the NEW session before firing so the
      // re-run's payload advertises the new session's mirror, not the old one.
      if (mirror !== undefined && runner !== undefined) bindTranscriptMirror()
      if (runner !== undefined) fire()
    },
    dispose(): void {
      deactivate(false)
    },
  }
}

/** Tolerant re-parse of the live source into the known section shape. */
function statusLineSectionOf(raw: unknown): Parameters<typeof statusLineSectionSchema>[0] {
  return statusLineSectionSchema(typeof raw === 'object' && raw !== null ? raw as never : undefined)
}
