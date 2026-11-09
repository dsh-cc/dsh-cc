/**
 * The per-session extraction coordinator: review watermark, single-flight job
 * lifecycle, skip auditing, failure cooldown and disposal (design
 * docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md §"State machine
 * and commit rules", §"Degradation and lifecycle truth table").
 *
 * One state per `(canonical memoryDir, session header id)`, bound to the Agent
 * object that owns it. The coordinator exists only for the `shadow` and
 * `active` modes: `off` is the legacy listener's business and never reaches
 * this file, so nothing here reads a decision runner or creates watermark state
 * in `off`.
 *
 * The rules that matter for correctness, in one place:
 * - DISPATCH IS NOT COMPLETION. Only `job.done` with status `completed` (after
 *   the host validated and wrote the batch) advances `reviewedThrough`, and only
 *   up to the head captured when the generation started.
 * - A skip verdict is only committed after the evidence head, the window hash,
 *   the index hash, the scope, the generation and the LIVE MODE SNAPSHOT all
 *   still equal the captured ones. A mode flip to `off` observed there discards
 *   the verdict without moving the watermark and without starting a fallback.
 * - A new stop during gating/extraction only moves `pendingHead`; the running
 *   generation keeps its own captured window.
 * - Failures cool down; there is no retry timer and no while-loop retry. A later
 *   stop is the retry.
 * - The short-lived `agent/turn-stopping` signal is consulted ONLY at entry.
 *   The internal AbortController is driven by Agent/plugin disposal, a scope
 *   change or an owner takeover, so a long job is never cancelled by idleness.
 *
 * @module @dsh-cc/memory-consolidation/extraction-coordinator
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BoundDecisionRunner } from '@dsh-cc/systemone'
import type { ExtractionSettingsReader } from './extraction-settings.ts'
import { type ExtractionWindow, type GateExtractReason, type IndexSnapshot } from './extraction-window.ts'
import { buildWindowFor, decideWindow, mintScope, type GateOutcome } from './extraction-gate-runner.ts'
import { buildExtractionPrompt, buildWindowedExtractionPrompt } from './prompts.ts'
import {
  acquireMemoryMutationLease,
  tryAcquireMemoryMutationLease,
  type MemoryMutationLease,
} from './mutation-lease.ts'
import type { MemoryJobControl } from './memory-job.ts'
import {
  boundedWait,
  cancelEntry,
  commitReviewed,
  createEntry,
  discardForOffMode as discardForOffModeState,
  DISPOSE_REASON,
  enterCooldown as enterCooldownState,
  phaseOf,
  selectEvictions,
  stateKey,
  TAKEOVER_REASON,
  type ExtractionState,
  type Frame,
  type SessionEntry,
} from './extraction-state.ts'
import { evidenceHeadOf, surfaceCountOf } from './extraction-evidence.ts'
import type { ExtractionIndexRead } from './extraction-index.ts'
import { verifySkipCommit, type PreCommit } from './extraction-precommit.ts'

export type { ExtractionState, SessionEntry } from './extraction-state.ts'
export type { ExtractionIndexRead } from './extraction-index.ts'

/**
 * Fixed bound on every wait for a foreign job to settle: the owner takeover wait
 * and the active/shadow → off teardown wait (design §"Degradation and lifecycle
 * truth table": "the 10-second grace").
 */
export const TAKEOVER_GRACE_MS = 10_000

/** One memory-job dispatch request, handed to {@link ExtractionCoordinatorDeps.startJob}. */
export interface ExtractionJobRequest {
  readonly agent: Agent
  readonly memoryDir: string
  readonly prompt: string
  /** The exact index content the prompt injected; the write-back baseline. */
  readonly baselineIndex: string
}

