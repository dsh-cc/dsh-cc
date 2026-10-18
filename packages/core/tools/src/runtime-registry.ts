/**
 * ToolRuntime registry collaborators: registration, reservation, admission,
 * restriction, guards, and per-scope view resolution. Every function takes
 * the owning runtime as its `rt: ToolRuntimeCore` first parameter; bodies are
 * verbatim moves from the former `ToolRuntime` methods with `this.` → `rt.`.
 * @module
 */

import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { assertSupportedJsonSchema } from './json-schema.ts'
import { RUN_CODE_NAME } from './code-mode.ts'
import type { CompiledToolRestriction, ToolDefinition, ToolExecution, ToolExecutionInput, ToolExecutionMode, ToolGuard, ToolRestriction, ToolView } from './tool-types.ts'
import type { ToolRuntimeCore } from './runtime-core.ts'

/**
 * Register globally or in the calling agent scope. Scoped tools shadow
 * globals; duplicates within one layer and the reserved `run_code` name fail.
 * @param rt - the owning runtime.
 * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
 * @returns the exact disposer that unregisters the tool.
 */
export function register(rt: ToolRuntimeCore, definition: ToolDefinition): () => void {
  const name = definition.name
  const output = (definition as Partial<ToolDefinition>).output
  if (output === undefined || typeof output !== 'object'
    || typeof output.render !== 'function'
    || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')) {
    throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)
  }
  assertSupportedJsonSchema(output.schema)
  // Warn-only tripwire: a flat parameter spec (the repo DSL) or an external
  // schema outside the enforced subset would otherwise degrade silently to a
  // model-facing {}. Undefined/null is skipped — external MCP tools may omit
  // inputSchema, and asserting on undefined would throw a noise TypeError.
  if (definition.parameters !== undefined && definition.parameters !== null) {
    try {
      assertSupportedJsonSchema(definition.parameters)
    } catch (error) {
      rt.ctx.logger.warn(
        `tool "${name}" parameters is not a supported JSON Schema; the model-facing schema may degrade (${String(error)})`,
      )
    }
  }
  const timeoutMs = definition.timeoutMs
  if (timeoutMs !== undefined
    && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`)
  }
  // Reserved unconditionally: any agent may select a code mode for itself,
  // so a name free to take under the deployment default would become a
  // collision the moment a preset mounted.
  if (name === RUN_CODE_NAME) {
    throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the Code Mode presentation transport and cannot be registered or shadowed`)
  }
  return rt.layers.effect(
    rt.ctx,
    layer => layer.tools.insert(name, definition),
    { label: 'tools.register()' },
  )
}

/**
 * Reserve a capability NAME in the calling layer without registering a
 * visible definition. A reserved name joins the known/restrictable universe
 * — a scope may later `restrict()` it away, and `toolOrder` may list it — but
 * it never reaches the model-facing schema until a real `register()` supplies
 * the definition. This is how a deferred-tool registry seeds the names a
 * composition may gate before their heavy definitions load.
 *
 * The name stays out of the runtime's `get` and `schemas` views (only
 * registered definitions are visible). Duplicate reservations within one
 * layer fail, matching the duplicate-name rule for `register`.
 * @param rt - the owning runtime.
 * @param name - the capability name to make known without presenting.
 * @returns the exact disposer that clears the reservation.
 */
