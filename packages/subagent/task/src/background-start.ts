/**
 * The Task tool's background/collect start mechanics: env kill-switch parsing,
 * the §3.6 capacity guard, capability probes, request preparation (pin
 * preallocation), and the two dispatch paths — `startBackground` (durable
 * continuable child, returns immediately) and `collectForeground` (inline
 * first-epoch collection through the epoch collector, promotable via Ctrl+B).
 *
 * Pure mechanics shared by the tool definition in `./tool.ts`; no behavior
 * here beyond what `tool.ts` already performed — this module is a structural
 * split of that file.
 *
 * @module @dsh-cc/subagent-task/background-start
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentDefinition, ToolRestriction } from '@dsh-cc/claude-code-agents'
import { cwdOf } from '@dsh-cc/memory'
import type { DetailedRoute, ModelRoutes } from '@dsh-cc/model-aliases'
import { collectFirstEpoch, type EpochEventBus, type EpochOutcome } from './epoch-collector.ts'
import { SpawnPinCapture } from './resume-capture.ts'

/** Fresh-child provider: no parent conversation (CC Task default). */
export const PROVIDER_SPAWN = 'spawn'

/**
 * Per-parent admission limit for continuable children (UX plan §3.6): no
 * upstream resident-children cap exists, so the Task tool refuses a new
 * continuable start when the parent already has this many live children —
 * counted directly as `listChildren` entries with `activity: 'running'`.
 * A safety valve, not a scheduling policy.
 */
export const MAX_LIVE_CONTINUABLE_CHILDREN = 25

/**
 * The env kill switch (UX plan §3.4): a non-empty value other than
 * case-insensitive `0`/`false` disables backgrounding-by-default.
 */
export const CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'

/** A structural subset of the subagents seam the tool dispatches through. */
export interface ContinuableStart {
  childId: string
  messageId: string
}

export interface SubagentsLike {
  start(name: string, request: {
    label?: string
    prompt: readonly { type: 'text'; text: string }[]
    parent: Agent
    signal: AbortSignal
    agentOptions?: Record<string, string>
    toolFilter?: ToolRestriction
    maxDepth?: number
    persona?: string
  }): Promise<{
    result: Promise<{ stopReason: string; output?: readonly { type: string; text?: string }[] }>
  }>
  /**
   * Duck-typed continuable-creation entry (harness `ctx.subagents.startContinuable`):
   * establishes a durable child that accepts follow-up turns by its `childId`.
   * A seam without it cannot serve background dispatch.
   */
  startContinuable?(spec: {
    provider: string
    label: string
    /** Caller-reserved durable id (becomes the child's session id). */
    childId?: string
    request: {
      prompt: readonly { type: 'text'; text: string }[]
      parent: Agent
      agentOptions?: Record<string, string>
      toolFilter?: ToolRestriction
      maxDepth?: number
      persona?: string
    }
    signal: AbortSignal
  }): Promise<ContinuableStart>
  getProvider(name: string): unknown
  list(): string[]
  /**
   * Duck-typed interrupt (harness `ctx.subagents.interrupt`): cancels a live
   * child's current turn; admission is synchronous and an absent/settled
   * target is an accepted no-op. Used by the epoch collector's abort path.
   * Absent → abort degrades to a prompt resolve without interrupting.
   */
  interrupt?(childId: string, authority: { kind: 'ancestor'; agent: Agent }): void
  /**
   * Duck-typed `listChildren` (harness `ctx.subagents.listChildren`): the
   * durable children of one parent session with a store-snapshot `activity`.
   * Used by the §3.6 capacity guard. Absent → the guard degrades open.
   */
  listChildren?(parentSessionId: string, signal?: AbortSignal): Promise<
    { kind: string; activity?: string }[]
  >
}

/** A structural subset of a provider descriptor exposing the capability probe. */
interface ProviderLike {
  prepareContinuable?: unknown
}

