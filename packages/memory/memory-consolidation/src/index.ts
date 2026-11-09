/**
 * Background memory consolidation: turn-end extraction and the three-gate
 * dream rewrite.
 *
 * `agent/turn-stopping` fires an extraction subagent (via `ctx.subagents`, tools restricted to read/search) that reports durable facts
 * as structured output, and evaluates the dream gates (time, session count,
 * lock) to schedule a read-only review whose structured output rewrites
 * MEMORY.md and the topic files. The forks hold no write tools — the memory
 * directory sits outside the session workspace, so the fs sandbox would fence
 * every model-side write with no escalation path from a background job; the
 * plugin validates each reported batch and writes it host-side under a
 * per-call policy confined to the memory directory (see `writeback.ts`). A
 * failed dream rolls back the lock so the time gate re-opens.
 *
 * @module @dsh-cc/memory-consolidation
 */

import { join } from 'node:path'
import * as zlib from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { agentCwd, isTopLevel } from './agent-scope.ts'
import { defaultDshHome } from '@deepseek-ai/dsh-home-paths'
import type { BoundDecisionRunner } from '@dsh-cc/systemone'
import type { SystemOneDecisionsService } from '@dsh-cc/decision-usage'
import { buildConsolidationPrompt, buildExtractionPrompt } from './prompts.ts'
import { timeGatePasses, sessionGatePasses } from './gates.ts'
import { gateWindow, scanSessions, type SessionScanResult } from './session-scan.ts'
import { readLastConsolidatedAt, releaseLock, rollbackLock, tryAcquireLock, LOCK_STALE_MS } from './lock.ts'
import { startMemoryJob } from './memory-job.ts'
import { recordDreamDiagnostic } from './diagnostics.ts'
export { applyEntrypointFallback } from './memory-job.ts'
import { createExtractionCoordinator, TAKEOVER_GRACE_MS } from './extraction-coordinator.ts'
import { registerExtractionSettings, type ExtractionMode } from './extraction-settings.ts'
import { readExistingIndex, readExtractionIndex } from './extraction-index.ts'
import { surfaceCountOf } from './extraction-evidence.ts'
import { createMemoryMutationLease, type MemoryMutationLease } from './mutation-lease.ts'
import {
  memoryWritePolicy,
  readIndexStrict,
  resolveWorkspaceMemoryDir,
  readPressure,
  markPressureForced,
  clearPressure,
} from '@dsh-cc/memory'

export { LOCK_FILE, LOCK_STALE_MS, readLastConsolidatedAt, releaseLock, rollbackLock, tryAcquireLock } from './lock.ts'
export { gatesPass, timeGatePasses, sessionGatePasses } from './gates.ts'
export type { ConsolidationGateInput } from './gates.ts'
export { MEMORY_AGENT_TOOLS, MEMORY_TOOL_FILTER } from './tools.ts'
export { DREAM_DIAGNOSTIC_FILE, recordDreamDiagnostic } from './diagnostics.ts'
export type { DreamDiagnosticEntry, DreamDiagnosticPhase } from './diagnostics.ts'
export { buildConsolidationPrompt, buildExtractionPrompt, buildWindowedExtractionPrompt } from './prompts.ts'
// The write-back lives in @dsh-cc/memory (the memory directory owner);
// re-exported here for consumers of the pre-move surface.
export {
  MEMORY_WRITES_SCHEMA,
  WRITEBACK_MAX_FILE_BYTES,
  WRITEBACK_MAX_FILES,
  WRITEBACK_MAX_TOTAL_BYTES,
  memoryWritePolicy,
  validateMemoryWrites,
  writeMemoryFiles,
} from '@dsh-cc/memory'
export type { MemoryWrite, MemoryWritePolicy } from '@dsh-cc/memory'

export const name = 'memory-consolidation'
/** Services required for the subagent provider (jobs seam intentionally unused). */
export const inject = ['subagents']