/** Injectable seams of the coordinator. */
export interface ExtractionCoordinatorDeps {
  /** Live effective-settings snapshot (re-read per gate and per pre-commit check). */
  readonly readSettings: ExtractionSettingsReader
  /** The canonical writable memory directory of one Agent. */
  readonly memoryDirOf: (agent: Agent) => string
  /** Read the existing topic index once, in both required shapes. */
  readonly readIndex: (memoryDir: string) => Promise<ExtractionIndexRead>
  /** Dispatch one extraction fork and hand back its control object. */
  readonly startJob: (request: ExtractionJobRequest) => Promise<MemoryJobControl>
  /**
   * Resolve the runner bound to this Agent, per gate. Obtained through the
   * root-realm bridge and never cached across gates (the provide may appear or
   * dispose at any time); absent means "extract as unavailable".
   */
  readonly resolveRunner?: (agent: Agent) => BoundDecisionRunner | undefined
  /** Clock seam (tests drive cooldown windows with it). */
  readonly now?: () => number
  /**
   * The mutation lease this plugin instance shares with dream. Defaults to the
   * module-level table; the plugin passes its own per-mount table so a second
   * tree in the same process cannot inherit this tree's writer.
   */
  readonly lease?: MemoryMutationLease
  /** Microtask seam for the pending drain (tests drain manually). */
  readonly schedule?: (task: () => void) => void
  /** Override for {@link TAKEOVER_GRACE_MS} (tests only). */
  readonly graceMs?: number
  /** Structured, text-free diagnostics: fixed event names and numeric fields only. */
  readonly log?: (event: string, fields?: Record<string, number>) => void
}

/** What a caller of the coordinator can do. */
export interface ExtractionCoordinator {
  /**
   * The `agent/turn-stopping` entry point. The synchronous part does every
   * cancellation/topology check, captures the evidence head and decides whether
   * work may start; all I/O happens afterwards.
   */
  onTurnStopping(event: { readonly agent: Agent; readonly signal: AbortSignal }): void
  /**
   * Block new work, cancel the running gate/job and wait (bounded) for every
   * in-flight job to settle, then clear the in-memory watermarks. This is the
   * active/shadow → off handoff; it never throws.
   */
  quiesce(graceMs?: number): Promise<void>
  /** Abort every gate/job and destroy the states (Agent/plugin disposal). */
  dispose(): void
  /** Read-only diagnostics view of one session state. */
  stateOf(memoryDir: string, sessionId: string): ExtractionState | undefined
}

/**
 * Build one coordinator.
 * @param deps - the injected seams.
 * @returns the coordinator.
 */
