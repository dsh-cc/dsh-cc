/**
 * The subagent spawn helper for memory forks (extraction and dream): starts
 * the one-shot subagent (never registered on the jobs seam — internal memory
 * work stays invisible to the model surface) and maps the settled outcome onto
 * the JobHooks contract.
 * @module @dsh-cc/memory-consolidation/memory-job
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import {
  MEMORY_WRITES_SCHEMA,
  MemoryIndexConflictError,
  carveEntrypointRoom,
  commitMemoryWrites,
  mergeIndexContent,
  parseMemoryFile,
  pointerAdditions,
  renderExtractionPointer,
  upsertExtractionPointer,
  validateMemoryWrites,
  writeMemoryFiles,
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
  truncateEntrypointContent,
} from '@dsh-cc/memory'
import type { MemoryWrite } from '@dsh-cc/memory'

/** Structural subset of the subagent seam used here. */
interface SubagentService {
  startActivation(spec: {
    provider: string
    label: string
    request: {
      prompt: readonly { type: 'text'; text: string }[]
      parent: Agent
      maxDepth?: number
      outputSchema?: Record<string, unknown>
    }
    signal: AbortSignal
    delivery: 'parent' | 'caller'
  }): Promise<{ result: Promise<SubagentResultLike>; dispose(): Promise<void> }>
}

/**
 * The settled shape of a one-shot subagent run. The promise rejects only on
 * infrastructure faults; child-level failures (including "outputSchema was
 * requested but never reported", which upstream downgrades to `error`) arrive
 * as a resolved value and MUST be inspected here.
 */
interface SubagentResultLike {
  readonly structured?: unknown
  readonly stopReason?: string
}

/** The job-done outcome: resolves only, per the JobHooks contract. */
export type JobOutcome = { status: 'completed' } | { status: 'killed' } | { status: 'failed'; detail: string }

/**
 * The only labels a memory fork may be dispatched under (design §B). The label
 * selects the write-back policy — `memory-consolidation` keeps the dream's
 * full-index rewrite, `extract-memories` gets the host-side upsert — so an
 * unknown label must never silently default to either.
 */
export const MEMORY_JOB_LABELS = ['extract-memories', 'memory-consolidation'] as const

/** A validated memory-job label. */
export type MemoryJobLabel = typeof MEMORY_JOB_LABELS[number]

/**
 * Narrow a raw label to the dispatchable set.
 * @param label - the raw label.
 * @returns true when the label is known.
 */
function isMemoryJobLabel(label: string): label is MemoryJobLabel {
  return (MEMORY_JOB_LABELS as readonly string[]).includes(label)
}

/**
 * The control object {@link startMemoryJob} resolves to, named so callers can
 * hold it (a test rig, the extraction coordinator's `active` state) without
 * re-spelling the inline type.
 *
 * `done` is the real completion boundary: it resolves only after the reported
 * batch was validated and written host-side (design
 * docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md §"The existing
 * fork also carries the negative verdict"), so a watermark commit must await it
 * rather than the start call.
 */
export interface MemoryJobControl {
  /** Cancel the fork; the reason is diagnostic only. */
  abort(reason?: string): void
  /** True only when the reported writes were validated and persisted. */
  settled: Promise<boolean>
  /** The terminal outcome, after the host write-back. */
  done: Promise<JobOutcome>
}

/**
 * Over-limit measurement for the entrypoint, identical to the write-side gate
 * semantics (trim → split('\n') → count; byteLength of the trimmed content).
 * @param content - a reported `MEMORY.md` body.
 */
function entrypointOverLimit(content: string): boolean {
  const trimmed = content.trim()
  return trimmed.split('\n').length > MAX_ENTRYPOINT_LINES
    || Buffer.byteLength(trimmed, 'utf8') > MAX_ENTRYPOINT_BYTES
}

/**
 * Legacy design §2.4 fallback, retained as a public helper: if the reported
 * payload carries an over-limit `MEMORY.md`, replace its content with the
 * deterministic truncation output (capped body + visible in-file warning
 * banner) instead of failing the job. The memory-job write-back no longer
 * calls this — its over-limit duty is subsumed by `carveEntrypointRoom` in the
 * §3.4 commit pipeline — but the export keeps the pre-move surface intact.
 * Topic-file writes pass through untouched; a compliant entrypoint is returned
 * byte-identical. Takes the raw structured payload (the entrypoint gate inside
 * `validateMemoryWrites` throws during validation, so the replacement must
 * happen before it) and
 * returns a payload of the same shape; malformed payloads pass through and
 * are rejected by validation as usual.
 */