/** Memory consolidation configuration. */
export interface Config {
  /** Memory directory root. Defaults to the harness home `memory/`. */
  memoryHome?: string
  /** Turn-end extraction runs (default true). */
  extractEnabled?: boolean
  /** The three-gate dream runs (default true). */
  dreamEnabled?: boolean
  /** Minimum hours between consolidations (default 24). */
  minHours?: number
  /** Minimum new transcripts to consolidate (default 5). */
  minSessions?: number
  /** A lock holder is stale past this window (default 1 hour). */
  lockStaleMs?: number
  /** Minimum minutes between forced (pressure) dreams (default 60). */
  pressureCooldownMinutes?: number
  /** One-shot subagent provider for forks (default `fork`). */
  subagentProviderName?: string
  /** Session store root the gates scan (default `<DSH_HOME>/sessions`). */
  sessionsRoot?: string
}

export const Config: z<Config> = z.object({
  memoryHome: z.string(),
  extractEnabled: z.boolean().default(true),
  dreamEnabled: z.boolean().default(true),
  minHours: z.number().default(24),
  minSessions: z.number().default(5),
  lockStaleMs: z.number().default(LOCK_STALE_MS),
  pressureCooldownMinutes: z.number().default(60),
  subagentProviderName: z.string().default('fork'),
  sessionsRoot: z.string(),
})



/**
 * Register the consolidation plugin.
 * @param ctx - the host context with jobs, subagents, fs, and sessions.
 * @param config - consolidation behavior knobs.
 */
