/**
 * Structural core shared by the ToolRuntime facade and its free-function
 * collaborator modules: the runtime's state fields plus every method
 * signature the collaborators call through their `rt` parameter. The facade
 * instance satisfies this interface structurally; collaborators stay acyclic
 * at import time — this module imports NO value from `index.ts` (the only
 * value edges here are the leaf SDK renderer table below).
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ScopeKey, ScopedLayers } from '@deepseek-ai/dsh-scope'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ToolProviderResult } from '@deepseek-ai/dsh-system-prompt'
import type { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import { renderToolsSdk } from './ts-types.ts'
import type { ToolSdkSchema } from './ts-types.ts'
import { renderToolsSdkPy } from './py-types.ts'
import type { CodeSdkLanguage } from './code-mode.ts'
import { TOOL_RUNTIME_SCHEDULER } from './scheduler.ts'
import type { ToolLayer } from './tool-layer.ts'
import type { ToolAskResolution, ToolCancellationState } from './tool-layer.ts'
import type { CodeDispatchLog, MutableToolRunContext, PreToolDecision, ScheduledToolDispatch, ScheduledToolPreparation, ToolDefinition, ToolExecution, ToolExecutionInput, ToolExecutionMode, ToolExecutionResult, ToolExecutionSuccess, ToolExecutionToken, ToolGuard, ToolPresentationMode, ToolRestriction, ToolRunContext, ToolRuntimeScheduler, ToolView } from './tool-types.ts'

/**
 * Language → SDK-section renderer. The registry looks up the loaded
 * `ctx.ptcRuntime.language` in this table when assembling the `tools:sdk`
 * section under a non-native mode; a runtime whose language is not a key
 * fails the assembly loudly (same idiom as `toolOrder` violations). Adding a
 * new backend language is three parallel edits — a {@link CodeSdkLanguage}
 * member, an entry here, and a `RUN_CODE_FLAVORS` entry in `code-mode.ts` for
 * its `run_code` schema strings — plus the renderer function this table points
 * at. The `satisfies` clause pins this table's key set to that union, which
 * the flavor table is checked against too, so any of the three left out is a
 * typecheck failure. What no check reaches is the prose that names the values
 * instead of deriving them: the seam's `dsh-ptc-runtime` README pair, its
 * `PtcRuntime.language` JSDoc, and `docs/subsystems/code-runtime.md`
 * with its zh pair, plus this package's own README pair and the
 * {@link Config.mode} JSDoc.
 */
export const SDK_RENDERERS: Record<string, (schemas: ToolSdkSchema[]) => string> = {
  typescript: renderToolsSdk,
  python: renderToolsSdkPy,
} satisfies Record<CodeSdkLanguage, (schemas: ToolSdkSchema[]) => string>

/**
 * The ToolRuntime state and pipeline surface, as consumed by the
 * `runtime-*.ts` free-function collaborators. Every member is public on the
 * facade class (former `private` members carry an `@internal` tag); the class
 * remains the only constructed form.
 */
export interface ToolRuntimeCore {
  /** Cordis context, inherited by the facade from `Service`. */
  readonly ctx: Context
  /** Visibility layers: registration, reservation, restriction, guards. */
  readonly layers: ScopedLayers<ToolLayer>
  /** Presentation for scopes that declare none; `modeFor` shadows it per scope. */
  readonly defaultMode: ToolPresentationMode
  readonly maxParallelSubCalls: number
  /**
   * Reserved presentation transport, kept outside the filterable registration
   * layers. Built on first need rather than at construction: which agents run
   * a code mode is no longer known when the service is constructed, and the
   * transport is stateless beyond its closures over the runtime.
   */
  codeTransport: ToolDefinition | undefined
  /** Context deferred by a running tool body, keyed by its scheduler-owned execution. */
  readonly deferredContexts: WeakMap<ToolRunContext, UserMessage[]>
  /** Executions whose tool body declared the current turn complete. */
  readonly concludingExecutions: WeakSet<ToolExecution>
  /** Original caller cancellation, kept outside the wrapper-mutable execution object. */
  readonly cancellationStates: WeakMap<ToolRunContext, ToolCancellationState>
  /** Definition-owned final content transform snapshotted before policy begins. */
  readonly contentFinalizers: WeakMap<ToolRunContext, ToolDefinition['finalizeContent']>
  /** Registry-normalized results and the exact dispatch that validated each value. */
  readonly canonicalResults: WeakMap<object, ToolExecutionToken>
  /** Internal staged view consumed by `dsh-agent-loop`'s parallel scheduler. */
  readonly [TOOL_RUNTIME_SCHEDULER]: ToolRuntimeScheduler

