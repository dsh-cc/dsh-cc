/**
 * The `cc-workflow-journal` replay-gate subagent provider (resume-journal
 * design §3.1/§3.4, rc.5 rework): claims the registry's pending workflow-run
 * deposit on the first child start of a run, journals every settled child at
 * its arrival index, and on a resume (`claim.resumeOf` set) replays hits as
 * fabricated runs until the first miss, which freezes the run to live
 * execution for every subsequent child. A hit is keyed by the REQUEST HASH
 * against the journal's replayable prefix, not by arrival position (design
 * §3.4, rev. 2026-10-22).
 *
 * Run binding: dsh-cc's `CcWorkflowRunRegistry` admits exactly one in-flight
 * workflow run per session, so the claimed run is unambiguous — the first
 * child start after a deposit belongs to that run. (The pre-rc.5
 * signal-identity keying is dead: the rc.5 manager wraps the activation
 * signal per child start, so no signal is shared across a run's children.)
 * A claimed run stays bound until the NEXT claim or plugin disposal, which
 * keeps the registry's settle-time `drain()` path intact.
 *
 * The live path is NOT a provider-to-provider delegation (the spawn provider
 * has no `start` at rc.5): it goes through the seam's own
 * `startActivation({ provider: 'spawn', delivery: 'caller' })`, and the
 * returned activation's result/dispose back the `SubagentRun` the manager
 * wraps. A replay hit fabricates the `SubagentRun` locally — no model call.
 * This provider has no `prepareContinuable`, so the manager routes it as
 * external BY DESIGN: `start` is the only point on the ptc-host dispatch
 * (`startActivation({ provider: 'cc-workflow-journal' })`) where a replay hit
 * can be admitted without a model call.
 *
 * @module @dsh-cc/workflow-journal/provider
 */

import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ResolvedSubagentStartRequest,
  SubagentActivation,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { parseJournal } from '@dsh-cc/tool-workflow'
import type { JournalLine, PendingWorkflowClaim, WorkflowJournalHandle } from '@dsh-cc/tool-workflow'
import type { WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import { JournalWriter, hashSubagentRequest } from './journal-io.ts'

/** The registry surface the provider consumes (satisfied by CcWorkflowRunRegistry). */
export interface WorkflowJournalRegistry {
  takePendingClaim(): PendingWorkflowClaim | undefined
  bindJournal(runId: WorkflowRunId, handle: WorkflowJournalHandle): () => void
  markCached(runId: WorkflowRunId, arrivalIndex: number): void
}

/** The subagents-service surface the provider consumes (rc.5). */
export interface SubagentServiceLike {
  getProvider(name: string): SubagentProvider | undefined
  startActivation(spec: {
    provider: string
    label: string
    request: Omit<ResolvedSubagentStartRequest, 'label' | 'signal'>
    signal: AbortSignal
    delivery: 'parent' | 'caller'
  }): Promise<SubagentActivation>
}

/** Per-run journal state for the single in-flight run (registry constraint). */
export interface JournalRun {
  readonly runId: WorkflowRunId
  readonly writer: JournalWriter
  readonly unbind: () => void
  /** Provider arrival counter (1-based; == worker seq per the strong form). */
  arrivalIndex: number
  /**
   * Replay pool: hash → the not-yet-consumed replayable lines with that
   * hash, in journal (seq) order. Only the journal's replayable prefix is
   * pooled (contiguous seq 1..k of completed lines with a well-formed
   * projection): a line journaled after a failed/missing/malformed one
   * never replays (CC: "runs again, and so does every agent that started
   * after it"). Undefined for live runs (nothing to replay).
   */
  replayPool: Map<string, Array<{ line: JournalLine; projection: SubagentResult }>> | undefined
  /** Permanent first-miss/corruption latch: every later child spawns live. */
  frozen: boolean
}

/** Validate a stored `completed` projection: object with an output array. */
function projectionFromLine(line: JournalLine): SubagentResult | undefined {
  const result = line.result
  if (typeof result !== 'object' || result === null || !Array.isArray((result as { output?: unknown }).output)) {
    return undefined
  }
  const { output, structured } = result as { output: SubagentResult['output']; structured?: unknown }
  return {
    output,
    ...(structured !== undefined ? { structured } : {}),
    stopReason: 'completed',
  }
}

/**
 * Pool the journal's replayable prefix by request hash: lines seq 1..k in
 * order, stopping at the first line that is not a completed, well-formed
 * projection at its expected seq (a gap, a failure, or a malformed result).
 */
function buildReplayPool(lines: readonly JournalLine[]): NonNullable<JournalRun['replayPool']> {
  const pool = new Map<string, Array<{ line: JournalLine; projection: SubagentResult }>>()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.seq !== i + 1 || line.status !== 'completed') break
    const projection = projectionFromLine(line)
    if (projection === undefined) break
    const bucket = pool.get(line.hash)
    if (bucket === undefined) pool.set(line.hash, [{ line, projection }])
    else bucket.push({ line, projection })
  }
  return pool
}