export function apply(ctx: Context, config: Config = {}): void {
  // The memory home is the ROOT: extraction/dream write into the turning
  // agent's repository directory (`<home>/projects/<slug>` of the canonical
  // git root), never the shared root, so memories stay isolated per repo.
  const home = config.memoryHome ?? join(defaultDshHome(), 'memory')
  const provider = config.subagentProviderName ?? 'fork'
  const minHours = config.minHours ?? 24
  const minSessions = config.minSessions ?? 5
  const pressureCooldownMinutes = config.pressureCooldownMinutes ?? 60
  const sessionsRoot = config.sessionsRoot ?? join(defaultDshHome(), 'sessions')

  // Per-session extraction single-flight. Keyed by session id so each top-level
  // agent's in-flight flag and last-spawned event count are isolated.
  const flight = new Map<string, { extracting: boolean; lastEvents: number }>()
  // One dream in flight across the whole plugin instance (per memory dir).
  let dreamInFlight = false

  // Scan memo (plan §3.4): caches the RAW unfiltered SessionScanResult for
  // SCAN_MEMO_MS; the lastAt filter/count/hints are recomputed per call. It
  // bounds the failure-path scan storm (lock rolled back → time gate keeps
  // passing → every turn-end would otherwise rescan the store).
  let memo: { at: number; result: SessionScanResult } | null = null
  // Once-per-process warn state (plan §3.5).
  let warnedRoot = false
  let warnedZstd = false
  const scan = async (): Promise<SessionScanResult> => {
    const now = Date.now()
    if (memo !== null && now - memo.at < SCAN_MEMO_MS) {
      ctx.logger.debug({ event: 'memory:scan-memo-hit' })
      return memo.result
    }
    if (typeof zlib.createZstdDecompress !== 'function' && !warnedZstd) {
      warnedZstd = true
      ctx.logger.warn('memory-consolidation: node:zlib zstd capability missing; dream gates fail closed')
    }
    const t0 = Date.now()
    const result = await scanSessions(sessionsRoot)
    ctx.logger.debug({ event: 'memory:scan', scanned: result.scanned, unreadable: result.unreadable, count: result.sessions.length, ms: Date.now() - t0 })
    if (result.scanned === 0 && !warnedRoot) {
      warnedRoot = true
      ctx.logger.warn(`memory-consolidation: sessions root unreadable or empty at ${sessionsRoot}`)
    }
    memo = { at: Date.now(), result }
    return result
  }

  // S1-04 (design §"Modes and behavioural boundary"): the extraction decision
  // gate lives behind the dynamic `cc-systemone-memory-extraction` snapshot.
  // `off` — the shipped default — is the legacy listener's path and never reads
  // a runner, creates watermark state or issues a decision request.
  const readExtractionSettings = registerExtractionSettings(ctx)
  // One lease table per plugin instance (design §"The repo write lease and its
  // relation to dream"): extraction and dream of THIS tree serialise on it, and
  // another tree in the same process keeps its own slots.
  const lease = createMemoryMutationLease()
  const coordinator = createExtractionCoordinator({
    readSettings: readExtractionSettings,
    lease,
    memoryDirOf: (agent) => resolveWorkspaceMemoryDir(home, agentCwd(agent)),
    readIndex: (dir) => readExtractionIndex(ctx, dir),
    startJob: (request) => startMemoryJob(
      ctx, request.agent, request.memoryDir, provider, 'extract-memories', request.prompt, request.baselineIndex,
    ),
    resolveRunner: (agent): BoundDecisionRunner | undefined => {
      // Root-realm bridge only (design §"Preset wiring"): the isolated
      // `ctx.systemoneDecisions` property throws when the cc-services
      // provision is not visible from this realm, so a service is obtained
      // per gate through the guarded `get` and never cached.
      const decisions = ctx.get('ccSystemoneDecisions') as SystemOneDecisionsService | undefined
      if (decisions === undefined) return undefined
      try {
        return decisions.forAgent(agent)
      } catch {
        return undefined
      }
    },
    log: (event, fields) => { ctx.logger.debug({ event, ...fields }) },
  })

  // Reset the flight state when this plugin fiber is disposed (hygiene / test
  // isolation). cordis `ctx.on` is typed strictly to `keyof Events`, so cleanup
  // is registered as a fiber effect rather than a 'dispose' listener.
  ctx.effect(() => () => {
    flight.clear()
    dreamInFlight = false
    coordinator.dispose()
  }, 'memory-consolidation: reset flight state')

  /**
   * Dispatch-era token (design §"Degradation and lifecycle truth table"): the
   * legacy lane and the coordinator lane must never dispatch for the same stop,
   * so the lane owner is captured as an era and every deferred dispatch checks
   * it is still the current one.
   */
  let era = 0
  let eraMode: ExtractionMode | undefined
  /** Non-undefined while the coordinator drains for an active/shadow → off flip. */
  let handoff: Promise<void> | undefined
  /** Whether the coordinator dispatched in this non-off era (a flip must drain it). */
  let coordinatorUsed = false

  /** The exact legacy extraction dispatch (mode `off`): single-flight + content gate. */
  const legacyExtraction = (agent: Agent): void => {
    const sessionId = agent.session.header.id
    const entry = flight.get(sessionId)
    // Single-flight: skip while an extraction is in flight or when no new
    // events have arrived since the last spawn.
    if (!entry?.extracting && agent.session.seq !== entry?.lastEvents) {
      flight.set(sessionId, { extracting: true, lastEvents: agent.session.seq })
      void runExtraction(ctx, agent, home, provider).finally(() => {
        const cur = flight.get(sessionId)
        if (cur) cur.extracting = false
      })
    }
  }

  // ONE handler, per the amended single-listener rule: it reads the live mode
  // snapshot on every entry and branches. The dream lane is mode-independent —
  // its timing, session, pressure, lock and retry conditions are untouched.
  ctx.on('agent/turn-stopping', ({ agent, signal }) => {
    // All predicates are synchronous and run before any await, so the flags
    // below are set before a second, interleaved turn-stopping could observe
    // them.
    if (signal.aborted) return
    if (!isTopLevel(agent)) return
    const mode = readExtractionSettings().mode
    if (mode !== eraMode) {
      eraMode = mode
      era += 1
    }
    const dispatchEra = era
    if (mode === 'off' && coordinatorUsed && handoff === undefined) {
      // Block new coordinator work, cancel the running gate/job and wait
      // (bounded by the same grace as a takeover) for the lease to come back
      // before the legacy branch may dispatch.
      coordinatorUsed = false
      const barrier = coordinator.quiesce(TAKEOVER_GRACE_MS).catch(() => {})
      handoff = barrier
      void barrier.then(() => { if (handoff === barrier) handoff = undefined })
    }
    if (config.extractEnabled ?? true) {
      if (mode !== 'off') {
        coordinatorUsed = true
        coordinator.onTurnStopping({ agent, signal })
      } else if (handoff === undefined) {
        legacyExtraction(agent)
      } else {
        // A post-switch legacy dispatch waits for the coordinator drain and
        // still checks its era: a flip back to shadow/active owns the stop.
        const draining = handoff
        void draining.then(() => {
          if (era === dispatchEra && !signal.aborted) legacyExtraction(agent)
        })
      }
    }
    if (config.dreamEnabled ?? true) {
      if (!dreamInFlight) {
        dreamInFlight = true
        void runDream(ctx, agent, home, provider, lease, minHours, minSessions, pressureCooldownMinutes, sessionsRoot, scan)
          .catch((err) => { ctx.logger.warn(`memory-consolidation: dream dispatch failed: ${String(err)}`) })
          .finally(() => { dreamInFlight = false })
      }
    }
  })
}

