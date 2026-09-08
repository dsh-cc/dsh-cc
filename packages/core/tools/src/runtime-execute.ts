/**
 * ToolRuntime execution-pipeline collaborators: execution creation, the
 * pre-execute/ask/guard policy stages, around-dispatch, and the scheduler's
 * staged entry points. Bodies are verbatim moves from the former `ToolRuntime`
 * methods with `this.` → `rt.`; reverse calls into other clusters (registry
 * resolution, approval ask, result materialization) go through `rt`.
 * @module
 */

import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { assertNever, deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { createExecutionToken, fuseToolSignals, isAborted, toolAbortedBeforeDispatchResult, toolAbortedResult, toolErrorResult, ToolNotFoundError } from './abort-utils.ts'
import { RUN_CODE_NAME } from './code-mode.ts'
import type { MutableToolRunContext, PreToolDecision, ScheduledToolDispatch, ScheduledToolPreparation, ToolDefinition, ToolExecution, ToolExecutionInput, ToolExecutionResult, ToolRunContext } from './tool-types.ts'
import type { ToolAskResolution } from './tool-layer.ts'
import type { ToolRuntimeCore } from './runtime-core.ts'

/**
 * Execute through pre-policy, guards, around-dispatch, post-policy,
 * definition-owned content finalization, and final notification. Tool and
 * listener failures resolve as materialized error results; an invisible tool
 * reports `UNKNOWN_TOOL`. The returned outcome is the same lossless, frozen
 * snapshot final observers receive. Cancellation
 * arriving after entry and before final result materialization skips a
 * not-yet-started body with `ABORTED_BEFORE_DISPATCH` or replaces a
 * successful started outcome with `ABORTED`; already-started work is still
 * drained and may retain a tool-owned structured error.
 * @param rt - the owning runtime.
 * @param exec - the typed same-process call input. The registry assigns its
 *   correlation token before policy begins.
 * @returns the materialized final result.
 */
export async function execute(rt: ToolRuntimeCore, exec: ToolExecutionInput): Promise<ToolExecutionResult> {
  return rt.prepareExecution(exec, prepared => rt.completeScheduledExecution(prepared))
}

export async function completeScheduledExecution(rt: ToolRuntimeCore, prepared: ScheduledToolPreparation): Promise<ToolExecutionResult> {
  switch (prepared.kind) {
    case 'dispatch': {
      const dispatched = await rt.dispatchScheduledExecution(prepared.exec)
      return dispatched.kind === 'post-result'
        ? await rt.finalizeScheduledExecution(prepared.exec, dispatched.result)
        : rt.finishScheduledExecution(prepared.exec, dispatched.result)
    }
    case 'post-result':
      return await rt.finalizeScheduledExecution(prepared.exec, prepared.result)
    case 'final-result':
      return rt.finishScheduledExecution(prepared.exec, prepared.result)
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default:
      return assertNever(prepared, 'scheduled tool preparation')
  }
}

export function createExecution(rt: ToolRuntimeCore, exec: ToolExecutionInput): ScheduledToolPreparation | { kind: 'ready'; exec: MutableToolRunContext } {
  const deferredContexts: UserMessage[] = []
  const token = createExecutionToken()
  const callId = exec.callId
  const rootCallId = exec.rootCallId ?? callId
  const name = exec.name
  const agent = exec.agent
  const parent = exec.parent
  const signal = exec.signal
  // Distinguish a mode-collapsed call (visible in the scope, denied only by
  // the `code` collapse) from a genuinely unknown tool. A collapsed call is
  // deterministically denied, so it terminates BEFORE the extensible policy
  // pipeline: pre-execute listeners, approval `ask`, and guards must never
  // observe — or worse, approve — a call that can only fail. An unknown tool
  // keeps the historical dispatch-stage `UNKNOWN_TOOL` path so policy
  // listeners still see every name that reaches the registry.
  const visible = rt.get(name, agent)
  const collapsed = visible !== undefined && rt.collapses(name, agent, parent !== undefined)
  const concludingExecutions = rt.concludingExecutions
  const base = {
    token,
    callId,
    rootCallId,
    name,
    signal,
    ...agent !== undefined ? { agent } : {},
    ...parent !== undefined ? { parent } : {},
    deferContext(context: UserMessage): void {
      deferredContexts.push(context)
    },
    concludeTurn(): void {
      concludingExecutions.add(this as unknown as ToolExecution)
    },
  }
  // Capture the finalizer BEFORE argument materialization: the
  // `finalizeContent` contract snapshots the callback when the call starts,
  // and an arguments getter can replace or clear the registered callback
  // during `snapshotJsonValue`. The collapse only decides whether the
  // CAPTURED callback is retained: the pre-dispatch abort path keeps it
  // (the cancellation contract routes aborted results through it — a getter
  // that aborts mid-materialization before an invalid-args failure lands in
  // the same retained path), while the `UNKNOWN_TOOL` denial and the
  // invalid-args failure of a NON-ABORTED collapsed call drop it (the call
  // could never execute).
  const capturedFinalizer = visible?.finalizeContent?.bind(visible)
  const finalizerFor = (): ToolDefinition['finalizeContent'] | undefined =>
    collapsed && !signal.aborted ? undefined : capturedFinalizer
  try {
    const detached = snapshotJsonValue(exec.arguments)
    if (detached === undefined) {
      throw new TypeError('tool execution arguments must be losslessly JSON-serializable')
    }
    const execution: MutableToolRunContext = { ...base, arguments: deepFreeze(detached) }
    rt.deferredContexts.set(execution, deferredContexts)
    rt.contentFinalizers.set(execution, finalizerFor())
    rt.cancellationStates.set(execution, {
      callerSignal: signal,
      bodyInvoked: false,
    })
    if (collapsed) {
      // The collapse denies the call before the policy pipeline, but a
      // pre-dispatch abort still keeps the established cancellation
      // contract: `prepare`'s caller-cancellation check is skipped for
      // final-results, so honor the abort here instead of surfacing
      // `UNKNOWN_TOOL` on an already-cancelled call.
      if (signal.aborted) {
        return { kind: 'final-result', exec: execution, result: toolAbortedBeforeDispatchResult() }
      }
      // The name IS visible here, so the denial carries the route the model
      // must take instead. Without it the model reads a bare `unknown tool`
      // for a tool the prompt just declared and concludes the deployment is
      // broken rather than correcting itself.
      return {
        kind: 'final-result',
        exec: execution,
        result: toolErrorResult(new ToolNotFoundError(
          name,
          `only \`${RUN_CODE_NAME}\` is callable directly — call \`${name}\` from inside a \`${RUN_CODE_NAME}\` program instead`,
        )),
      }
    }
    return { kind: 'ready', exec: execution }
  } catch (error: unknown) {
    const execution: MutableToolRunContext = { ...base, arguments: undefined }
    rt.contentFinalizers.set(execution, finalizerFor())
    return { kind: 'final-result', exec: execution, result: toolErrorResult(error) }
  }
}

/**
 * Run the ordered pre-execute and monotonic guard stages for the scheduler.
 * @param rt - the owning runtime.
 * @param input - the caller-supplied execution input.
 * @returns the prepared execution plus the next scheduler stage.
 * @internal
 */
export async function prepareScheduledExecution(rt: ToolRuntimeCore, input: ToolExecutionInput): Promise<ScheduledToolPreparation> {
  return rt.prepareExecution(input, prepared => prepared)
}

export async function prepareExecution<T>(
  rt: ToolRuntimeCore,
  input: ToolExecutionInput,
  next: (prepared: ScheduledToolPreparation) => T | PromiseLike<T>,
): Promise<T> {
  const created = rt.createExecution(input)
  if (created.kind !== 'ready') return next(created)
  const exec = created.exec
  if (rt.callerCancelled(exec)) {
    return next({ kind: 'final-result', exec, result: toolAbortedBeforeDispatchResult() })
  }
  try {
    const carrier = scopeTarget(rt, exec.agent)
    const gate = await rt.ctx.waterfall(
      carrier, 'tools/pre-execute', exec,
      () => Promise.resolve<PreToolDecision>({ kind: 'allow' }),
    )
    const askResolution: ToolAskResolution = gate.kind === 'ask'
      ? await rt.serviceAsk(exec, gate)
      : { decision: gate, approvalCancelled: false }
    const { decision } = askResolution
    if (rt.callerCancelled(exec) && askResolution.approvalCancelled) {
      return await next({ kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() })
    }
    const denialReason = decision.kind === 'allow'
      ? rt.guardReason(exec)
      : decision.reason
    if (denialReason !== undefined) {
      return await next({
        kind: 'post-result',
        exec,
        result: rt.materializeFinalResult({
          content: [{ type: 'text', text: `Error: ${denialReason}` }],
          isError: true,
          error: { message: denialReason },
        }),
      })
    }
    if (rt.callerCancelled(exec)) {
      return await next({ kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() })
    }
    return await next({ kind: 'dispatch', exec })
  } catch (error: unknown) {
    return next({ kind: 'final-result', exec, result: toolErrorResult(error) })
  }
}

/** Whether the original caller signal is currently aborted. */
export function callerCancelled(rt: ToolRuntimeCore, exec: ToolRunContext): boolean {
  const state = rt.cancellationStates.get(exec)
  /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
  if (state === undefined) throw new Error('tool registry scheduler invariant violated: missing cancellation state')
  return state.callerSignal.aborted
}

/** Canonical cancellation outcome selected by whether the tool body started. */
export function cancellationResult(rt: ToolRuntimeCore, exec: ToolRunContext, prior?: ToolExecutionResult): ToolExecutionResult {
  const state = rt.cancellationStates.get(exec)
  /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
  if (state === undefined) throw new Error('tool registry scheduler invariant violated: missing cancellation state')
  return state.bodyInvoked
    ? toolAbortedResult(prior)
    : toolAbortedBeforeDispatchResult(prior)
}

/**
 * Dispatch the registered body with the original caller signal fused back
 * into any around-wrapper replacement. Cancellation never abandons the body:
 * a started promise reaches quiescence before its outcome becomes `ABORTED`.
 */
export async function dispatchToolBody(rt: ToolRuntimeCore, exec: MutableToolRunContext): Promise<ToolExecutionResult> {
  const state = rt.cancellationStates.get(exec)
  /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
  if (state === undefined) throw new Error('tool registry scheduler invariant violated: missing cancellation state')
  const wrapperSignal = exec.signal
  const fused = fuseToolSignals(state.callerSignal, wrapperSignal)
  const signal = fused.signal

  if (isAborted(signal)) {
    fused.dispose()
    return toolAbortedBeforeDispatchResult()
  }
  exec.signal = signal
  try {
    const tool = rt.resolveExecution(exec.name, exec.agent, exec.parent !== undefined)
    if (!tool) throw new ToolNotFoundError(exec.name)
    state.bodyInvoked = true
    const returned = await tool.execute(exec.arguments, exec)
    const result = rt.createSuccessResult(exec, tool, returned)
    return isAborted(signal)
      ? toolAbortedResult(result)
      : result
  } catch (error: unknown) {
    return toolErrorResult(error)
  } finally {
    fused.dispose()
    exec.signal = wrapperSignal
  }
}

/**
 * Run around-dispatch and the tool body. Tool and unknown-tool failures still
 * receive post-execute; pipeline failures are already final.
 * @param rt - the owning runtime.
 * @param exec - the prepared execution.
 * @returns whether the result still needs post-execute.
 * @internal
 */
export async function dispatchScheduledExecution(rt: ToolRuntimeCore, exec: ToolRunContext): Promise<ScheduledToolDispatch> {
  try {
    const mutableExec = exec as MutableToolRunContext
    const carrier = scopeTarget(rt, exec.agent)
    const result = await rt.ctx.waterfall(
      carrier, 'tools/execute', mutableExec,
      () => rt.dispatchToolBody(mutableExec),
    )
    const normalized = rt.normalizeDispatchResult(exec, result)
    const deferredContexts = rt.deferredContexts.get(exec)
    /* v8 ignore next -- dispatch only receives executions minted by this registry's prepare stage */
    if (deferredContexts === undefined) throw new Error('tool registry scheduler invariant violated: unprepared execution')
    const resultWithDeferredContexts: ToolExecutionResult = deferredContexts.length === 0
      ? normalized
      : rt.markCanonical(exec, {
        ...normalized,
        additionalContexts: [
          ...deferredContexts,
          ...normalized.additionalContexts ?? [],
        ],
      })
    return {
      kind: 'post-result',
      result: rt.callerCancelled(exec) && !resultWithDeferredContexts.isError
        ? rt.cancellationResult(exec, resultWithDeferredContexts)
        : resultWithDeferredContexts,
    }
  } catch (error: unknown) {
    return { kind: 'final-result', result: toolErrorResult(error) }
  }
}

/**
 * Run ordered post-execute, then apply definition-owned content finalization,
 * materialize, and notify the final outcome.
 * @param rt - the owning runtime.
 * @param exec - the prepared execution.
 * @param result - dispatch/pre result that still needs post-execute.
 * @returns the materialized final result.
 * @internal
 */
export async function finalizeScheduledExecution(rt: ToolRuntimeCore, exec: ToolRunContext, result: ToolExecutionResult): Promise<ToolExecutionResult> {
  try {
    const postResult = await rt.postExecute(exec, result)
    return rt.finishScheduledExecution(
      exec,
      rt.callerCancelled(exec) && !postResult.isError
        ? rt.cancellationResult(exec, postResult)
        : postResult,
    )
  } catch (error: unknown) {
    return rt.finishScheduledExecution(exec, toolErrorResult(error))
  }
}

/**
 * Materialize the candidate, apply definition-owned content finalization,
 * then materialize and notify the authoritative result.
 * @param rt - the owning runtime.
 * @param exec - the prepared execution.
 * @param result - final result.
 * @returns the materialized final result.
 * @internal
 */
export function finishScheduledExecution(rt: ToolRuntimeCore, exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult {
  let materializedResult: ToolExecutionResult
  try {
    materializedResult = rt.materializeFinalResult(result)
  } catch (error: unknown) {
    materializedResult = rt.materializeFinalResult(toolErrorResult(error))
  }
  let finalResult: ToolExecutionResult
  try {
    finalResult = rt.materializeFinalResult(rt.applyFinalContent(exec, materializedResult))
  } catch (error: unknown) {
    finalResult = rt.materializeFinalResult(toolErrorResult(error))
  }
  rt.notifyResult(exec, finalResult)
  return finalResult
}

/** Apply the snapshotted tool-owned content transform without exposing other result fields. */
export function applyFinalContent(rt: ToolRuntimeCore, exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult {
  const finalizeContent = rt.contentFinalizers.get(exec)
  if (finalizeContent === undefined) return result
  const content = finalizeContent(exec, result)
  return content === undefined ? result : { ...result, content }
}