/**
 * The background request shape: everything `startContinuable` forwards except
 * the provider/label envelope and the signal, which live at the spec level.
 */
export type BackgroundRequest = {
  label: string
  prompt: readonly { type: 'text'; text: string }[]
  parent: Agent
  signal: AbortSignal
  maxDepth?: number
  persona?: string
  agentOptions?: Record<string, string>
  toolFilter?: ToolRestriction
  /**
   * Caller-reserved durable child id — preallocated by the capture flow so
   * the pin can be written before the child exists (plan §4.5 step 1).
   */
  childId?: string
  /** Capture-only metadata (never forwarded to the seam): definition. */
  captureDefinition?: AgentDefinition
  /** Capture-only metadata: the atomic model-selector resolution. */
  captureSelector?: DetailedRoute
}

/**
 * Parse `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` (UX plan §3.4): a non-empty
 * value other than a case-insensitive `0`/`false` disables the kill switch's
 * targets (backgrounding-by-default pins and, from Slice 3, promotion).
 * Explicit `run_in_background` arguments stay honored both ways — declared
 * as a partial-parity deviation because upstream's exact precedence is
 * unverified.
 * @param env - the environment to read; defaults to `process.env`.
 */
export function backgroundTasksDisabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[CLAUDE_CODE_DISABLE_BACKGROUND_TASKS]
  if (raw === undefined || raw === '') return false
  const lower = raw.toLowerCase()
  return lower !== '0' && lower !== 'false'
}

/**
 * Precedence for the background decision: explicit `run_in_background` always wins
 * (true and false alike), otherwise the definition's `background: true` pin applies,
 * otherwise foreground. A `true`-string pin cannot reach this check — the agents
 * parser rejects a non-boolean `background` at load time. With the
 * `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` kill switch armed, the pin path is
 * disabled (omissions collect in foreground); explicit arguments still win.
 */
export function wantsBackground(
  args: { run_in_background?: boolean },
  definition: { background?: boolean } | undefined,
  disabled: boolean,
): boolean {
  if (args.run_in_background === true) return true
  if (args.run_in_background === false) return false
  if (disabled) return false
  return definition?.background === true
}

/**
 * Thread the preallocated childId and the capture metadata into a background
 * request. Without capture (no `resumePins` config) the request is returned
 * unchanged — zero behavior difference.
 */
export function preparedBackground(
  request: BackgroundRequest,
  capture: SpawnPinCapture | undefined,
  definition?: AgentDefinition,
  routes?: ModelRoutes,
): BackgroundRequest {
  if (capture === undefined) return request
  return {
    ...request,
    childId: capture.preallocateChildId(),
    ...(definition !== undefined ? { captureDefinition: definition } : {}),
    captureSelector: routes !== undefined
      ? routes.resolveDetailed(definition?.model)
      : SpawnPinCapture.inheritSelector(definition?.model),
  }
}

/**
 * The §3.6 capacity guard (both `startBackground` and the collect path):
 * refuse a new continuable child when the parent already has
 * {@link MAX_LIVE_CONTINUABLE_CHILDREN} live children — counted directly as
 * `listChildren` entries with `activity: 'running'`. Degrades open when the
 * seam lacks `listChildren` or the listing fails: a safety valve must never
 * block starts on its own infrastructure trouble.
 */
export async function assertLiveCapacity(
  seam: SubagentsLike,
  parent: Agent,
  signal: AbortSignal,
): Promise<void> {
  if (typeof seam.listChildren !== 'function') return
  let children: { kind: string; activity?: string }[]
  try {
    children = await seam.listChildren(parent.id, signal)
  } catch {
    return
  }
  const live = children.filter(child => child.kind === 'child' && child.activity === 'running').length
  if (live >= MAX_LIVE_CONTINUABLE_CHILDREN) {
    throw new Error(
      `parent has ${MAX_LIVE_CONTINUABLE_CHILDREN} live subagents; /agents stop <id> to `
      + 'release one, or let children settle',
    )
  }
}