/** Memo TTL for the raw session-scan result (plan §3.4). */
const SCAN_MEMO_MS = 30 * 60_000

async function runExtraction(ctx: Context, agent: Agent, home: string, provider: string): Promise<void> {
  // The extraction writes into the turning agent's repository directory —
  // the shared home root holds only explicitly-global memories.
  const dir = resolveWorkspaceMemoryDir(home, agentCwd(agent))
  // Only model-visible surface events count toward the batch size.
  const surfaceCount = surfaceCountOf(agent.session.snapshotEvents())
  // The index read happens AFTER the in-flight/content gates (runExtraction is
  // only reached once a spawn is committed), so a skipped spawn never pays the
  // fs cost. Any failure here degrades to an empty index and still spawns.
  const existingIndex = await readExistingIndex(ctx, dir)
  const prompt = buildExtractionPrompt(surfaceCount, dir, existingIndex)
  // Fire-and-forget: extraction failure must never fail the turn itself. The
  // job status still reflects the real outcome (the fork's structured report
  // is validated and written host-side before `done` completes). The exact
  // prompt-injected string is the job baseline (design §3.2): a pointer beyond
  // the injection cap was never visible to the model, so the write-back must
  // treat it as a concurrent addition rather than a model deletion.
  return startMemoryJob(ctx, agent, dir, provider, 'extract-memories', prompt, existingIndex)
    .catch(() => {})
    .then(() => {})
}