/**
 * Replay admission for one child request against the run's pool (design
 * §3.4), keyed by request hash. While unfrozen, the first unconsumed pooled
 * line with the exact hash is a hit; no such line (edited prompt/options/
 * schema, a request past the replayable prefix, or more duplicates than were
 * journaled) is the first miss and freezes the run permanently. Returns the
 * consumed line and its projection on a hit, `undefined` (run frozen) on a
 * miss or when the run has nothing to replay.
 */
export function admitJournalReplay(
  run: JournalRun,
  hash: string,
): { line: JournalLine; projection: SubagentResult } | undefined {
  if (run.replayPool === undefined || run.frozen) return undefined
  const candidates = run.replayPool.get(hash)
  const hit = candidates?.shift()
  if (hit === undefined) {
    // First miss: this and every later arrival spawns live (CC's "and so
    // does every agent after it").
    run.frozen = true
    return undefined
  }
  return hit
}

/**
 * Append one settled child's journal line at its arrival index. Writer
 * failures are contained inside {@link JournalWriter} (warn-and-drop); this
 * function never throws into a dispatch path.
 */
export function recordJournalOutcome(
  run: JournalRun,
  arrivalIndex: number,
  hash: string,
  settled: { stopReason: string; output: SubagentResult['output']; structured?: unknown },
): void {
  run.writer.record(arrivalIndex, {
    seq: arrivalIndex,
    hash,
    status: settled.stopReason,
    result: {
      output: settled.output,
      ...(settled.structured !== undefined ? { structured: settled.structured } : {}),
      stopReason: settled.stopReason,
    },
  })
}

/** Provider construction options. */
export interface CcWorkflowJournalProviderOptions {
  /** Journal file byte cap; a journal at the cap stops recording further lines. */
  maxJournalBytes: number
  /** Warn sink (injected; the cordis plugin passes ctx.logger.warn). */
  warn: (message: string) => void
}

export class CcWorkflowJournalProvider implements SubagentProvider {
  readonly name = 'cc-workflow-journal'

  private delegateProvider: SubagentProvider | undefined
  /**
   * The single claimed run (one in-flight workflow run per session — the
   * registry constraint). Set at the first child start after a deposit;
   * replaced (after close/unbind) by the next claim or drained at disposal.
   */
  private current: JournalRun | undefined
  /** Session journal directories of every claimed run (disposal cleanup). */
  private readonly sessionDirs = new Set<string>()

  constructor(
    private readonly subagents: SubagentServiceLike,
    private readonly registry: WorkflowJournalRegistry,
    private readonly options: CcWorkflowJournalProviderOptions,
  ) {}

  /**
   * The spawn provider, resolved on first READ and cached (design A5): the
   * service consults capabilities before it ever calls start, so the lookup
   * cannot be deferred to start time.
   */
  private delegate(): SubagentProvider {
    if (this.delegateProvider === undefined) {
      const provider = this.subagents.getProvider('spawn')
      if (provider === undefined) {
        throw new Error('cc-workflow-journal: delegate provider "spawn" is not registered yet')
      }
      this.delegateProvider = provider
    }
    return this.delegateProvider
  }

  get capabilities(): SubagentCapabilities {
    return this.delegate().capabilities
  }

  get inheritsParentContext(): boolean {
    return this.delegate().inheritsParentContext
  }

  get agentRouteDefaults(): Readonly<{ provider: string; model: string }> {
    // The interface property is optional (the GETTER is the mirror); a
    // delegate without a route yields undefined through the cast, matching
    // the optional-property semantics at the call site.
    return this.delegate().agentRouteDefaults as Readonly<{ provider: string; model: string }>
  }

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const run = this.ensureRun()
    const idx = ++run.arrivalIndex
    const hash = hashSubagentRequest(request)

    const hit = admitJournalReplay(run, hash)
    if (hit !== undefined) {
      this.registry.markCached(run.runId, idx)
      try {
        // Copy-forward at THIS run's arrival index, so the new journal is
        // seq-complete in its own arrival order.
        run.writer.record(idx, { ...hit.line, seq: idx })
      } catch {
        // Copy-forward failure fails open to a live spawn (design §3.3).
        run.frozen = true
        this.options.warn(`cc-workflow-journal: copy-forward for run "${run.runId}" seq ${idx} failed; falling open to a live spawn`)
      }
      if (!run.frozen) {
        // Replay hit: no model call — the fabricated run settles immediately.
        return {
          id: randomUUID() as unknown as SessionId,
          result: Promise.resolve(hit.projection),
          dispose: () => Promise.resolve(),
        }
      }
    }

