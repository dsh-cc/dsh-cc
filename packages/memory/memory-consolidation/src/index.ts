/**
 * Background memory consolidation: turn-end extraction and the three-gate
 * dream rewrite.
 *
 * `agent/turn-stopping` fires an extraction subagent (via `ctx.jobs` +
 * `ctx.subagents`, tools restricted to read/search) that reports durable facts
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
import { createZstdDecompress } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { defaultDshHome } from '@deepseek-ai/dsh-home-paths'
import { buildConsolidationPrompt, buildExtractionPrompt } from './prompts.ts'
import { timeGatePasses, sessionGatePasses } from './gates.ts'
import { gateWindow, scanSessions, type SessionScanResult } from './session-scan.ts'
import { readLastConsolidatedAt, rollbackLock, tryAcquireLock, LOCK_STALE_MS } from './lock.ts'
import { startMemoryJob } from './memory-job.ts'
export { applyEntrypointFallback } from './memory-job.ts'
import {
  memoryWritePolicy,
  resolveWorkspaceMemoryDir,
  readPressure,
  markPressureForced,
  clearPressure,
} from '@dsh-cc/memory'

export { LOCK_FILE, LOCK_STALE_MS, readLastConsolidatedAt, rollbackLock, tryAcquireLock } from './lock.ts'
export { gatesPass, timeGatePasses, sessionGatePasses } from './gates.ts'
export type { ConsolidationGateInput } from './gates.ts'
export { MEMORY_AGENT_TOOLS, MEMORY_TOOL_FILTER } from './tools.ts'
export { buildConsolidationPrompt, buildExtractionPrompt } from './prompts.ts'
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
/** Services required for background jobs and the subagent provider. */
export const inject = ['jobs', 'subagents']

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
    if (typeof createZstdDecompress !== 'function' && !warnedZstd) {
      warnedZstd = true
      ctx.logger.warn('memory-consolidation: node:zlib zstd capability missing; dream gates fail closed')
    }
    const t0 = Date.now()
    const result = await scanSessions(sessionsRoot)
    ctx.logger.debug({ event: 'memory:scan', scanned: result.scanned, unreadable: result.unreadable, ms: Date.now() - t0 })
    if (result.scanned === 0 && !warnedRoot) {
      warnedRoot = true
      ctx.logger.warn(`memory-consolidation: sessions root unreadable or empty at ${sessionsRoot}`)
    }
    memo = { at: Date.now(), result }
    return result
  }

  // Reset the flight state when this plugin fiber is disposed (hygiene / test
  // isolation). cordis `ctx.on` is typed strictly to `keyof Events`, so cleanup
  // is registered as a fiber effect rather than a 'dispose' listener.
  ctx.effect(() => () => {
    flight.clear()
    dreamInFlight = false
  }, 'memory-consolidation: reset flight state')

  ctx.on('agent/turn-stopping', ({ agent, signal }) => {
    // All predicates are synchronous and run before any await, so the flags
    // below are set before a second, interleaved turn-stopping could observe
    // them.
    if (signal.aborted) return
    if (!isTopLevel(agent)) return
    const sessionId = agent.session.header.id
    if (config.extractEnabled ?? true) {
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
    if (config.dreamEnabled ?? true) {
      if (!dreamInFlight) {
        dreamInFlight = true
        void runDream(ctx, agent, home, provider, minHours, minSessions, pressureCooldownMinutes, sessionsRoot, scan)
          .catch((err) => { ctx.logger.warn(`memory-consolidation: dream dispatch failed: ${String(err)}`) })
          .finally(() => { dreamInFlight = false })
      }
    }
  })
}

/** Memo TTL for the raw session-scan result (plan §3.4). */
const SCAN_MEMO_MS = 30 * 60_000

/** The agent's workspace cwd: where its memory directory is resolved from. */
function agentCwd(agent: Agent): string {
  return agent.session.header.cwd ?? process.cwd()
}

/**
 * Whether an agent is top-level (not a delegated subagent). This is the root
 * fix for the extraction/dream recursion: a subagent's own turn-end must never
 * spawn another memory fork. Fails CLOSED — any throw from reading the depth
 * treats the agent as a child so nothing is spawned.
 */
function isTopLevel(agent: Agent): boolean {
  try {
    return delegationDepthOf(agent) === 0
  } catch {
    return false
  }
}