export function reserve(rt: ToolRuntimeCore, name: string): () => void {
  if (name === RUN_CODE_NAME) {
    throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the Code Mode presentation transport and cannot be registered or shadowed`)
  }
  return rt.layers.effect(
    rt.ctx,
    layer => layer.reserved.insert(name, undefined),
    { label: 'tools.reserve()' },
  )
}

/**
 * Whether a global tool name passes every scoped restriction on the viewing
 * scope's chain. The answer ignores registration: a reserved or not-yet-loaded
 * name is admitted if no `allow`/`deny` on the chain masks it, so a caller can
 * gate whether a deferred capability may load for one agent. A name masked by
 * an `allow` list it is absent from, or present in a `deny` list, is not
 * admitted. When a name has multiple restrictions, they intersect (all must
 * admit it), matching registration visibility.
 * @param rt - the owning runtime.
 * @param name - the capability name to test.
 * @param scope - the viewing scope (the agent); omitted for the global view, which has no restrictions.
 * @returns whether the name may load for that scope.
 */
export function isAdmitted(rt: ToolRuntimeCore, name: string, scope?: ScopeKey): boolean {
  return rt.layers.chainLayers(scope).every(layer => layer.admits(name))
}

/**
 * Restrict global tools for the calling agent scope. Empty filters, unknown
 * names, scope-local names, and reserved transport names fail. Restrictions
 * intersect; scoped registrations remain visible.
 * @param rt - the owning runtime.
 * @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
 * @returns the exact disposer that lifts this restriction.
 */
export function restrict(rt: ToolRuntimeCore, filter: ToolRestriction): () => void {
  const scope = scopeOf(rt.ctx)
  if (scope === undefined) {
    throw new Error('tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead')
  }
  const allow = filter.allow
  const deny = filter.deny
  if (allow === undefined && deny === undefined) {
    throw new Error('tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)')
  }
  const compiled: CompiledToolRestriction = {
    ...allow !== undefined ? { allow: new Set(allow) } : {},
    ...deny !== undefined ? { deny: new Set(deny) } : {},
  }
  if ([...allow ?? [], ...deny ?? []].includes(RUN_CODE_NAME)) {
    throw new Error(`tools.restrict() cannot name reserved Code Mode presentation transport "${RUN_CODE_NAME}"; restrict end-capability tools instead`)
  }
  const known = rt.view(scope).restrictableNames
  const unknown = [...allow ?? [], ...deny ?? []].filter(name => !known.has(name))
  if (unknown.length > 0) {
    throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map(n => `"${n}"`).join(', ')}; known global tools: ${[...known].sort().join(', ') || '(none)'}`)
  }
  return rt.layers.effect(
    rt.ctx,
    layer => layer.restrictions.append(compiled),
    { label: 'tools.restrict()' },
  )
}

/**
 * Register a monotonic guard after the extensible `tools/pre-execute`
 * waterfall. A plain-context guard applies globally; one registered through
 * `agent.ctx` applies only to that agent. Any matching guard may deny by
 * returning a reason, while no guard can force-allow a call another guard
 * denied. The exact effect disposer is returned for ordered ownership and
 * HMR cleanup.
 * @param rt - the owning runtime.
 * @param guard - synchronous check; a returned string denies the execution.
 * @returns the exact disposer that unregisters the guard.
 */
export function guard(rt: ToolRuntimeCore, guard: ToolGuard): () => void {
  return rt.layers.effect(
    rt.ctx,
    layer => layer.guards.append(guard),
    { label: 'tools.guard()', notify: false },
  )
}

/** First monotonic denial from the global then the scope chain's guard layers, farthest first. */
export function guardReason(rt: ToolRuntimeCore, exec: ToolExecution): string | undefined {
  const globalReason = rt.layers.global.guardReason(exec)
  if (globalReason !== undefined) return globalReason
  if (exec.agent === undefined) return undefined
  for (const layer of rt.layers.chainLayers(exec.agent)) {
    const reason = layer.guardReason(exec)
    if (reason !== undefined) return reason
  }
  return undefined
}

/**
 * Resolve every registry fact one scope needs in one layer traversal. The
 * visible map applies restrictions to the INHERITED surface, then the
 * scope's own registrations and the reserved presentation transport; the
 * other sets retain the pre-restriction facts needed by restriction and
 * prompt-order validation.
 *
 * A restriction filters what a scope inherits — the global layer and every
 * ancestor layer on its chain — and never what its OWN layer registers.
 * That exemption is what a per-child capability filter has to keep intact:
 * the delegation runtime registers a child's reporting and structured-output
 * tools into the child's own layer, and a filter naming the capabilities the
 * child may use must not strip the machinery it answers through.
 *
 * Reading the exempt set as "the global layer" instead of "not mine" held
 * only while every model-facing tool sat in the host composition. Once
 * presets moved them onto the agent plane they became an ANCESTOR
 * contribution, so a child's filter silently stopped constraining anything
 * it was given.
 * @param rt - the owning runtime.
 * @param scope - the viewing scope (the agent), or undefined for the global view.
 * @returns the complete derived view for that scope.
 */