    // Live path (miss or fresh run): start the child through the seam's own
    // activation and journal its settled outcome. The manager keys activations
    // by run id, and the inner activation already owns the child's real
    // session id — the outer run MUST mint a distinct id or the manager's
    // duplicate-child check rejects the pair. The activation's result/dispose
    // back the manager's external-run teardown (cancel/discipline included) —
    // post-publication cancellation belongs to dispose per the rc.5
    // activation-signal contract.
    const { label, signal, ...rest } = request
    const activation = await this.subagents.startActivation({
      provider: 'spawn',
      label: label ?? `workflow child ${idx}`,
      request: rest,
      signal,
      delivery: 'caller',
    })
    void activation.result.then(
      settled => recordJournalOutcome(run, idx, hash, settled),
      () => {
        /* rejected result = not settled; no journal line */
      },
    )
    return {
      id: randomUUID() as unknown as SessionId,
      result: activation.result,
      dispose: () => activation.dispose(),
    }
  }

  /**
   * Pick up the run state for one child start: a pending deposit belongs to
   * a NEW run (one in-flight run per session, so a deposit cannot be a
   * stale sibling); without one, the claimed run continues. Synchronous, so
   * the first concurrent child claims/keeps unambiguously.
   */
  private ensureRun(): JournalRun {
    const claim = this.registry.takePendingClaim()
    if (claim === undefined) {
      if (this.current === undefined) {
        throw new Error('cc-workflow-journal: start with no pending workflow-run claim')
      }
      return this.current
    }
    return this.claimRun(claim)
  }

  /** Adopt a pending deposit as the new claimed run (retiring the previous one — its settle drain already happened). */
  private claimRun(claim: PendingWorkflowClaim): JournalRun {
    if (this.current !== undefined) this.retire(this.current)
    mkdirSync(dirname(claim.journalPath), { recursive: true })
    this.sessionDirs.add(dirname(claim.journalPath))
    const writer = new JournalWriter(claim.journalPath, {
      maxBytes: this.options.maxJournalBytes,
      warn: this.options.warn,
    })
    // Resume parse (design §3.2: the provider parses, never reads, the
    // deposited text). Live runs (no resumeOf) have nothing to replay —
    // replayPool stays undefined and the frozen latch is never consulted.
    let replayPool: JournalRun['replayPool']
    let frozen = false
    if (claim.resumeOf !== undefined) {
      if (claim.journalText === undefined) {
        frozen = true
        this.options.warn(`cc-workflow-journal: resume claim for run "${claim.runId}" carries no journal text; replaying live (fail-open)`)
      } else {
        const parsed = parseJournal(claim.journalText)
        if (parsed.corrupt) {
          frozen = true
          this.options.warn(`cc-workflow-journal: journal for run "${claim.resumeOf}" is corrupt; replaying live (fail-open)`)
        } else {
          replayPool = buildReplayPool(parsed.lines)
        }
      }
    }
    const unbind = this.registry.bindJournal(claim.runId, {
      drain: () => writer.drain(),
      markCached: index => this.registry.markCached(claim.runId, index),
    })
    const run: JournalRun = { runId: claim.runId, writer, unbind, arrivalIndex: 0, replayPool, frozen }
    this.current = run
    return run
  }

  /** Close one run's writer and drop its registry binding (best-effort). */
  private retire(run: JournalRun): void {
    if (this.current === run) this.current = undefined
    try {
      run.writer.close()
    } catch (error) {
      this.options.warn(`cc-workflow-journal: journal close for run "${run.runId}" failed: ${String(error)}`)
    }
    try {
      run.unbind()
    } catch {
      /* unbind is a Map delete; never fails in practice */
    }
  }

  /**
   * Disposal cleanup (design §3.3): close the open writer (if any), await
   * its drain, then delete each claimed session's journal directory.
   * Best-effort — failures warn and never throw.
   */
  async disposeAllJournals(): Promise<void> {
    const run = this.current
    if (run !== undefined) {
      this.retire(run)
      try {
        await run.writer.drain()
      } catch (error) {
        this.options.warn(`cc-workflow-journal: drain during disposal failed: ${String(error)}`)
      }
    }
    for (const dir of this.sessionDirs) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        this.options.warn(`cc-workflow-journal: could not remove journal directory ${dir}: ${String(error)}`)
      }
    }
    this.sessionDirs.clear()
  }
}