export function applyEntrypointFallback(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload
  const raw = (payload as { writes?: unknown }).writes
  if (!Array.isArray(raw)) return payload
  const writes: unknown[] = raw.map((entry) => {
    if (typeof entry !== 'object' || entry === null) return entry
    const { path, content } = entry as { path?: unknown; content?: unknown }
    if (path !== ENTRYPOINT_NAME || typeof content !== 'string' || !entrypointOverLimit(content)) {
      return entry
    }
    return { ...entry, content: truncateEntrypointContent(content).content }
  })
  return { ...(payload as object), writes }
}

/**
 * Split a settled fork report into the §3.4 write-back inputs: every write
 * whose path is not `MEMORY.md`, and the single index write's content. Returns
 * `undefined` for anything else (a malformed payload, no index write, or more
 * than one) — those fall through to `validateMemoryWrites`, which rejects a
 * multi-`MEMORY.md` batch exactly as it did before this pipeline existed.
 * @param structured - the raw `structured` value captured from the fork.
 */
function splitIndexWrite(
  structured: unknown,
): { topicWrites: unknown[]; modelIndex: string } | undefined {
  if (typeof structured !== 'object' || structured === null || Array.isArray(structured)) return undefined
  const raw = (structured as { writes?: unknown }).writes
  if (!Array.isArray(raw)) return undefined
  const isIndexWrite = (entry: unknown): boolean =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    && (entry as { path?: unknown }).path === ENTRYPOINT_NAME
  const indexEntries = raw.filter(isIndexWrite)
  if (indexEntries.length !== 1) return undefined
  const { content } = indexEntries[0] as { content?: unknown }
  if (typeof content !== 'string') return undefined
  return { topicWrites: raw.filter(entry => !isIndexWrite(entry)), modelIndex: content }
}

/**
 * The §3.4 write-back pipeline, dispatched by job label.
 *
 * `memory-consolidation` (the dream) is unchanged: a batch without a `MEMORY.md`
 * write is a plain validated write; a batch with one commits through the
 * optimistic index protocol, where the model's rewrite is the base, the
 * concurrent additions beyond `baselineIndex` are appended, and
 * `carveEntrypointRoom` makes room for them under the entrypoint caps
 * (subsuming the old over-limit fallback). The builder owns validation, so a
 * rejection (invalid payload, additions alone over the caps) exits the commit
 * loop immediately.
 *
 * `extract-memories` ignores the fork's index write entirely and lets the host
 * upsert one pointer per batch topic (design
 * docs/plans/2026-11-12-extraction-index-coverage-fix.md §A):
 * `baselineIndex` is not consumed at all, so a capped prompt baseline can no
 * longer be mistaken for concurrent additions.
 * @param fs - the filesystem seam.
 * @param dir - the memory directory root.
 * @param structured - the fork's raw structured report.
 * @param baselineIndex - the exact index snapshot the model's input was fixed against (dream only).
 * @param label - the validated job label.
 * @param warn - sink for degradation warnings of the committed attempt.
 */
async function writeBackReport(
  fs: FileSystem,
  dir: string,
  structured: unknown,
  baselineIndex: string,
  label: MemoryJobLabel,
  warn: (message: string) => void,
): Promise<void> {
  if (label === 'extract-memories') {
    await writeExtractionReport(fs, dir, structured, warn)
    return
  }
  const split = splitIndexWrite(structured)
  if (split === undefined) {
    await writeMemoryFiles(fs, dir, validateMemoryWrites(structured))
    return
  }
  const { topicWrites, modelIndex } = split
  await commitMemoryWrites(fs, dir, async (fresh) => {
    const additions = pointerAdditions(fresh, modelIndex, baselineIndex)
    const merged = mergeIndexContent(modelIndex, fresh, baselineIndex)
    const finalContent = carveEntrypointRoom(merged, modelIndex, additions)
    return {
      writes: validateMemoryWrites({
        writes: [...topicWrites, { path: ENTRYPOINT_NAME, content: finalContent }],
      }),
      meta: undefined,
    }
  })
}