export function view(rt: ToolRuntimeCore, scope?: ScopeKey): ToolView {
  // Scope-chain layers, farthest ancestor first, the exact scope last.
  const layers = rt.layers.chainLayers(scope)
  // Chain-blind on purpose: this is the ONE layer whose registrations the
  // scope owns rather than inherits, and it is absent until the scope
  // contributes something.
  const own = rt.layers.peek(scope)
  // Inherited surface, nearest ancestor last: a nearer scope's same-name
  // entry shadows a farther one, and the global layer is the farthest.
  const inherited = new Map<string, ToolDefinition>(rt.layers.global.tools.entries())
  for (const layer of layers) {
    if (layer === own) continue
    for (const [name, definition] of layer.tools.entries()) inherited.set(name, definition)
  }
  const visible = new Map<string, ToolDefinition>()
  const knownNames = new Set<string>()
  const restrictableNames = new Set<string>()
  for (const [name, definition] of inherited) {
    knownNames.add(name)
    restrictableNames.add(name)
    // Restrictions intersect across the whole chain: any scope on it may
    // mask an inherited name for everything nested inside it.
    if (layers.every(layer => layer.admits(name))) visible.set(name, definition)
  }
  // The scope's own registrations last, shadowing an inherited name and
  // outside the filter above.
  if (own !== undefined) {
    for (const [name, definition] of own.tools.entries()) {
      knownNames.add(name)
      visible.set(name, definition)
    }
  }
  // Reserved names are known and restrictable but never visible: they enter
  // the inherited universe (so a scope may gate them before load) without a
  // definition to present. Chain + global, same inheritance shape as tools.
  for (const { reserved } of [rt.layers.global, ...layers]) {
    for (const name of reserved.keys()) {
      knownNames.add(name)
      restrictableNames.add(name)
    }
  }
  // Presentation infrastructure is resolved last and outside capability
  // filtering. Registration rejects this reserved name, so the insertion is
  // an invariant assertion as well as protection against future layer
  // changes. Per scope: a native agent must not find `run_code` in its
  // dispatch table because some other agent in the process presents it.
  if (rt.modeFor(scope) !== 'native') {
    visible.set(RUN_CODE_NAME, rt.requireCodeTransport())
  }
  return { visible, knownNames, restrictableNames }
}

/**
 * Look up a tool as one scope sees it (scoped
 * shadows global; a restricted-away global reads as absent). Presenters pass
 * the calling agent so the rendered card matches the definition that
 * actually executed.
 * @param rt - the owning runtime.
 * @param name - the tool name as registered.
 * @param scope - the viewing scope (the agent); omitted = the global view.
 * @returns the definition the scope resolves, or undefined when none is visible.
 */
export function get(rt: ToolRuntimeCore, name: string, scope?: ScopeKey): ToolDefinition | undefined {
  return rt.view(scope).visible.get(name)
}

/**
 * Resolve the definition that MAY EXECUTE for a call, applying the mode
 * collapse at the operation boundary that owns it. The registry view
 * (`get`) is presentation-agnostic; here a MODEL-DIRECT call under `code`
 * may only name the reserved `run_code` transport, while a nested
 * sub-dispatch (a `parent` token set — the `run_code` SDK calling a tool
 * it bound) may call any visible tool. Denial surfaces as `UNKNOWN_TOOL`
 * through the executor, matching an absent definition.
 * @param rt - the owning runtime.
 * @param name - the tool name as registered.
 * @param scope - the viewing scope (the agent); omitted = the global view.
 * @param nested - whether the call is a transport sub-dispatch, not a model-direct call.
 * @returns the definition that may run, or undefined when the call must be rejected.
 */
export function resolveExecution(rt: ToolRuntimeCore, name: string, scope: ScopeKey | undefined, nested: boolean): ToolDefinition | undefined {
  const tool = rt.get(name, scope)
  if (tool === undefined) return undefined
  if (rt.collapses(name, scope, nested)) return undefined
  return tool
}

/**
 * Classify a pending call through the caller's visible tool definition. Only
 * an exact `true` is parallel; unknown, hidden, undeclared, invalid, or
 * throwing classifiers are exclusive.
 * @param rt - the owning runtime.
 * @param exec - call name, parsed arguments, and optional agent scope.
 * @returns the fail-closed scheduling mode.
 */
export function executionMode(rt: ToolRuntimeCore, exec: ToolExecutionInput): ToolExecutionMode {
  const tool = rt.resolveExecution(exec.name, exec.agent, exec.parent !== undefined)
  if (!tool?.isConcurrencySafe) return { kind: 'exclusive' }
  try {
    const concurrencySafe: unknown = tool.isConcurrencySafe(exec.arguments)
    return concurrencySafe === true ? { kind: 'parallel' } : { kind: 'exclusive' }
  } catch {
    return { kind: 'exclusive' }
  }
}
