/**
 * The `cc-workflow-journal` wrapping subagent provider (resume-journal
 * design §3.1/§3.4): claims the registry's pending workflow-run deposit on
 * the first child start of a run (keyed by the per-run derived signal),
 * journals every settled child at its arrival index, and on a resume
 * (`claim.resumeOf` set) replays completed prefix hits as fabricated runs
 * until the first miss, which freezes the run to live execution for every
 * subsequent child.
 *
 * The live path is a transparent pass-through: the delegate's `SubagentRun`
 * is returned unchanged; only `run.result` is tapped to journal the
 * settlement. Capabilities and route defaults are mirrored through lazy
 * getters (design A5) because the service reads them BEFORE calling start.
 * @module @dsh-cc/workflow-journal/provider
 */

import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { parseJournal } from '@dsh-cc/tool-workflow'
import type { JournalLine, PendingWorkflowClaim, WorkflowJournalHandle } from '@dsh-cc/tool-workflow'
import { JournalWriter, hashSubagentRequest } from './journal-io.ts'

/** The registry surface the provider consumes (satisfied by CcWorkflowRunRegistry). */
export interface WorkflowJournalRegistry {
  takePendingClaim(): PendingWorkflowClaim | undefined
  bindJournal(runId: WorkflowRunId, handle: WorkflowJournalHandle): () => void
  markCached(runId: WorkflowRunId, arrivalIndex: number): void
}

/** The subagents-service surface the provider consumes. */
export interface SubagentServiceLike {
  getProvider(name: string): SubagentProvider | undefined
}

/** Per-run journal state, keyed by the run's derived signal identity. */
interface JournalRun {
  readonly runId: WorkflowRunId
  readonly writer: JournalWriter
  readonly unbind: () => void
  /** Provider arrival counter (1-based; == worker seq per the strong form). */
  arrivalIndex: number
  /** Replay source lines; undefined for live runs (nothing to replay). */
  replayLines: JournalLine[] | undefined
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
  /** Signal identity → per-run journal state (design §3.2). */
  private readonly runs = new WeakMap<AbortSignal, JournalRun>()
  /** Strong refs for disposeAllJournals (WeakMap is not iterable). */
  private readonly liveRuns = new Set<JournalRun>()

  constructor(
    private readonly subagents: SubagentServiceLike,
    private readonly registry: WorkflowJournalRegistry,
    private readonly options: CcWorkflowJournalProviderOptions,
  ) {}

  /**
   * The delegate provider, resolved on first READ and cached (design A5):
   * the service consults capabilities before it ever calls start, so the
   * lookup cannot be deferred to start time.
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
    let jr = this.runs.get(request.signal)
    if (jr === undefined) {
      jr = this.claimRun()
      this.runs.set(request.signal, jr)
      this.liveRuns.add(jr)
    }
    const run = jr
    const idx = ++run.arrivalIndex
    const hash = hashSubagentRequest(request)

    // Frozen-until-first-miss replay (design §3.4). A stored line replays
    // only while unfrozen, at the same arrival index, with a matching hash
    // and a well-formed completed projection.
    if (run.replayLines !== undefined && !run.frozen) {
      const line = run.replayLines[idx - 1]
      if (line !== undefined && line.status === 'completed' && line.hash === hash) {
        const projection = projectionFromLine(line)
        if (projection !== undefined) {
          this.registry.markCached(run.runId, idx)
          try {
            run.writer.record(idx, line)
          } catch {
            // Copy-forward failure fails open to a live spawn (design §3.3).
            run.frozen = true
            this.options.warn(`cc-workflow-journal: copy-forward for run "${run.runId}" seq ${idx} failed; falling open to a live spawn`)
          }
          if (!run.frozen) {
            return {
              id: randomUUID() as unknown as SessionId,
              localAgent: undefined,
              result: Promise.resolve(projection),
              dispose: () => Promise.resolve(),
            }
          }
        }
      }
      if (!run.frozen) {
        // Hash mismatch, non-completed stored status, missing line, or a
        // malformed projection: freeze permanently — this and every later
        // seq spawns live (CC's "and so does every agent after it").
        run.frozen = true
      }
    }

    // Live path: transparent pass-through with a result tap for journaling.
    const delegateRun = await this.delegate().start(request)
    void delegateRun.result.then(
      settled => {
        run.writer.record(idx, {
          seq: idx,
          hash,
          status: settled.stopReason,
          result: {
            output: settled.output,
            ...(settled.structured !== undefined ? { structured: settled.structured } : {}),
            stopReason: settled.stopReason,
          },
        })
      },
      () => {
        /* rejected result = not settled; no journal line */
      },
    )
    return delegateRun
  }

  /** Claim the registry's pending deposit for an unseen signal (one-shot). */
  private claimRun(): JournalRun {
    const claim = this.registry.takePendingClaim()
    if (claim === undefined) {
      throw new Error('cc-workflow-journal: start on an unknown signal with no pending workflow-run claim')
    }
    mkdirSync(dirname(claim.journalPath), { recursive: true })
    const writer = new JournalWriter(claim.journalPath, {
      maxBytes: this.options.maxJournalBytes,
      warn: this.options.warn,
    })
    // Resume parse (design §3.2: the provider parses, never reads, the
    // deposited text). Live runs (no resumeOf) have nothing to replay —
    // replayLines stays undefined and the frozen latch is never consulted.
    let replayLines: JournalLine[] | undefined
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
          replayLines = parsed.lines
        }
      }
    }
    const unbind = this.registry.bindJournal(claim.runId, {
      drain: () => writer.drain(),
      markCached: index => this.registry.markCached(claim.runId, index),
    })
    return { runId: claim.runId, writer, unbind, arrivalIndex: 0, replayLines, frozen }
  }

  /**
   * Disposal cleanup (design §3.3): close every open writer, await the
   * drains, then delete each session's journal directory. Best-effort —
   * failures warn and never throw.
   */
  async disposeAllJournals(): Promise<void> {
    const runs = [...this.liveRuns]
    this.liveRuns.clear()
    const sessionDirs = new Set<string>()
    for (const run of runs) {
      sessionDirs.add(dirname(run.writer.journalPath))
      try {
        run.writer.close()
        await run.writer.drain()
      } catch (error) {
        this.options.warn(`cc-workflow-journal: drain during disposal failed: ${String(error)}`)
      }
      try {
        run.unbind()
      } catch {
        /* unbind is a Map delete; never fails in practice */
      }
    }
    for (const dir of sessionDirs) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        this.options.warn(`cc-workflow-journal: could not remove journal directory ${dir}: ${String(error)}`)
      }
    }
  }
}
