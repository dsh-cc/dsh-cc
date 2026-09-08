/**
 * ToolRuntime Code Mode collaborators: the reserved `run_code` transport
 * factory wiring, the code-runtime resolver, the code-dispatch log waterfall,
 * and the approval-seam `ask` resolution. Bodies are verbatim moves from the
 * former `ToolRuntime` methods with `this.` → `rt.`.
 * @module
 */

import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
// Type-only: makes `ctx.get('approval')` resolve to the ApprovalService
// augmentation. The seam stays optional at runtime — see `serviceAsk`.
import type {} from '@deepseek-ai/dsh-user-approval'
import { createRunCodeTool } from './code-mode.ts'
import { errorMessage } from './abort-utils.ts'
import type { CodeDispatchLog, PreToolDecision, ToolDefinition, ToolExecution, ToolPresentationMode } from './tool-types.ts'
import type { ToolAskResolution } from './tool-layer.ts'
import { SDK_RENDERERS } from './runtime-core.ts'
import type { ToolRuntimeCore } from './runtime-core.ts'

/**
 * The reserved `run_code` transport, built on first need.
 *
 * It never enters the global layer: per-agent restrictions must not remove
 * it, and a scoped registration must not shadow it. The visibility resolver
 * appends it after resolving the filterable global/scoped capability layers,
 * and only for scopes whose mode actually presents it.
 * @param rt - the owning runtime.
 * @returns the shared transport definition.
 */
export function requireCodeTransport(rt: ToolRuntimeCore): ToolDefinition {
  rt.codeTransport ??= createRunCodeTool(rt, {
    requireRuntime: () => rt.requireCodeRuntime(rt.defaultMode),
    // The language-aware description/parameters getters read the runtime
    // without demanding one, so a native-default process can still project
    // the transport for an agent that chose code.
    peekRuntime: () => rt.ctx.get('codeRuntime'),
    maxParallel: rt.maxParallelSubCalls,
    shapeDispatchLog: dispatch => rt.shapeDispatchLog(dispatch),
  })
  return rt.codeTransport
}

/**
 * Resolve the code runtime or throw the actionable misconfiguration error.
 * Read at use time (assembly / run_code execution), NOT via static
 * `inject`: an inject entry would hold `ctx.tools` — and every tool plugin
 * behind it — hostage to a code runtime existing even under `mode:
 * 'native'` (the loop's optional-backend idiom, same as
 * `sessionPersistence`).
 *
 * Assembly and `run_code` execution read separately, so the language is not
 * bound to a request. Harmless while one published backend exists — both
 * reads return the same flavor — but a reload that swapped in a second
 * language between them would hand a program written against one SDK to the
 * other. Binding it is deferred until a second backend ships (the first
 * point it is testable); rationale in the
 * [language-dispatch note](../../../../.agents/notes/implemented/feature/2026-07-31-code-mode-language-dispatch.md).
 */
export function requireCodeRuntime(rt: ToolRuntimeCore, mode: ToolPresentationMode): CodeRuntime {
  const runtime = rt.ctx.get('codeRuntime')
  if (!runtime) {
    throw new Error(`dsh-tools: mode "${mode}" requires a code runtime — load a ctx.codeRuntime implementation (e.g. @deepseek-ai/dsh-code-runtime-worker-thread) or set tools mode to "native"`)
  }
  if (!Object.hasOwn(SDK_RENDERERS, runtime.language)) {
    const known = Object.keys(SDK_RENDERERS).map(name => JSON.stringify(name)).join(', ')
    throw new Error(`dsh-tools: no SDK renderer registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`)
  }
  return runtime
}

/**
 * Run the `tools/code-dispatch-log` waterfall over one settled sub-dispatch
 * and return the content the bridge should log on `tool/code-dispatch`.
 * Contained: when a listener throws, the method logs the original settled
 * content; that failure must not fail the dispatch or omit the settle event. Private:
 * the ONE consumer is the `run_code` bridge this registry constructs, which
 * receives it as a capability parameter (the `requireRuntime` idiom) — the
 * waterfall, not this invoker, is the public extension point.
 */
export async function shapeDispatchLog(rt: ToolRuntimeCore, dispatch: CodeDispatchLog): Promise<ContentBlock[]> {
  try {
    return await rt.ctx.waterfall(
      scopeTarget(rt, dispatch.agent), 'tools/code-dispatch-log', dispatch,
      () => Promise.resolve(dispatch.content),
    )
  } catch (error: unknown) {
    rt.ctx.logger.warn(`tools: code-dispatch-log listener failed for ${dispatch.name}: ${errorMessage(error)}; logging the original settled content`)
    return dispatch.content
  }
}

/**
 * Resolve an `ask` decision to allow/deny through the approval seam. The
 * seam is consumed opportunistically with `ctx.get('approval')` — a
 * deployment that composes no ApprovalService keeps the historical degrade
 * to deny, and an unmount mid-session degrades the same way on the next ask.
 * An agent-less execution also degrades: without an agent there is no
 * session to audit to and no UI to route to. Otherwise the outcome maps
 * one-to-one — `allowed-once` proceeds; the three non-grants deny with
 * distinct reasons so the model can tell a human "no" from an absent
 * approval channel.
 */
export async function serviceAsk(
  rt: ToolRuntimeCore,
  exec: ToolExecution,
  ask: Extract<PreToolDecision, { kind: 'ask' }>,
): Promise<ToolAskResolution> {
  const approval = rt.ctx.get('approval')
  if (approval === undefined) {
    return {
      decision: { kind: 'deny', reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)` },
      approvalCancelled: false,
    }
  }
  if (exec.agent === undefined) {
    return {
      decision: { kind: 'deny', reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through` },
      approvalCancelled: false,
    }
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: exec.name,
    callId: exec.callId,
    ...ask.reason !== undefined ? { reason: ask.reason } : {},
    signal: exec.signal,
  })
  switch (outcome) {
    case 'allowed-once': return { decision: { kind: 'allow' }, approvalCancelled: false }
    case 'rejected': return {
      decision: { kind: 'deny', reason: `the user rejected tool "${exec.name}"` },
      approvalCancelled: false,
    }
    case 'cancelled': return {
      decision: { kind: 'deny', reason: `approval for tool "${exec.name}" was cancelled` },
      approvalCancelled: true,
    }
    case 'unavailable': return {
      decision: { kind: 'deny', reason: `tool "${exec.name}" requires approval, but no approval channel is available` },
      approvalCancelled: false,
    }
    default: return assertNever(outcome, 'ApprovalOutcome')
  }
}