/**
 * Remove every `MEMORY.md` entry from a fork report (design §A.1). The drop
 * happens BEFORE validation on purpose: an over-cap or malformed fork index is
 * going to be ignored anyway, so it must never fail the batch. Non-array /
 * malformed payloads pass through untouched and are rejected by
 * `validateMemoryWrites` as usual.
 * @param structured - the fork's raw structured report.
 * @returns the report with its index writes removed.
 */
function dropIndexWrites(structured: unknown): unknown {
  if (typeof structured !== 'object' || structured === null || Array.isArray(structured)) return structured
  const raw = (structured as { writes?: unknown }).writes
  if (!Array.isArray(raw)) return structured
  const isIndexWrite = (entry: unknown): boolean =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    && (entry as { path?: unknown }).path === ENTRYPOINT_NAME
  return { ...(structured as object), writes: raw.filter(entry => !isIndexWrite(entry)) }
}

/**
 * The extraction write-back (design §A.3): the fork supplies topic files only;
 * the host derives each pointer from that topic's own frontmatter and upserts it
 * into the durable index inside the existing optimistic commit loop.
 *
 * Per attempt the upserts are re-derived from the fresh index (stateless across
 * CAS rounds), and the attempt's warnings ride out as metadata — only the
 * committed attempt's warnings are ever emitted. No index write is emitted when
 * the resulting content is byte-identical to the fresh index: that covers an
 * empty payload, an index frozen at its cap, and every skipped upsert, and it
 * guarantees a pre-existing over-cap index never produces a failing write (the
 * host-generated index is not re-validated through `validateMemoryWrites`).
 * @param fs - the filesystem seam.
 * @param dir - the memory directory root.
 * @param structured - the fork's raw structured report.
 * @param warn - sink for the committed attempt's warnings.
 */
async function writeExtractionReport(
  fs: FileSystem,
  dir: string,
  structured: unknown,
  warn: (message: string) => void,
): Promise<void> {
  // Validate the topic payload only; an empty payload after the drop is legal —
  // the job completes with zero writes.
  const topicWrites = validateMemoryWrites(dropIndexWrites(structured))
  if (topicWrites.length === 0) return
  const commit = await commitMemoryWrites(fs, dir, async (fresh) => {
    const warnings: string[] = []
    const unparseable: string[] = []
    let index = fresh
    // Batch order: a skipped upsert leaves the running index untouched, so a
    // later (smaller) pointer is still judged against what would really land.
    for (const write of topicWrites) {
      const parsed = parseMemoryFile(write.content)
      if (parsed === undefined) {
        // Degraded visibility, documented and warned: the topic commits with no
        // index line and no scan/recall presence — grep only. Never a failure.
        unparseable.push(write.path)
        continue
      }
      const rendered = renderExtractionPointer(write.path, parsed.frontmatter)
      const upsert = upsertExtractionPointer(index, write.path, rendered.line)
      // Rendering warnings (truncation) describe the emitted line: they fire
      // only when that line actually lands — a cap-skipped or multi-target-
      // skipped upsert never wrote it (grok r4 P2). Skip warnings always fire.
      if (upsert.action !== 'skipped') warnings.push(...rendered.warnings)
      if (upsert.warning !== undefined) warnings.push(upsert.warning)
      index = upsert.content
    }
    if (unparseable.length > 0) {
      warnings.push(
        `memory-consolidation: extraction write-back: no index pointer for `
        + `${unparseable.map(path => `"${path}"`).join(', ')} (unparseable frontmatter); the topic file(s) were `
        + 'written and are discoverable by grep only',
      )
    }
    const writes: MemoryWrite[] = index === fresh
      ? topicWrites
      : [...topicWrites, { path: ENTRYPOINT_NAME, content: index }]
    return { writes, meta: { warnings } }
  })
  for (const message of commit.meta.warnings) warn(message)
}

/**
 * Start a memory-scoped forked subagent as a background job. The fork reports
 * its file set via `outputSchema`; on settlement the plugin validates the
 * batch and writes it host-side under a policy confined to `dir`. Resolves to
 * a control object with an abort hook and a settle promise (true only when
 * the reported writes were validated and persisted).
 *
 * `baselineIndex` is the exact index content the model's input was fixed
 * against (extraction: the prompt-injected string; dream: the strict read
 * taken before dispatch). The dream's write-back merge treats any pointer
 * beyond it as a concurrent addition, so a save landing after the capture
 * survives; the extraction write-back does not consume it at all (its pointers
 * are host-derived upserts, see `writeExtractionReport`).
 */