/** Surface event types whose count a single extraction batch reviews. */
const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])
/** Upper bound on the injected index: first 200 lines or 8 KiB, whichever first. */
const INDEX_CAP_LINES = 200
const INDEX_CAP_BYTES = 8 * 1024
const INDEX_TRUNCATED_MARKER = '(index truncated; rely on MEMORY.md in-dir for the rest)'

async function runExtraction(ctx: Context, agent: Agent, home: string, provider: string): Promise<void> {
  // The extraction writes into the turning agent's repository directory —
  // the shared home root holds only explicitly-global memories.
  const dir = resolveWorkspaceMemoryDir(home, agentCwd(agent))
  // Only model-visible surface events count toward the batch size.
  const surfaceCount = agent.session.snapshotEvents().filter((e) => SURFACE_EVENT_TYPES.has(e.type)).length
  // The index read happens AFTER the in-flight/content gates (runExtraction is
  // only reached once a spawn is committed), so a skipped spawn never pays the
  // fs cost. Any failure here degrades to an empty index and still spawns.
  const existingIndex = await readExistingIndex(ctx, dir)
  const prompt = buildExtractionPrompt(surfaceCount, dir, existingIndex)
  // Fire-and-forget: extraction failure must never fail the turn itself. The
  // job status still reflects the real outcome (the fork's structured report
  // is validated and written host-side before `done` completes).
  return startMemoryJob(ctx, agent, dir, provider, 'extract-memories', prompt)
    .catch(() => {})
    .then(() => {})
}

/**
 * Read the existing topic index to inject into the extraction prompt: the
 * MEMORY.md body when present, else the names of sibling topic `.md` files.
 * Swallow-all: any error or an absent fs yields an empty index so a spawn is
 * never blocked by the read. Content is capped at 200 lines / 8 KiB so a huge
 * index cannot bloat the prompt.
 */
async function readExistingIndex(ctx: Context, dir: string): Promise<string> {
  const fs = ctx.get('fs')
  if (fs === undefined) return ''
  try {
    const memoryTarget = await fs.resolve(join(dir, 'MEMORY.md'))
    const info = await fs.stat(memoryTarget)
    let raw: string
    if (info !== undefined) {
      raw = await fs.readText(memoryTarget)
    } else {
      // No index file: fall back to listing topic `.md` files in the directory.
      const dirTarget = await fs.resolve(dir)
      const entries = await fs.listDir(dirTarget)
      raw = entries
        .filter((e) => e.type === 'file' && e.name.endsWith('.md') && e.name !== 'MEMORY.md')
        .map((e) => e.name)
        .sort()
        .join('\n')
    }
    if (raw === '') return ''
    // Cap at the first 200 lines OR 8 KiB, whichever comes first; append a
    // marker when truncated so the model knows to rely on the in-dir file.
    const lines = raw.split('\n')
    const kept: string[] = []
    let bytes = 0
    let truncated = false
    for (const line of lines) {
      if (kept.length >= INDEX_CAP_LINES) { truncated = true; break }
      const add = line.length + (kept.length > 0 ? 1 : 0)
      if (bytes + add > INDEX_CAP_BYTES) { truncated = true; break }
      kept.push(line)
      bytes += add
    }
    const capped = kept.join('\n')
    return truncated ? `${capped}\n${INDEX_TRUNCATED_MARKER}` : capped
  } catch {
    return ''
  }
}

async function runDream(
  ctx: Context,
  agent: Agent,
  home: string,
  provider: string,
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
  const priorAt = await tryAcquireLock(fs, dir, process.pid, now, policy)
  if (priorAt === null) {
    ctx.logger.warn(`memory-consolidation: consolidation lock held by a live holder in ${dir}`)
    return
  }
  const prompt = buildConsolidationPrompt(dir, sessionsRoot, hints)
  const job = await startMemoryJob(ctx, agent, dir, provider, 'memory-consolidation', prompt)
  void job.done.then((outcome) => {
    ctx.logger.debug({ event: 'memory:dream-outcome', status: outcome.status, detail: outcome.status === 'failed' ? outcome.detail : undefined })
    if (outcome.status !== 'completed') {
      void rollbackLock(fs, dir, priorAt, policy)
      return
    }
    // Success tombs the marker in BOTH modes: a successful periodic dream
    // rebuilds the index, so a stale pending marker is obsolete by definition.
    void clearPressure(fs, dir, now, policy)
  })
}