export function createExtractionCoordinator(deps: ExtractionCoordinatorDeps): ExtractionCoordinator {
  const now = deps.now ?? (() => Date.now())
  const schedule = deps.schedule ?? ((task: () => void) => { queueMicrotask(task) })
  const graceMs = deps.graceMs ?? TAKEOVER_GRACE_MS
  const lease: MemoryMutationLease = deps.lease
    ?? { acquire: acquireMemoryMutationLease, tryAcquire: tryAcquireMemoryMutationLease }
  const entries = new Map<string, SessionEntry>()
  /** Set by dispose(): no new work, every state destroyed. */
  let disposed = false
  /** Set while quiesce() drains: the mode-flip handoff blocks new work. */
  let blocked = false

  const log = (event: string, fields?: Record<string, number>): void => {
    if (deps.log !== undefined) deps.log(event, fields)
  }

  const createEntryFor = (memoryDir: string, sessionId: string, agent: Agent): SessionEntry =>
    createEntry(memoryDir, sessionId, agent, now())

  /** Drop the mutation lease this entry owns (idempotent: release is one-shot). */
  const releaseLeaseOf = (entry: SessionEntry): void => {
    const lease = entry.lease
    entry.lease = undefined
    if (lease === undefined) return
    try {
      lease()
    } catch { /* a teardown path never throws */ }
  }

  /** Whether this generation still owns the entry (identity, generation, liveness). */
  const isCurrent = (entry: SessionEntry, frame: Frame): boolean =>
    !disposed
    && entries.get(entry.key) === entry
    && entry.state.generation === frame.generation
    && entry.state.phase !== 'disposed'
    && !frame.controller.signal.aborted

  /** LRU convergence: evict the oldest idle/cooldown states beyond the cap. */
  const evictIdle = (keep: SessionEntry): void => {
    const evicted = selectEvictions(entries.values(), deps.readSettings().sessionStateCap, keep)
    for (const entry of evicted) {
      entries.delete(entry.key)
      log('memory:extraction-lru-evict')
    }
  }

  /** Reconstruct one captured window over a fresh index snapshot. */
  const buildWindow = (entry: SessionEntry, frame: Frame, index: IndexSnapshot): ExtractionWindow =>
    buildWindowFor({
      agent: entry.agent,
      from: frame.from,
      through: frame.through,
      index,
      settings: deps.readSettings(),
    })

  /**
   * The pre-commit check a skip must survive: live mode, generation, disposed,
   * evidence head, window/evidence hash, index hash and scope identity.
   */
  const preCommit = (entry: SessionEntry, frame: Frame, window: ExtractionWindow, outcome: GateOutcome): Promise<PreCommit> =>
    verifySkipCommit({
      capture: { window, runner: outcome.runner, scope: outcome.scope, through: frame.through },
      isCurrent: () => isCurrent(entry, frame),
      readMode: () => deps.readSettings().mode,
      evidenceHead: () => evidenceHeadOf(entry.agent.session.snapshotEvents()),
      readIndex: () => deps.readIndex(entry.memoryDir),
      rebuild: (index) => buildWindow(entry, frame, index),
      mintScope,
    })

  /** Commit a reviewed window (the watermark only ever moves forward). */
  const commit = (entry: SessionEntry, frame: Frame): void => {
    commitReviewed(entry.state, frame.through, now())
    log('memory:extraction-committed', { reviewedThrough: entry.state.reviewedThrough })
  }

  /** Enter the failure cooldown: a later stop is the only retry. */
  const enterCooldown = (entry: SessionEntry, frame: Frame): void => {
    if (!isCurrent(entry, frame)) return
    enterCooldownState(entry.state, now() + deps.readSettings().failureCooldownMs, now())
    log('memory:extraction-cooldown', { retryAt: entry.state.retryAt })
  }

  /** Drop a verdict because the mode flipped to off: no watermark move, no fallback. */
  const discardForOffMode = (entry: SessionEntry): void => {
    discardForOffModeState(entry.state, now())
    log('memory:extraction-mode-off-discard', { reviewedThrough: entry.state.reviewedThrough })
  }

  /** After one generation settles: converge the LRU and drain a later stop. */
  const settleGeneration = (entry: SessionEntry, frame: Frame): void => {
    const state = entry.state
    if (entries.get(entry.key) === entry && state.generation === frame.generation && state.phase !== 'disposed') {
      delete state.active
      if (state.phase !== 'cooldown') state.phase = 'idle'
      state.lastUsedAt = now()
    }
    evictIdle(entry)
    if (disposed || blocked) return
    if (entries.get(entry.key) !== entry || state.generation !== frame.generation) return
    if (state.phase !== 'idle') return
    const pending = state.pendingHead
    if (pending === undefined || pending <= state.reviewedThrough) return
    log('memory:extraction-drain')
    schedule(() => {
      if (disposed || blocked) return
      if (entries.get(entry.key) !== entry || entry.state !== state) return
      if (state.phase !== 'idle') return
      if (deps.readSettings().mode === 'off') return
      beginGeneration(entry, undefined)
    })
  }

  /**
   * The extraction path: lease first, then re-verify, then the windowed prompt
   * (complete window) or the ORIGINAL whole-session prompt (never a faked
   * complete window), then await `job.done` before any watermark commit.
   */
  const extract = async (
    entry: SessionEntry,
    frame: Frame,
    window: ExtractionWindow,
    reason: GateExtractReason,
  ): Promise<void> => {
    const state = entry.state
    state.phase = 'waiting-lease'
    let release: () => void
    try {
      release = await lease.acquire(entry.memoryDir, frame.controller.signal)
    } catch {
      // Cancelled or disposed while queueing: no lease, no fallback, no cooldown.
      return
    }
    // Published on the entry so an owner takeover, a mode handoff or a disposal
    // can free the slot without waiting for a foreign job to settle.
    entry.lease = release
    try {
      if (!isCurrent(entry, frame)) return
      const settings = deps.readSettings()
      if (settings.mode === 'off') {
        discardForOffMode(entry)
        return
      }
      const read = await deps.readIndex(entry.memoryDir)
      if (!isCurrent(entry, frame)) return
      const rebuilt = buildWindow(entry, frame, read.snapshot)
      // A window that no longer matches the captured review is not the reviewed
      // material: fall back to the whole-session prompt instead of faking it.
      const windowed = rebuilt.complete && rebuilt.evidenceHash === window.evidenceHash
      const prompt = windowed
        ? buildWindowedExtractionPrompt(rebuilt, entry.memoryDir)
        : buildExtractionPrompt(surfaceCountOf(entry.agent.session.snapshotEvents()), entry.memoryDir, read.promptIndex)
      const baselineIndex = windowed ? rebuilt.existingIndex : read.promptIndex
      state.phase = 'extracting'
      // The reason is a fixed enum member, so it belongs in the event name.
      log(`memory:extraction-extract:${reason}`, { through: frame.through })
      const job = await deps.startJob({
        agent: entry.agent,
        memoryDir: entry.memoryDir,
        prompt,
        baselineIndex,
      })
      entry.job = job
      const outcome = await job.done
      if (entry.job === job) entry.job = undefined
      if (!isCurrent(entry, frame)) return
      if (outcome.status === 'completed') {
        // Dispatch was only the start: the host write-back completed this batch.
        commit(entry, frame)
        return
      }
      // `killed` is an intentional abort: disposal ends the state, any other
      // cancellation enters the cooldown (and a later stop is the retry).
      if (phaseOf(state) === 'disposed') return
      log('memory:extraction-failed', { through: frame.through })
      enterCooldown(entry, frame)
    } finally {
      if (entry.lease === release) entry.lease = undefined
      release()
    }
  }

  /** One generation: gate, then commit a skip, extract, or discard. */
  const runGeneration = async (entry: SessionEntry, frame: Frame, wait?: Promise<void>): Promise<void> => {
    const state = entry.state
    try {
      if (wait !== undefined) await wait
      if (!isCurrent(entry, frame)) return
      if (deps.readSettings().mode === 'off') {
        discardForOffMode(entry)
        return
      }
      const read = await deps.readIndex(entry.memoryDir)
      if (!isCurrent(entry, frame)) return
      const window = buildWindow(entry, frame, read.snapshot)
      const outcome = await decideWindow({
        agent: entry.agent,
        window,
        through: frame.through,
        signal: frame.controller.signal,
        ...(deps.resolveRunner === undefined ? {} : { resolveRunner: deps.resolveRunner }),
        readSettings: deps.readSettings,
      })
      const verdict = outcome.verdict
      if (verdict.kind === 'cancelled') return
      if (verdict.kind === 'skip') {
        const checked = await preCommit(entry, frame, window, outcome)
        if (checked === 'mode-off') {
          discardForOffMode(entry)
          return
        }
        if (checked !== 'ok') {
          // New evidence or a changed index invalidates the old verdict: keep the
          // new head and let the drain cover everything unreviewed.
          log('memory:extraction-skip-discarded', { reviewedThrough: state.reviewedThrough })
          return
        }
        state.skipOrdinal += 1
        const audit = state.skipOrdinal % deps.readSettings().auditEveryNSkips === 0
        if (deps.readSettings().mode === 'active' && !audit) {
          commit(entry, frame)
          log('memory:extraction-skip', { reviewedThrough: state.reviewedThrough, skipOrdinal: state.skipOrdinal })
          return
        }
        // An audited skip always extracts. Shadow cannot commit at all, so its
        // ineligible would-skip runs the fork and reports the decision as
        // not-committable; `audit` keeps the audited ordinal distinguishable.
        if (audit) log('memory:extraction-audit', { skipOrdinal: state.skipOrdinal })
        await extract(entry, frame, window, audit ? 'audit' : 'unavailable')
        return
      }
      await extract(entry, frame, window, verdict.reason)
    } catch {
      // A coordinator fault must never fail the turn or strand the lease.
      log('memory:extraction-fault', { through: frame.through })
      enterCooldown(entry, frame)
    } finally {
      settleGeneration(entry, frame)
    }
  }

  /** Start (or restart) the one generation of this entry, pinning its inputs. */
  const beginGeneration = (entry: SessionEntry, wait: Promise<void> | undefined): void => {
    const state = entry.state
    const generation = state.generation + 1
    const through = state.pendingHead ?? state.reviewedThrough
    const controller = new AbortController()
    state.generation = generation
    state.phase = 'gating'
    state.active = { generation, through, controller }
    state.lastUsedAt = now()
    const frame: Frame = { generation, from: state.reviewedThrough, through, controller }
    void runGeneration(entry, frame, wait)
  }

  /**
   * Take over a key from another Agent instance: cancel the old owner, bound the
   * wait for its job.done by the grace, and start the new state at watermark -1.
   * The old unverified review result is never inherited; a late completion is
   * still host-validated, only its watermark commit is dropped.
   */
  const takeOver = (previous: SessionEntry, agent: Agent, memoryDir: string): SessionEntry => {
    log('memory:extraction-takeover')
    const settled = cancelEntry(previous, TAKEOVER_REASON)
    const fresh = createEntryFor(memoryDir, previous.sessionId, agent)
    // The old owner's lease is freed once its job settles OR the grace expires:
    // the new owner must never inherit the old slot, and must never wait longer
    // than the fixed grace for it either.
    fresh.gateWait = boundedWait(settled, graceMs).then(() => { releaseLeaseOf(previous) })
    entries.set(fresh.key, fresh)
    return fresh
  }

  /** Cancel every entry and destroy the map; the callers own the lease release. */
  const teardown = (reason: string): Array<{ entry: SessionEntry; settled: Promise<void> }> => {
    const cancelled: Array<{ entry: SessionEntry; settled: Promise<void> }> = []
    for (const entry of [...entries.values()]) cancelled.push({ entry, settled: cancelEntry(entry, reason) })
    entries.clear()
    return cancelled
  }

  const onTurnStopping = (event: { readonly agent: Agent; readonly signal: AbortSignal }): void => {
    if (disposed || blocked) return
    // The short-lived turn signal is consulted HERE and nowhere else.
    if (event.signal.aborted) return
    const settings = deps.readSettings()
    if (settings.mode === 'off') return
    const agent = event.agent
    const sessionId = agent.session.header.id
    const cwd = agent.session.header.cwd
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    if (typeof cwd !== 'string' || cwd.length === 0) return
    let memoryDir: string
    try {
      memoryDir = deps.memoryDirOf(agent)
    } catch {
      return
    }
    if (memoryDir.length === 0) return
    const head = evidenceHeadOf(agent.session.snapshotEvents())
    if (head === undefined) return
    const key = stateKey(memoryDir, sessionId)
    let entry = entries.get(key)
    if (entry === undefined) {
      entry = createEntryFor(memoryDir, sessionId, agent)
      entries.set(key, entry)
    } else if (entry.agent !== agent) {
      entry = takeOver(entry, agent, memoryDir)
    }
    const state = entry.state
    state.lastUsedAt = now()
    if (state.phase === 'disposed') return
    // No new reviewable event: nothing to gate and nothing to fork.
    if (head <= state.reviewedThrough) {
      if (state.pendingHead !== undefined && state.pendingHead <= state.reviewedThrough) delete state.pendingHead
      return
    }
    // A later stop only ever raises the pending head; it never rewrites the
    // window a running generation captured.
    state.pendingHead = state.pendingHead === undefined ? head : Math.max(state.pendingHead, head)
    if (state.phase === 'gating' || state.phase === 'waiting-lease' || state.phase === 'extracting') return
    if (state.phase === 'cooldown' && now() < state.retryAt) return
    beginGeneration(entry, undefined)
  }

  return {
    onTurnStopping,
    async quiesce(grace?: number): Promise<void> {
      blocked = true
      const cancelled = teardown(DISPOSE_REASON)
      try {
        // Wait (bounded by the same grace as a takeover) for the aborted jobs to
        // settle, then hand the lease slots back before the legacy branch runs.
        await Promise.all(cancelled.map(({ settled }) => boundedWait(settled, grace ?? graceMs)))
      } finally {
        for (const { entry } of cancelled) releaseLeaseOf(entry)
        blocked = false
      }
      log('memory:extraction-quiesced')
    },
    dispose(): void {
      disposed = true
      const cancelled = teardown(DISPOSE_REASON)
      // Disposal releases the lease immediately: the host is going away, so no
      // further writer can be blocked behind a fork that never settles.
      for (const { entry, settled } of cancelled) {
        releaseLeaseOf(entry)
        void settled
      }
      log('memory:extraction-disposed')
    },
    stateOf(memoryDir: string, sessionId: string): ExtractionState | undefined {
      return entries.get(stateKey(memoryDir, sessionId))?.state
    },
  }
}