export async function startMemoryJob(
  ctx: Context,
  agent: Agent,
  dir: string,
  provider: string,
  label: string,
  prompt: string,
  baselineIndex: string,
): Promise<MemoryJobControl> {
  if (!isMemoryJobLabel(label)) {
    throw new Error(`unknown memory job label "${label}": expected one of ${MEMORY_JOB_LABELS.join(', ')}`)
  }
  const subagents = ctx.get('subagents') as SubagentService | undefined
  if (subagents === undefined) {
    return { abort: () => {}, settled: Promise.resolve(false), done: Promise.resolve({ status: 'failed', detail: 'subagents seam unavailable' }) }
  }
  const fs = ctx.get('fs') as FileSystem | undefined
  const controller = new AbortController()
  // rc.5: one-shot activation (delivery 'caller'). The read-only tool
  // restriction no longer rides the start request — the composition seam
  // applies it (plan C5). The controller signal now covers ONLY cancellation
  // before publication; execution-time abort goes through `dispose()`.
  const activation = await subagents.startActivation({
    provider,
    label,
    signal: controller.signal,
    request: {
      prompt: [{ type: 'text', text: prompt }],
      parent: agent,
      // Defense-in-depth recursion cap: the top-level listener already gates on
      // depth zero, so this fork's child never delegates. maxDepth is compared
      // against the CHILD's resolved depth (parent + 1); a top-level parent's
      // child resolves to 1 and passes, a grandchild to 2 is rejected.
      maxDepth: 1,
      outputSchema: MEMORY_WRITES_SCHEMA,
    },
    delivery: 'caller',
  })
  // Kill the running fork exactly once (idempotent upstream): on abort, on
  // settle, and on agent disposal. Teardown failures never surface.
  const kill = (): void => { void activation.dispose().catch(() => {}) }
  // Real job-done wiring: `done` maps the subagent outcome onto the JobHooks
  // contract (must never reject). Aborted → killed (rolls back the dream
  // lock); a non-completed stopReason, a missing/invalid payload, or a
  // write-back failure → failed with detail; a validated, persisted batch →
  // completed. All branches resolve.
  const done: Promise<JobOutcome> = activation.result.then(
    async (res): Promise<JobOutcome> => {
      if (controller.signal.aborted) return { status: 'killed' }
      if (res?.stopReason !== 'completed') {
        return { status: 'failed', detail: `memory fork ended with stopReason ${String(res?.stopReason)}` }
      }
      if (fs === undefined) {
        return { status: 'failed', detail: 'fs seam unavailable for memory write-back' }
      }
      try {
        await writeBackReport(
          fs,
          dir,
          res.structured,
          baselineIndex,
          label,
          (message: string) => { ctx.logger.warn(message) },
        )
        return { status: 'completed' }
      } catch (err) {
        // Exhausted rebases: the dream's bounded retry (or a later eligible
        // extraction turn) is the recovery path, per design §3.4.
        if (err instanceof MemoryIndexConflictError) {
          return { status: 'failed', detail: `index commit conflict after ${err.attempts} attempts` }
        }
        return { status: 'failed', detail: String(err) }
      }
    },
    (err): JobOutcome =>
      controller.signal.aborted ? { status: 'killed' } : { status: 'failed', detail: String(err) },
  )
  const settled = done.then(o => o.status === 'completed')
  // Per-agent disposal guarantee (replaces the old jobs-seam owner link):
  // aborting the agent's fiber aborts this fork and awaits its settle, and a
  // settled job detaches its own effect. Registered AFTER the dispatch (a
  // dispatch throw must not leak an effect), wrapped so a disposing scope —
  // which rejects new effects — is a no-op, never a new failure path.
  let dispose: (() => void) | undefined
  try {
    dispose = agent.ctx.effect(() => async () => {
      controller.abort('agent disposed')
      kill()
      await done.catch(() => {})
    }, 'memory-consolidation: cancel the fork on agent disposal')
  } catch { /* agent scope already disposing: the fork dies with it anyway */ }
  // One-shot dispose policy: a settled job never keeps the fork resident.
  void done.finally(() => { kill(); dispose?.() })
  return { abort: (reason?: string) => { controller.abort(reason); kill() }, settled, done }
}
