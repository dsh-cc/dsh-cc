/**
 * Tool registry, model presentation modes, and pre/guard/around/post/result
 * execution pipeline.
 * @module @dsh-cc/tools
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ScopedLayers } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, Scoped } from '@deepseek-ai/dsh-scope'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ToolProviderResult } from '@deepseek-ai/dsh-system-prompt'
import type { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import { TOOL_RUNTIME_SCHEDULER } from './scheduler.ts'
import { ToolLayer, resolveMaxParallelSubCalls } from './tool-layer.ts'
import type { ToolAskResolution, ToolCancellationState } from './tool-layer.ts'
import type { CodeDispatchLog, Config, MutableToolRunContext, PostToolDecision, PreToolDecision, ScheduledToolDispatch, ScheduledToolPreparation, ToolDefinition, ToolDispatchExecution, ToolExecution, ToolExecutionInput, ToolExecutionMode, ToolExecutionResult, ToolExecutionSuccess, ToolExecutionToken, ToolGuard, ToolPresentationMode, ToolRestriction, ToolRunContext, ToolRuntimeScheduler, ToolView } from './tool-types.ts'
import type { ToolSdkSchema } from './ts-types.ts'
import type { ToolRuntimeCore } from './runtime-core.ts'
import { executionMode, get, guard as registerGuard, guardReason, isAdmitted, register, reserve, resolveExecution, restrict, view } from './runtime-registry.ts'
import { collapses, collapseSection, modeFor, presentAs, schemaOf, schemas, sdkSchemas, sdkSection, wireSchemas } from './runtime-schemas.ts'
import { applyFinalContent, callerCancelled, cancellationResult, completeScheduledExecution, createExecution, dispatchScheduledExecution, dispatchToolBody, execute, finalizeScheduledExecution, finishScheduledExecution, prepareExecution, prepareScheduledExecution } from './runtime-execute.ts'
import { createSuccessResult, markCanonical, materializeFinalResult, normalizeDispatchResult, notifyResult, postExecute } from './runtime-results.ts'
import { requireCodeRuntime, requireCodeTransport, serviceAsk, shapeDispatchLog } from './runtime-code.ts'

export {
  defineTool,
  valueSchemaSpecToJsonSchema,
  parameterSchemaSpecToJsonSchema,
  validateArgs,
  ToolArgsError,
  type ValueSchemaAnnotations,
  type StringValueSchemaSpec,
  type NumberValueSchemaSpec,
  type IntegerValueSchemaSpec,
  type BooleanValueSchemaSpec,
  type NullValueSchemaSpec,
  type ArrayValueSchemaSpec,
  type ObjectValueSchemaSpec,
  type JsonValueSchemaSpec,
  type OneOfValueSchemaSpec,
  type ValueSchemaSpec,
  type ParameterPropertySpec,
  type ParameterSchemaSpec,
  type ParameterJsonSchema,
  type InferValue,
  type InferArgs,
  type DefineToolOptions,
} from './schema.ts'

export {
  assertSupportedJsonSchema,
  assertObjectJsonSchema,
  validateJsonSchemaValue,
  JsonSchemaError,
  type JsonSchemaNode,
  type ObjectJsonSchema,
  type JsonSchemaType,
  type JsonSchemaScalar,
} from './json-schema.ts'

export type { JsonValue } from '@deepseek-ai/dsh-session'
export type { CodeDispatchEventData, CodeDispatchStartEventData } from './types.ts'

export { CodeRunFailedError, RUN_CODE_NAME } from './code-mode.ts'
export {
  CC_TO_HARNESS_TOOLS,
  KNOWN_HARNESS_TOOLS,
  translateToolNames,
  ccToolAliases,
  ccCanonicalToolName,
  type ToolNameTranslationPolicy,
} from './cc-names.ts'
export { jsonSchemaToTs, renderToolsSdk } from './ts-types.ts'
export { jsonSchemaToPy, renderToolsSdkPy } from './py-types.ts'
export { defineContentToolFixture, type ContentToolFixtureOptions } from './testing.ts'

// The render-intent vocabulary a tool declares via `presentCall`/`presentResult`
// lives in its own UI-facing module; re-export it so `@dsh-cc/tools`
// stays the single public API for tool producers and UI adapters.
export type {
  ToolCallKind,
  FileLocation,
  FileDiff,
  ReadFileLine,
  ToolCallView,
  GenericCallView,
  TerminalCallView,
  DiffCallView,
  ToolResultView,
  GenericResultView,
  TerminalResultView,
  DiffResultView,
  SearchResultView,
  SearchMatchesResultView,
  SearchPathsResultView,
  SearchFileMatches,
  SearchLineMatch,
  ReadResultView,
  WebResultView,
  WebSearchResultView,
  WebFetchResultView,
  WebSource,
} from './presentation.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolRuntime
  }

  interface Events {
    /**
     * Allow, deny, or ask before dispatch. `next()` delegates to allow; missing
     * approval support turns `ask` into denial. Async gates must observe
     * `exec.signal`; the registry rechecks cancellation after they settle but
     * never abandons their promise.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.
     * @param exec - the pending call (name, parsed arguments, caller agent).
     * @mode waterfall
     */
    'tools/pre-execute'(this: Scoped<ToolRuntime | ToolRuntimeCore>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
    /**
     * Around-dispatch waterfall for timeout, retry, or metrics. `next()` returns
     * a normalized result; wrappers may change only `exec.signal`, while call
     * identity remains immutable. The registry re-fuses the original caller
     * signal before the body, so replacement cannot detach caller cancellation;
     * wrappers must still restore their signal and reach quiescence.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.
     * @param exec - the allowed call about to dispatch (name, parsed arguments, caller agent, signal).
     * @mode waterfall
     */
    'tools/execute'(this: Scoped<ToolRuntime | ToolRuntimeCore>, exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
    /**
     * Accept, replace, enrich, or block a normalized dispatch result. `next()`
     * accepts it unchanged; thrown tools still reach this waterfall as errors. Async
     * listeners must observe `exec.signal`; after they settle, caller
     * cancellation replaces only a successful accepted outcome with the code
     * selected by whether the tool body was invoked.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.
     * @param exec - the call that just ran (name, parsed arguments, caller agent).
     * @param result - the dispatch outcome a listener may accept, replace, or block.
     * @mode waterfall
     */
    'tools/post-execute'(this: Scoped<ToolRuntime | ToolRuntimeCore>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
    /**
     * Allow a listener to replace content in the DURABLE LOG COPY of one
     * `run_code` sub-dispatch outcome before the bridge appends its
     * `tool/code-dispatch` event. `next()` keeps the
     * content unchanged; a listener may return replacement blocks (e.g. the
     * spill policy's preview + locator for an oversized text result). Only the
     * logged copy is affected — the program already received the complete
     * value, and the model sees neither. A throwing listener is contained:
     * the bridge falls back to logging the original settled content.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's dispatches.
     * @param dispatch - the parent execution, sub-call identity, and the settled content to log.
     * @mode waterfall
     */
    'tools/code-dispatch-log'(this: Scoped<ToolRuntime | ToolRuntimeCore>, dispatch: CodeDispatchLog, next: () => Promise<ContentBlock[]>): Promise<ContentBlock[]>
    /**
     * Observe the frozen, lossless-JSON final outcome. Listener failures are contained.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): keyed by `exec.agent`.
     * @param exec - the execution object that traversed the pipeline.
     * @param result - a deep-frozen snapshot of the final returned result.
     * @mode emit
     */
    'tools/result'(this: Scoped<ToolRuntime | ToolRuntimeCore>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined
    /**
     * A tool was registered or unregistered, or a scoped restriction changed
     * (the available tool set changed — possibly for one scope only). An
     * UNFILTERED registry-subject notification, deliberately not scope-filtered
     * dispatch: a global change concerns every agent's next assembly, so a
     * scoped listener subscribing here sees every change, not just its own
     * scope's.
     * @mode emit
     */
    'tools/change'(): void
  }
}

export type {
  CodeDispatchLog,
  Config,
  PostToolDecision,
  PreToolDecision,
  ScheduledToolDispatch,
  ScheduledToolPreparation,
  ToolDefinition,
  ToolDispatchExecution,
  ToolExecution,
  ToolExecutionFailure,
  ToolExecutionInput,
  ToolExecutionMode,
  ToolExecutionResult,
  ToolExecutionSuccess,
  ToolExecutionToken,
  ToolGuard,
  ToolOutputDefinition,
  ToolPresentationMode,
  ToolRestriction,
  ToolResult,
  ToolRunContext,
  ToolRuntimeScheduler,
} from './tool-types.ts'
export type { ToolErrorInfo, ToolFailure } from './abort-utils.ts'
export { TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH, ToolNotFoundError, ToolOutputError } from './abort-utils.ts'
/**
 * Scheduler entry point omitted from the generated named service API.
 * The value MUST be the upstream symbol instance: the in-box agent loop reads
 * the staged scheduler off the registry through the symbol exported by
 * `@deepseek-ai/dsh-tools`, and a `Symbol()` is identity-unique — minting a
 * private one here leaves the loop reading `undefined` and crashing every
 * turn's first tool call (`undefined.prepare`). The binding is a type-erased
 * `createRequire` rather than a static import so upstream's declaration graph
 * (its own `Context` augmentation, whose vendored copy this package also
 * ships) never enters downstream type programs; the dependency stays
 * runtime-only (peer-declared). Declared in the {@link ./scheduler.ts} leaf
 * module; re-exported here to keep the public barrel surface unchanged.
 * @internal
 */
export { TOOL_RUNTIME_SCHEDULER }

/**
 * Tool registry and execution pipeline. Scoped registrations shadow globals;
 * one visibility resolver feeds presentation, lookup, and dispatch.
 *
 * The implementation lives in the `runtime-*.ts` collaborator modules behind
 * the `ToolRuntimeCore` structural interface; this class is the constructed
 * facade — configuration, state fields, scheduler staging, and one-line
 * delegations.
 */
export class ToolRuntime extends Service {
  /** Cordis context; `Service` keeps it protected — declaration-only re-exposure for the `ToolRuntimeCore` interface. @internal */
  declare readonly ctx: Context

  static inject = ['systemPrompt']

  static Config: z<Config> = z.object({
    mode: z.union(['native', 'code', 'both'] as const).default('native'),
    maxParallelSubCalls: z.natural().min(1).default(10),
  })

  /** Internal staged view consumed by `dsh-agent-loop`'s parallel scheduler. */
  readonly [TOOL_RUNTIME_SCHEDULER]: ToolRuntimeScheduler = {
    prepare: exec => this.prepareScheduledExecution(exec),
    dispatch: exec => this.dispatchScheduledExecution(exec),
    finalize: (exec, result) => this.finalizeScheduledExecution(exec, result),
    finish: (exec, result) => this.finishScheduledExecution(exec, result),
  }

  /** @internal Context deferred by a running tool body, keyed by its scheduler-owned execution. */
  readonly deferredContexts = new WeakMap<ToolRunContext, UserMessage[]>()
  /** @internal Executions whose tool body declared the current turn complete. */
  readonly concludingExecutions = new WeakSet<ToolExecution>()
  /** @internal Original caller cancellation, kept outside the wrapper-mutable execution object. */
  readonly cancellationStates = new WeakMap<ToolRunContext, ToolCancellationState>()
  /** @internal Definition-owned final content transform snapshotted before policy begins. */
  readonly contentFinalizers = new WeakMap<ToolRunContext, ToolDefinition['finalizeContent']>()
  /** @internal Visibility layers: registration, reservation, restriction, guards. */
  readonly layers = new ScopedLayers(
    scope => new ToolLayer(scope),
    () => { this.ctx.emit('tools/change') },
  )
  /** @internal Presentation for scopes that declare none; {@link modeFor} shadows it per scope. */
  readonly defaultMode: ToolPresentationMode
  /** @internal */
  readonly maxParallelSubCalls: number
  /**
   * Reserved presentation transport, kept outside the filterable registration
   * layers. Built on first need rather than at construction: which agents run
   * a code mode is no longer known when the service is constructed, and the
   * transport is stateless beyond its closures over the runtime.
   * @internal
   */
  codeTransport: ToolDefinition | undefined
  /** @internal Registry-normalized results and the exact dispatch that validated each value. */
  readonly canonicalResults = new WeakMap<object, ToolExecutionToken>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'tools')
    // The schema already defaulted an omitted mode; the ?? narrows the
    // optional-input type for direct (non-Loader) construction in tests.
    this.defaultMode = config.mode ?? 'native'
    this.maxParallelSubCalls = resolveMaxParallelSubCalls(config.maxParallelSubCalls)
    ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))
    if (this.defaultMode !== 'native') {
      ctx.systemPrompt.section(this.collapseSection())
      ctx.systemPrompt.section(this.sdkSection())
    }
  }

  /**
   * Present the calling scope's tools in `mode` instead of the deployment
   * default. Nearest scope on the chain wins, so a preset's standing
   * declaration covers every agent joined under it.
   *
   * Scoped only, and one declaration per scope: this is how an agent preset
   * composes Code Mode agents beside native ones in the same process, and a
   * process-global override would be the `mode` config field instead.
   * @param mode - the presentation the covered agents' models see.
   * @returns the exact disposer that restores the deployment default.
   */
  presentAs(mode: ToolPresentationMode): () => void {
    return presentAs(this, mode)
  }

  /**
   * Register globally or in the calling agent scope. Scoped tools shadow
   * globals; duplicates within one layer and the reserved `run_code` name fail.
   * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
   * @returns the exact disposer that unregisters the tool.
   */
  register(definition: ToolDefinition): () => void {
    return register(this, definition)
  }

  /**
   * Reserve a capability NAME in the calling layer without registering a
   * visible definition. A reserved name joins the known/restrictable universe
   * — a scope may later `restrict()` it away, and `toolOrder` may list it — but
   * it never reaches the model-facing schema until a real `register()` supplies
   * the definition. This is how a deferred-tool registry seeds the names a
   * composition may gate before their heavy definitions load.
   *
   * The name stays out of {@link ToolRuntime.get} and {@link ToolRuntime.schemas}
   * (only registered definitions are visible). Duplicate reservations within one
   * layer fail, matching the duplicate-name rule for {@link ToolRuntime.register}.
   * @param name - the capability name to make known without presenting.
   * @returns the exact disposer that clears the reservation.
   */
  reserve(name: string): () => void {
    return reserve(this, name)
  }

  /**
   * Whether a global tool name passes every scoped restriction on the viewing
   * scope's chain. The answer ignores registration: a reserved or not-yet-loaded
   * name is admitted if no `allow`/`deny` on the chain masks it, so a caller can
   * gate whether a deferred capability may load for one agent. A name masked by
   * an `allow` list it is absent from, or present in a `deny` list, is not
   * admitted. When a name has multiple restrictions, they intersect (all must
   * admit it), matching registration visibility.
   * @param name - the capability name to test.
   * @param scope - the viewing scope (the agent); omitted for the global view, which has no restrictions.
   * @returns whether the name may load for that scope.
   */
  isAdmitted(name: string, scope?: ScopeKey): boolean {
    return isAdmitted(this, name, scope)
  }

  /**
   * Restrict global tools for the calling agent scope. Empty filters, unknown
   * names, scope-local names, and reserved transport names fail. Restrictions
   * intersect; scoped registrations remain visible.
   * @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
   * @returns the exact disposer that lifts this restriction.
   */
  restrict(filter: ToolRestriction): () => void {
    return restrict(this, filter)
  }

  /**
   * Register a monotonic guard after the extensible `tools/pre-execute`
   * waterfall. A plain-context guard applies globally; one registered through
   * `agent.ctx` applies only to that agent. Any matching guard may deny by
   * returning a reason, while no guard can force-allow a call another guard
   * denied. The exact effect disposer is returned for ordered ownership and
   * HMR cleanup.
   * @param guard - synchronous check; a returned string denies the execution.
   * @returns the exact disposer that unregisters the guard.
   */
  guard(guard: ToolGuard): () => void {
    return registerGuard(this, guard)
  }

  /**
   * Look up a tool as one scope sees it (scoped
   * shadows global; a restricted-away global reads as absent). Presenters pass
   * the calling agent so the rendered card matches the definition that
   * actually executed.
   * @param name - the tool name as registered.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @returns the definition the scope resolves, or undefined when none is visible.
   */
  get(name: string, scope?: ScopeKey): ToolDefinition | undefined {
    return get(this, name, scope)
  }

  /**
   * Project visible definitions onto the allowlisted model-facing schema fields,
   * excluding execution and presentation callbacks.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @returns one deep-cloned schema per visible tool.
   */
  schemas(scope?: ScopeKey): ToolSchema[] {
    return schemas(this, scope)
  }

  /**
   * Classify a pending call through the caller's visible tool definition. Only
   * an exact `true` is parallel; unknown, hidden, undeclared, invalid, or
   * throwing classifiers are exclusive.
   * @param exec - call name, parsed arguments, and optional agent scope.
   * @returns the fail-closed scheduling mode.
   */
  executionMode(exec: ToolExecutionInput): ToolExecutionMode {
    return executionMode(this, exec)
  }

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
   * @param exec - the typed same-process call input. The registry assigns its
   *   correlation token before policy begins.
   * @returns the materialized final result.
   */
  async execute(exec: ToolExecutionInput): Promise<ToolExecutionResult> {
    return execute(this, exec)
  }

  /** @internal */
  guardReason(exec: ToolExecution): string | undefined { return guardReason(this, exec) }
  /** @internal */
  view(scope?: ScopeKey): ToolView { return view(this, scope) }
  /** @internal */
  resolveExecution(name: string, scope: ScopeKey | undefined, nested: boolean): ToolDefinition | undefined { return resolveExecution(this, name, scope, nested) }
  /** @internal */
  collapseSection(): { name: string; order: number; text: (context: { scope?: ScopeKey }) => string } { return collapseSection(this) }
  /** @internal */
  sdkSection(): { name: string; order: number; text: (context: { scope?: ScopeKey }) => string } { return sdkSection(this) }
  /** @internal */
  modeFor(scope?: ScopeKey): ToolPresentationMode { return modeFor(this, scope) }
  /** @internal */
  wireSchemas(scope?: ScopeKey): ToolProviderResult { return wireSchemas(this, scope) }
  /** @internal */
  sdkSchemas(scope?: ScopeKey): ToolSdkSchema[] { return sdkSchemas(this, scope) }
  /** @internal */
  schemaOf(definition: ToolDefinition, detachParameters: boolean): ToolSchema { return schemaOf(this, definition, detachParameters) }
  /** @internal */
  collapses(name: string, scope: ScopeKey | undefined, nested: boolean): boolean { return collapses(this, name, scope, nested) }
  /** @internal */
  completeScheduledExecution(prepared: ScheduledToolPreparation): Promise<ToolExecutionResult> { return completeScheduledExecution(this, prepared) }
  /** @internal */
  createExecution(exec: ToolExecutionInput): ScheduledToolPreparation | { kind: 'ready'; exec: MutableToolRunContext } { return createExecution(this, exec) }
  /** @internal */
  prepareScheduledExecution(input: ToolExecutionInput): Promise<ScheduledToolPreparation> { return prepareScheduledExecution(this, input) }
  /** @internal */
  prepareExecution<T>(input: ToolExecutionInput, next: (prepared: ScheduledToolPreparation) => T | PromiseLike<T>): Promise<T> {
    return prepareExecution(this, input, next)
  }

  /** @internal */
  callerCancelled(exec: ToolRunContext): boolean { return callerCancelled(this, exec) }
  /** @internal */
  cancellationResult(exec: ToolRunContext, prior?: ToolExecutionResult): ToolExecutionResult { return cancellationResult(this, exec, prior) }
  /** @internal */
  dispatchToolBody(exec: MutableToolRunContext): Promise<ToolExecutionResult> { return dispatchToolBody(this, exec) }
  /** @internal */
  dispatchScheduledExecution(exec: ToolRunContext): Promise<ScheduledToolDispatch> { return dispatchScheduledExecution(this, exec) }
  /** @internal */
  finalizeScheduledExecution(exec: ToolRunContext, result: ToolExecutionResult): Promise<ToolExecutionResult> { return finalizeScheduledExecution(this, exec, result) }
  /** @internal */
  finishScheduledExecution(exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult { return finishScheduledExecution(this, exec, result) }
  /** @internal */
  applyFinalContent(exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult { return applyFinalContent(this, exec, result) }
  /** @internal */
  notifyResult(exec: ToolExecution, result: ToolExecutionResult): void { return notifyResult(this, exec, result) }
  /** @internal */
  postExecute(exec: ToolExecution, result: ToolExecutionResult): Promise<ToolExecutionResult> { return postExecute(this, exec, result) }
  /** @internal */
  markCanonical<T extends ToolExecutionResult>(exec: ToolExecution, result: T): T { return markCanonical(this, exec, result) }
  /** @internal */
  createSuccessResult(exec: ToolExecution, tool: ToolDefinition, candidate: unknown): ToolExecutionSuccess { return createSuccessResult(this, exec, tool, candidate) }
  /** @internal */
  normalizeDispatchResult(exec: ToolExecution, result: ToolExecutionResult): ToolExecutionResult { return normalizeDispatchResult(this, exec, result) }
  /** @internal */
  materializeFinalResult(result: ToolExecutionResult): ToolExecutionResult { return materializeFinalResult(this, result) }
  /** @internal */
  requireCodeTransport(): ToolDefinition { return requireCodeTransport(this) }
  /** @internal */
  requireCodeRuntime(mode: ToolPresentationMode): CodeRuntime { return requireCodeRuntime(this, mode) }
  /** @internal */
  shapeDispatchLog(dispatch: CodeDispatchLog): Promise<ContentBlock[]> { return shapeDispatchLog(this, dispatch) }
  /** @internal */
  serviceAsk(exec: ToolExecution, ask: Extract<PreToolDecision, { kind: 'ask' }>): Promise<ToolAskResolution> { return serviceAsk(this, exec, ask) }
}

export default ToolRuntime