/** Capability checks shared by `startBackground` and the collect path. */
export function assertContinuableCapable(seam: SubagentsLike): void {
  if (typeof seam.startContinuable !== 'function') {
    throw new Error(
      'background subagents are unavailable: the subagents seam does not expose '
      + 'startContinuable. Background subagents require a subagent service with the '
      + 'continuable-creation capability (prepareContinuable on the provider) and a '
      + 'session-persistence backend; run this Task in the foreground instead.',
    )
  }
  const provider = seam.getProvider(PROVIDER_SPAWN) as ProviderLike | undefined
  if (provider !== undefined && provider !== null && provider.prepareContinuable === undefined) {
    throw new Error(
      `background subagents are unavailable: provider "${PROVIDER_SPAWN}" does not support `
      + 'continuable children (UNSUPPORTED_CAPABILITY: no prepareContinuable). Background '
      + 'subagents require a provider that implements the continuable-creation capability '
      + 'and a session-persistence backend; run this Task in the foreground instead.',
    )
  }
}

/**
 * Per-reason failure copy for the collect path (UX plan §4 Slice 3 item 2):
 * mirrors `settle`'s contract — `completed` becomes the tool result, every
 * other stop reason throws with a reason-specific, actionable message.
 */
function stopReasonMessage(childId: string, stopReason: string): string {
  switch (stopReason) {
    case 'error':
      return `subagent ${childId} run failed: the child hit a model or transport failure (stopReason "error").`
    case 'max-tokens':
      return `subagent ${childId} stopped with reason "max-tokens": the child hit its token ceiling before finishing.`
    case 'refusal':
      return `subagent ${childId} stopped with reason "refusal": the child declined the task.`
    case 'aborted':
      return `subagent ${childId} was interrupted (stopReason "aborted"); it may still be resumed — /agents for status.`
    default:
      return `subagent ${childId} stopped with reason "${stopReason}".`
  }
}

/**
 * The user-promotion result (Ctrl+B, UX plan §3.4): the foreground wait is
 * released to background — the model sees the SAME contract as an explicit
 * `run_in_background: true` launch, with `backgroundedByUser: true` marking
 * the promotion. The child's report/finish notice arrives later as a wake
 * (its suppression mark was removed by `promote()` — exactly-once delivery).
 */
function promotedResult(
  childId: string,
  captureWarning: string | undefined,
): { text: string; status: 'async_launched'; agentId: string; backgroundedByUser: true } {
  return {
    text:
      `Background subagent started (agentId: ${childId}). The user moved the foreground wait `
      + 'to the background while it ran (status async_launched, backgroundedByUser: true); treat '
      + 'this exactly like a background launch — the result arrives as a later waking message, '
      + 'so do not compose on an inline result. '
      + 'Control it by that id: `list_agents` for status, `send_message` to continue the same '
      + 'conversation, `interrupt_agent` to stop its current turn.'
      + (captureWarning !== undefined
        ? `\nresume pin capture failed: ${captureWarning}; this child will resume with legacy semantics`
        : ''),
    status: 'async_launched',
    agentId: childId,
    backgroundedByUser: true,
  }
}

/**
 * Project the collect path's epoch outcome onto the tool output shape
 * (`settle`'s contract): `completed` → the closing message's text blocks;
 * any other stop reason — including the abort path's prompt-synthetic
 * `aborted` — throws with per-reason copy.
 */
