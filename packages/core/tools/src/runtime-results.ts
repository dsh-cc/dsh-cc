/**
 * ToolRuntime result collaborators: post-execute policy, canonical-result
 * marking, success/normalization projection, content finalization, and final
 * notification. Bodies are verbatim moves from the former `ToolRuntime`
 * methods with `this.` → `rt.`.
 * @module
 */

import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { errorMessage, failureMessageFromContent, projectionError, snapshotProjection, snapshotToolValue, ToolNotFoundError, ToolOutputError } from './abort-utils.ts'
import { validateJsonSchemaValue } from './json-schema.ts'
import { materializePresentation } from './tool-types.ts'
import type { PostToolDecision, ToolDefinition, ToolExecution, ToolExecutionResult, ToolExecutionSuccess } from './tool-types.ts'
import type { ToolRuntimeCore } from './runtime-core.ts'

/** Notify observers without exposing a mutation or error channel into the outcome. */
export function notifyResult(rt: ToolRuntimeCore, exec: ToolExecution, result: ToolExecutionResult): void {
  // Freeze the registry's live object before observers receive its readonly
  // WeakMap-keyable view.
  Object.freeze(exec)
  const { name: toolName, callId } = exec
  const reportFailure = (error: unknown): void => {
    rt.ctx.logger.warn(`tool "${toolName}" (${callId}): tools/result observer failed: ${errorMessage(error)}`)
  }
  const callbacks = rt.ctx.events.dispatch('emit', [
    scopeTarget(rt, exec.agent), 'tools/result', exec, result,
  ])
  for (const callback of callbacks) {
    try {
      const returned: unknown = callback(exec, result)
      void Promise.resolve(returned).catch(reportFailure)
    } catch (error: unknown) {
      reportFailure(error)
    }
  }
}

/**
 * Run the `tools/post-execute` waterfall over a dispatched `result` and apply
 * its `PostToolDecision`: `accept` keeps the call successful (replacing
 * `content` when given), `block` turns it into an `isError` whose content is
 * the corrective `feedback`. Either decision may attach `additionalContexts`,
 * which are ferried on the returned result for the loop's active-batch FIFO.
 * Context deferred by the tool body survives an accepted result but is
 * discarded when the outer call is blocked; a block exposes only context the
 * blocking decision explicitly supplied.
 * Runs inside `execute`'s outer try/catch (a throwing listener → isError).
 */
export async function postExecute(rt: ToolRuntimeCore, exec: ToolExecution, result: ToolExecutionResult): Promise<ToolExecutionResult> {
  const decision = await rt.ctx.waterfall(
    scopeTarget(rt, exec.agent), 'tools/post-execute', exec, result,
    () => Promise.resolve<PostToolDecision>({ kind: 'accept' }),
  )
  const decisionContexts = decision.additionalContexts ?? []
  if (decision.kind === 'block') {
    const message = failureMessageFromContent(decision.feedback)
    return rt.markCanonical(exec, {
      content: decision.feedback,
      isError: true,
      error: { message },
      ...decisionContexts.length > 0 ? { additionalContexts: decisionContexts } : {},
    })
  }
  if (Object.hasOwn(decision, 'content') && Object.hasOwn(decision, 'value')) {
    throw new TypeError('tools/post-execute accept decision cannot replace both value and content')
  }
  const additionalContexts = [
    ...result.additionalContexts ?? [],
    ...decisionContexts,
  ]
  if (Object.hasOwn(decision, 'value')) {
    if (result.isError) {
      throw new TypeError('tools/post-execute cannot replace the value of a failed result')
    }
    const tool = rt.resolveExecution(exec.name, exec.agent, exec.parent !== undefined)
    if (tool === undefined) throw new ToolNotFoundError(exec.name)
    const replaced = rt.createSuccessResult(exec, tool, decision.value)
    return rt.markCanonical(exec, {
      ...replaced,
      ...additionalContexts.length > 0 ? { additionalContexts } : {},
    })
  }
  return rt.markCanonical(exec, {
    ...result,
    ...decision.content !== undefined ? { content: decision.content } : {},
    ...additionalContexts.length > 0 ? { additionalContexts } : {},
  })
}

/** Mark one registry-normalized result as canonical only for its owning dispatch. */
export function markCanonical<T extends ToolExecutionResult>(rt: ToolRuntimeCore, exec: ToolExecution, result: T): T {
  rt.canonicalResults.set(result, exec.token)
  return result
}

/** Snapshot, validate, render, and optionally project one successful body value. */
export function createSuccessResult(rt: ToolRuntimeCore, exec: ToolExecution, tool: ToolDefinition, candidate: unknown): ToolExecutionSuccess {
  const detached = snapshotToolValue(tool.name, candidate)
  const violations = validateJsonSchemaValue(tool.output.schema, detached, 'value')
  if (violations.length > 0) throw new ToolOutputError(tool.name, violations)
  const value = deepFreeze(detached)
  let rendered: ContentBlock[]
  try {
    rendered = tool.output.render(exec.arguments, value)
  } catch (error: unknown) {
    throw projectionError(tool.name, 'render', error)
  }
  const content = snapshotProjection(tool.name, 'render', rendered)
  let meta: JsonValue | undefined
  if (exec.parent === undefined && tool.output.presentationMeta !== undefined) {
    let projected: JsonValue
    try {
      projected = tool.output.presentationMeta(exec.arguments, value)
    } catch (error: unknown) {
      throw projectionError(tool.name, 'presentationMeta', error)
    }
    meta = snapshotProjection(tool.name, 'presentationMeta', projected)
  }
  const concludesTurn = rt.concludingExecutions.has(exec)
  return rt.markCanonical(exec, rt.materializeFinalResult({
    isError: false,
    value,
    content,
    ...meta !== undefined ? { meta } : {},
    ...concludesTurn ? { concludesTurn: true as const } : {},
  }) as ToolExecutionSuccess)
}

/** Normalize an around-dispatch wrapper's authored result through the owning output contract. */
export function normalizeDispatchResult(rt: ToolRuntimeCore, exec: ToolExecution, result: ToolExecutionResult): ToolExecutionResult {
  if (rt.canonicalResults.get(result) === exec.token) return result
  if (result.isError) {
    return rt.markCanonical(exec, {
      isError: true,
      error: result.error,
      content: result.content,
      ...result.meta !== undefined ? { meta: result.meta } : {},
      ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
    })
  }
  const tool = rt.resolveExecution(exec.name, exec.agent, exec.parent !== undefined)
  if (tool === undefined) throw new ToolNotFoundError(exec.name)
  const normalized = rt.createSuccessResult(exec, tool, result.value)
  return rt.markCanonical(exec, {
    ...normalized,
    ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
  })
}

/** Materialize the authoritative commit outcome once, immediately before `tools/result`. */
export function materializeFinalResult(_rt: ToolRuntimeCore, result: ToolExecutionResult): ToolExecutionResult {
  const presentation = {
    content: result.content,
    ...result.meta !== undefined ? { meta: result.meta } : {},
    ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
  }
  if (result.isError) {
    return materializePresentation({ isError: true as const, error: result.error, ...presentation })
  }
  const detached = materializePresentation({
    isError: false as const,
    ...presentation,
    ...result.concludesTurn === true ? { concludesTurn: true as const } : {},
  })
  return deepFreeze({ ...detached, value: result.value })
}