async function runDream(
  ctx: Context,
  agent: Agent,
  home: string,
  provider: string,
  lease: MemoryMutationLease,
  minHours: number,
  minSessions: number,
  pressureCooldownMinutes: number,
  sessionsRoot: string,
  scan: () => Promise<SessionScanResult>,
): Promise<void> {
  const fs = ctx.get('fs')
  if (fs === undefined) return
  const dir = resolveWorkspaceMemoryDir(home, agentCwd(agent))
  const now = Date.now()
  const policy = memoryWritePolicy(dir)
  const pressure = await readPressure(fs, dir)
  const lastAt = await readLastConsolidatedAt(fs, dir)
  let hints: readonly string[]
  if (pressure.armedAt > 0) {
    // Pressure mode: an armed marker bypasses the time/session gates. The
    // cooldown is measured from `lastForcedAt` (not `armedAt`) so a tight arm
    // loop of rejecting saves cannot spin dreams faster than the knob;
    // backwards clock skew (negative delta) counts as within-cooldown.
    if (now - pressure.lastForcedAt < pressureCooldownMinutes * 60_000) {
      ctx.logger.debug({ event: 'memory:dream-gates', mode: 'pressure', lastAt, count: 0, minSessions, pass: false, reason: 'cooldown' })
      return
    }
    // Stamp BEFORE acquiring the lock: consumes the cooldown slot even if the
    // lock is held or the spawn never happens, making the crash-window spawn
    // storm structurally impossible. Failure keeps the marker with this stamp
    // so the next window retries.
    await markPressureForced(fs, dir, pressure.armedAt, now, policy)
    // Scan AFTER the stamp (plan §3.2/§3.3): a zero scan skips the spawn with
    // the marker still armed — the lock was never acquired, so there is
    // nothing to roll back and the next cooldown window retries.
    const scanResult = await scan()
    const window = gateWindow(scanResult.sessions, lastAt)
    ctx.logger.debug({ event: 'memory:dream-gates', mode: 'pressure', lastAt, count: window.count, minSessions, pass: true })
    if (scanResult.scanned === 0) return
    hints = window.hints
  } else {
    // Periodic: the pure-arithmetic time gate runs FIRST, before any scan I/O;
    // the session-count gate runs only on the scanned result.
    if (!timeGatePasses(lastAt, now, minHours)) {
      ctx.logger.debug({ event: 'memory:dream-gates', mode: 'periodic', lastAt, count: 0, minSessions, pass: false, reason: 'time' })
      return
    }
    const scanResult = await scan()
    const window = gateWindow(scanResult.sessions, lastAt)
    const pass = sessionGatePasses(window.count, minSessions)
    ctx.logger.debug({ event: 'memory:dream-gates', mode: 'periodic', lastAt, count: window.count, minSessions, pass })
    if (!pass) return
    hints = window.hints
  }
  // S1-04 §"The repo write lease and its relation to dream": the LOCAL lease is
  // tried FIRST. A conflict returns without taking the original disk lock, so a
  // dream never queues behind the disk lock and misleads other processes while
  // the shared slot is busy. In `off` mode extraction never holds this lease, so
  // the tryAcquire is then uncontended and dream behaves exactly as before.
  const releaseLease = lease.tryAcquire(dir)
  if (releaseLease === undefined) {
    ctx.logger.debug({ event: 'memory:dream-lease', conflict: 1 })
    return
  }
  let priorAt: number | null
  try {
    priorAt = await tryAcquireLock(fs, dir, process.pid, now, policy)
  } catch (err) {
    // The lease must never outlive a failed lock attempt.
    releaseLease()
    throw err
  }
  if (priorAt === null) {
    // Disk-lock failure releases the local lease immediately.
    releaseLease()
    ctx.logger.warn(`memory-consolidation: consolidation lock held by a live holder in ${dir}`)
    return
  }
  // Diagnostics + lock hygiene from here on: everything after the acquire can
  // strand the lock (a startMemoryJob throw, an earlier silent death), so the
  // whole spawn is wrapped and every failure leaves a durable breadcrumb
  // before the rollback (plan §2.2, review Major-1/Major-2).
  const sessionId = agent.session.header.id
  try {
    await recordDreamDiagnostic(ctx, fs, dir, policy, { sessionId, phase: 'dispatch-started', detail: '' })
    const prompt = buildConsolidationPrompt(dir, sessionsRoot, hints)
    // Baseline capture (§3.2): the raw strict read immediately before dispatch,
    // post-lock-acquire. The dream fork reads the directory itself, so this is
    // the snapshot it was dispatched against; the bounded RETRY below reuses the
    // SAME baseline — a fresh capture would misclassify first-run concurrent
    // additions (visible to the fork) as model-seen deletions.
    const baselineIndex = await readIndexStrict(fs, dir)
    const job = await startMemoryJob(ctx, agent, dir, provider, 'memory-consolidation', prompt, baselineIndex)
    void job.done.then(async (outcome) => {
      // The local lease is held across the first round AND the original bounded
      // retry: it is released at every terminal outcome of this dream.
      try {
        ctx.logger.debug({ event: 'memory:dream-outcome', status: outcome.status, detail: outcome.status === 'failed' ? outcome.detail : undefined })
        if (outcome.status === 'completed') {
          // Success releases the lock BEFORE clearing the marker (issue #336),
          // and AWAITs it: void fire-and-forget chains interleave, so only an
          // awaited release guarantees the marker clear never lands first. A
          // crash between the two writes then leaves an armed marker with a
          // free lock — the next cooldown window retries, which is
          // conservative. The reverse order would leave the marker tombstoned
          // with the lock still stamped: the exact stale-window delay this fix
          // removes. The release is guarded (skipped when a reclaimer took the
          // file mid-dream) and best-effort (failures are swallowed inside).
          await releaseLock(fs, dir, process.pid, now, policy)
          // Success tombs the marker in BOTH modes — but only the arms this
          // dream's rebuild addressed (issue #335 Face B): the clear is
          // conditional on `pressure.armedAt` (captured at the dream's initial
          // read, which the fork's index snapshot postdates), so an arm that
          // landed during the dream survives for the next window. The cooldown
          // reference advances to completion time, not dream start.
          void clearPressure(fs, dir, Date.now(), policy, pressure.armedAt)
          return
        }
        await recordDreamDiagnostic(ctx, fs, dir, policy, {
          sessionId,
          phase: 'outcome-failed',
          detail: outcome.status === 'failed' ? outcome.detail : outcome.status,
        })
        // One bounded retry (design 2026-09-24 §4.2): only a FAILED outcome
        // respawns — `killed` is an intentional abort (session teardown /
        // controller.abort) and must never respawn. The retry reuses the held
        // lock (no re-acquire) and does not restamp the pressure marker. The
        // whole retry block gets its OWN try/catch mirroring the dispatch-throw
        // branch: a throw inside the retry must never strand the lock.
        if (outcome.status !== 'failed') {
          void rollbackLock(fs, dir, process.pid, now, priorAt, policy)
          return
        }
        try {
          const retry = await startMemoryJob(ctx, agent, dir, provider, 'memory-consolidation', prompt, baselineIndex)
          // Awaiting the retry inside this handler keeps the whole first-plus-retry
          // span inside ONE try/finally, so the local lease cannot leak between the
          // attempts. The dispatch itself is unchanged (one bounded respawn).
          const retryOutcome = await retry.done
          ctx.logger.debug({ event: 'memory:dream-outcome', retry: true, status: retryOutcome.status, detail: retryOutcome.status === 'failed' ? retryOutcome.detail : undefined })
          if (retryOutcome.status === 'completed') {
            // Same guarded, awaited release as the first attempt: the retry
            // reuses the ORIGINAL lock, so the same pid+epoch pair is still
            // ours to free.
            await releaseLock(fs, dir, process.pid, now, policy)
            // Same conditional clear as the first attempt: the retry reuses
            // the ORIGINAL captured arm (the retry's fork re-reads the
            // directory, so an arm older than a fresh capture is at worst
            // conservatively kept — an extra dream later, never a lost one).
            void clearPressure(fs, dir, Date.now(), policy, pressure.armedAt)
            return
          }
          await recordDreamDiagnostic(ctx, fs, dir, policy, {
            sessionId,
            phase: 'outcome-failed',
            detail: `retry ${retryOutcome.status === 'failed' ? retryOutcome.detail : retryOutcome.status}`,
          })
          void rollbackLock(fs, dir, process.pid, now, priorAt, policy)
        } catch (err) {
          const detail = err instanceof Error && err.stack ? `${String(err)}\n${err.stack}` : String(err)
          await recordDreamDiagnostic(ctx, fs, dir, policy, { sessionId, phase: 'outcome-failed', detail: `retry ${detail}` })
          await rollbackLock(fs, dir, process.pid, now, priorAt, policy)
          ctx.logger.warn(`memory-consolidation: dream retry failed: ${detail}`)
        }
      } finally {
        releaseLease()
      }
    })
  } catch (err) {
    // The dispatch-throw branch: the same guarded rollback with the acquire
    // identity (process.pid + the acquisition epoch `now`).
    const detail = err instanceof Error && err.stack ? `${String(err)}\n${err.stack}` : String(err)
    await recordDreamDiagnostic(ctx, fs, dir, policy, { sessionId, phase: 'dispatch-throw', detail })
    await rollbackLock(fs, dir, process.pid, now, priorAt, policy)
    ctx.logger.warn(`memory-consolidation: dream dispatch failed: ${detail}`)
    releaseLease()
  }
}