function outcomeToResult(
  childId: string,
  outcome: EpochOutcome,
  captureWarning: string | undefined,
): { text: string; status: 'completed' } {
  // A promoted outcome never reaches here (the collect caller returns the
  // async_launched result first); defensively it is an unexpected terminal.
  if (outcome.kind !== 'epoch' || outcome.stopReason !== 'completed') {
    throw new Error(stopReasonMessage(childId, outcome.kind === 'epoch' ? outcome.stopReason : outcome.kind))
  }
  const text = (outcome.output ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')
  return {
    text:
      text
      + (captureWarning !== undefined
        ? `\nresume pin capture failed: ${captureWarning}; this child will resume with legacy semantics`
        : ''),
    status: 'completed' as const,
  }
}

/**
 * Dispatch a FOREGROUND non-fork call by collecting the child's first epoch
 * inline through the epoch collector (`docs/plans/2026-09-05-epoch-collector-dsh-cc.md`).
 * Performs the same pin preallocation, pre-start pin write, and
 * tombstone-on-throw as `startBackground` — a foreground-launched child is
 * pinnable/resumable exactly like a background one. The child's settlement
 * notice is suppressed (pop-once) because the epoch is consumed here.
 */
export async function collectForeground(
  ctx: Context,
  seam: SubagentsLike,
  request: BackgroundRequest,
  capture: SpawnPinCapture | undefined,
  exec: { agent?: Agent; signal: AbortSignal; token?: unknown },
): Promise<{ text: string; status: 'completed' } | { text: string; status: 'async_launched'; agentId: string; backgroundedByUser: true }> {
  const agent = exec.agent
  if (agent === undefined) {
    throw new Error('subagent_fork requires a calling agent (exec.agent was undefined)')
  }
  await assertLiveCapacity(seam, agent, exec.signal)
  assertContinuableCapable(seam)
  const { label, prompt, parent, signal, childId, captureDefinition, captureSelector, ...rest } = request
  // The watch map keys on the durable child id, so the collect path ALWAYS
  // preallocates one — via the capture flow when pins are armed, otherwise a
  // fresh id (the child's session id, exactly as the harness would mint it).
  const durableChildId = childId ?? randomUUID()
  // §4.5 step 2 (parity with startBackground): the pin is written BEFORE the
  // creation call; capture trouble becomes an explicit captureWarning line.
  let captureWarning: string | undefined
  if (capture !== undefined && childId !== undefined && captureSelector !== undefined) {
    captureWarning = await capture.write({
      parentSessionId: parent.id,
      label,
      childId,
      definition: captureDefinition,
      selector: captureSelector,
      parentRoute: parent.options,
      toolFilter: 'toolFilter' in rest ? rest.toolFilter : undefined,
      cwd: cwdOf(parent),
    })
  }
  let startFailed = false
  try {
    const outcome = await collectFirstEpoch({
      bus: ctx as unknown as EpochEventBus,
      childId: durableChildId,
      agent,
      signal,
      subagents: seam,
      // The promotion-registry key (§6): parent session + this call's
      // registry token, so the TUI busy-branch Ctrl+B can find (and promote
      // or abort) every armed foreground collect of this session.
      parentSessionId: agent.id,
      toolCallToken: exec.token !== undefined ? String(exec.token) : randomUUID(),
      start: async () => {
        try {
          await seam.startContinuable!({
            provider: PROVIDER_SPAWN,
            label,
            childId: durableChildId,
            request: {
              prompt,
              parent,
              ...('persona' in rest ? { persona: rest.persona } : {}),
              ...('toolFilter' in rest ? { toolFilter: rest.toolFilter } : {}),
              ...('agentOptions' in rest ? { agentOptions: rest.agentOptions } : {}),
              ...('maxDepth' in rest ? { maxDepth: rest.maxDepth } : {}),
            },
            signal,
          })
        } catch (error) {
          startFailed = true
          throw error
        }
      },
    })
    if (outcome.kind === 'promoted') return promotedResult(durableChildId, captureWarning)
    return outcomeToResult(durableChildId, outcome, captureWarning)
  } catch (error) {
    // §4.5 step 4 (parity with startBackground): a start that rolled back the
    // creation must not leave the pin behind — tombstone, then rethrow. A
    // non-`completed` epoch terminal or an abort keeps the child (it is
    // resumable), so no tombstone on those.
    if (startFailed && capture !== undefined && childId !== undefined) await capture.tombstone(childId)
    const message = (error as Error).message ?? String(error)
    if (startFailed
      && (message.includes('UNSUPPORTED_CAPABILITY') || message.includes('does not support continuable'))) {
      throw new Error(
        `background subagents are unavailable: ${message}. Background subagents require a `
        + 'provider that implements the continuable-creation capability (prepareContinuable) '
        + 'and a session-persistence backend; run this Task in the foreground instead.',
      )
    }
    throw error
  }
}

/**
 * Dispatch a background call as a durable continuable child on the `spawn`
 * provider. The definition folding (persona, sanitized toolFilter,
 * alias-resolved agentOptions, maxDepth) happened before this call — cold
 * resume never re-captures the parent's policy, so the creation input must
 * already be final. Resolves once the child accepted its initial prompt.
 * Capability gaps (seam without `startContinuable`, provider without
 * `prepareContinuable`) surface as actionable tool errors naming the cause.
 */
export async function startBackground(
  seam: SubagentsLike,
  request: BackgroundRequest,
  capture?: SpawnPinCapture,
): Promise<{ text: string; status: 'async_launched'; agentId: string }> {
  assertContinuableCapable(seam)
  const { label, prompt, parent, signal, childId, captureDefinition, captureSelector, ...rest } = request
  // §3.6 capacity guard: refuse before any pin write or creation call.
  await assertLiveCapacity(seam, parent, signal)
  // §4.5 step 2: the pin is written BEFORE the creation call (crash
  // consistency). A failed capture keeps the spawn alive but must never be
  // silent: the returned reason becomes an explicit captureWarning line in
  // the tool result ("this child will resume with legacy semantics").
  let captureWarning: string | undefined
  if (capture !== undefined && childId !== undefined && captureSelector !== undefined) {
    captureWarning = await capture.write({
      parentSessionId: parent.id,
      label,
      childId,
      definition: captureDefinition,
      selector: captureSelector,
      parentRoute: parent.options,
      toolFilter: 'toolFilter' in rest ? rest.toolFilter : undefined,
      cwd: cwdOf(parent),
    })
  }
  let started: ContinuableStart
  try {
    started = await seam.startContinuable!({
      provider: PROVIDER_SPAWN,
      label,
      ...(childId !== undefined ? { childId } : {}),
      request: {
        prompt,
        parent,
        ...('persona' in rest ? { persona: rest.persona } : {}),
        ...('toolFilter' in rest ? { toolFilter: rest.toolFilter } : {}),
        ...('agentOptions' in rest ? { agentOptions: rest.agentOptions } : {}),
        ...('maxDepth' in rest ? { maxDepth: rest.maxDepth } : {}),
      },
      signal,
    })
  } catch (error) {
    // §4.5 step 4: the creation rolled back fully (no child id), so the pin
    // must not survive it — tombstone, then rethrow the error unchanged.
    if (capture !== undefined && childId !== undefined) await capture.tombstone(childId)
    const message = (error as Error).message ?? String(error)
    if (message.includes('UNSUPPORTED_CAPABILITY') || message.includes('does not support continuable')) {
      throw new Error(
        `background subagents are unavailable: ${message}. Background subagents require a `
        + 'provider that implements the continuable-creation capability (prepareContinuable) '
        + 'and a session-persistence backend; run this Task in the foreground instead.',
      )
    }
    throw error
  }
  return {
    text:
      `Background subagent started (agentId: ${started.childId}). It is running in the `
      + 'background; its report or finish notice will arrive as a waking message. Control it '
      + 'by that id: `list_agents` for status, `send_message` to continue the same '
      + 'conversation, `interrupt_agent` to stop its current turn.'
      + (captureWarning !== undefined
        ? `\nresume pin capture failed: ${captureWarning}; this child will resume with legacy semantics`
        : ''),
    status: 'async_launched',
    agentId: started.childId,
  }
}