  // — registry —
  register(definition: ToolDefinition): () => void
  reserve(name: string): () => void
  isAdmitted(name: string, scope?: ScopeKey): boolean
  restrict(filter: ToolRestriction): () => void
  guard(guard: ToolGuard): () => void
  guardReason(exec: ToolExecution): string | undefined
  view(scope?: ScopeKey): ToolView
  get(name: string, scope?: ScopeKey): ToolDefinition | undefined
  resolveExecution(name: string, scope: ScopeKey | undefined, nested: boolean): ToolDefinition | undefined
  executionMode(exec: ToolExecutionInput): ToolExecutionMode

  // — schemas / presentation —
  collapseSection(): { name: string; order: number; text: (context: { scope?: ScopeKey }) => string }
  sdkSection(): { name: string; order: number; text: (context: { scope?: ScopeKey }) => string }
  modeFor(scope?: ScopeKey): ToolPresentationMode
  presentAs(mode: ToolPresentationMode): () => void
  wireSchemas(scope?: ScopeKey): ToolProviderResult
  schemas(scope?: ScopeKey): ToolSchema[]
  sdkSchemas(scope?: ScopeKey): ToolSdkSchema[]
  schemaOf(definition: ToolDefinition, detachParameters: boolean): ToolSchema
  collapses(name: string, scope: ScopeKey | undefined, nested: boolean): boolean

  // — execution pipeline —
  execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>
  completeScheduledExecution(prepared: ScheduledToolPreparation): Promise<ToolExecutionResult>
  createExecution(exec: ToolExecutionInput): ScheduledToolPreparation | { kind: 'ready'; exec: MutableToolRunContext }
  prepareScheduledExecution(input: ToolExecutionInput): Promise<ScheduledToolPreparation>
  prepareExecution<T>(input: ToolExecutionInput, next: (prepared: ScheduledToolPreparation) => T | PromiseLike<T>): Promise<T>
  callerCancelled(exec: ToolRunContext): boolean
  cancellationResult(exec: ToolRunContext, prior?: ToolExecutionResult): ToolExecutionResult
  dispatchToolBody(exec: MutableToolRunContext): Promise<ToolExecutionResult>
  dispatchScheduledExecution(exec: ToolRunContext): Promise<ScheduledToolDispatch>
  finalizeScheduledExecution(exec: ToolRunContext, result: ToolExecutionResult): Promise<ToolExecutionResult>
  finishScheduledExecution(exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult
  applyFinalContent(exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult

  // — results —
  notifyResult(exec: ToolExecution, result: ToolExecutionResult): void
  postExecute(exec: ToolExecution, result: ToolExecutionResult): Promise<ToolExecutionResult>
  markCanonical<T extends ToolExecutionResult>(exec: ToolExecution, result: T): T
  createSuccessResult(exec: ToolExecution, tool: ToolDefinition, candidate: unknown): ToolExecutionSuccess
  normalizeDispatchResult(exec: ToolExecution, result: ToolExecutionResult): ToolExecutionResult
  materializeFinalResult(result: ToolExecutionResult): ToolExecutionResult

  // — code mode —
  requireCodeTransport(): ToolDefinition
  requirePtcRuntime(mode: ToolPresentationMode): PtcRuntime
  shapeDispatchLog(dispatch: CodeDispatchLog): Promise<ContentBlock[]>
  serviceAsk(exec: ToolExecution, ask: Extract<PreToolDecision, { kind: 'ask' }>): Promise<ToolAskResolution>
}
