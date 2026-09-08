/**
 * ToolRuntime presentation collaborators: the presentation-mode resolver, the
 * `code` collapse statement, prompt-section assembly, and the model-facing
 * schema projections. Bodies are verbatim moves from the former `ToolRuntime`
 * methods with `this.` → `rt.`.
 * @module
 */

import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolProviderResult } from '@deepseek-ai/dsh-system-prompt'
import { RUN_CODE_NAME, SDK_SECTION_ORDER } from './code-mode.ts'
import type { ToolSdkSchema } from './ts-types.ts'
import type { ToolDefinition, ToolPresentationMode } from './tool-types.ts'
import { SDK_RENDERERS } from './runtime-core.ts'
import type { ToolRuntimeCore } from './runtime-core.ts'

/**
 * Prompt order of the `code` collapse statement: after the persona and before
 * the 100-199 per-tool guidance band, so the model reads which tools it may
 * call before it reads what each one is for.
 */
const COLLAPSE_SECTION_ORDER = 99

/**
 * The model-facing statement of the `code` collapse. Names the consequence
 * (the call fails) and the route (inside the program), because a rule the
 * model can only discover by being denied is one it corrects too late.
 */
const CODE_ONLY_INSTRUCTION = `\`${RUN_CODE_NAME}\` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.`

/**
 * The prompt statement of the `code` executor collapse, registered wherever
 * `sdkSection` is and rendering empty outside an effective `code`.
 *
 * Every tool contributes its own guidance section naming its tool, none of
 * them qualify how that tool is reached, and they all render before the SDK
 * (orders 100-199 against `SDK_SECTION_ORDER`). Without this the model
 * reads a catalog of tools it is told to use and no statement that only
 * `run_code` may be called, so it emits a native call, receives
 * `UNKNOWN_TOOL` for a tool the prompt just declared, and concludes the
 * deployment is inconsistent. `COLLAPSE_SECTION_ORDER` places the rule
 * before that guidance rather than after it.
 *
 * `both` renders empty: native calls do execute there, so the rule is false.
 * @param rt - the owning runtime.
 * @returns the section registration.
 */
export function collapseSection(rt: ToolRuntimeCore): { name: string; order: number; text: (context: { scope?: ScopeKey }) => string } {
  return {
    name: 'tools:code-only',
    order: COLLAPSE_SECTION_ORDER,
    // The SAME predicate the executor denies by, so the prompt cannot state
    // a rule the registry does not enforce (see `collapses`).
    text: context => rt.modeFor(context.scope) === 'code' ? CODE_ONLY_INSTRUCTION : '',
  }
}

/**
 * The generated-SDK prompt section, registered globally by a code-mode
 * deployment and per scope by `presentAs`.
 *
 * The body regenerates from the CALLING scope, and renders empty for an
 * agent presenting natively — an agent that opted out under a code-mode
 * deployment still sees the global registration, and an empty section is
 * dropped from the rendered prompt.
 * @param rt - the owning runtime.
 * @returns the section registration.
 */
export function sdkSection(rt: ToolRuntimeCore): { name: string; order: number; text: (context: { scope?: ScopeKey }) => string } {
  return {
    name: 'tools:sdk',
    order: SDK_SECTION_ORDER,
    // Regenerate from the calling scope's visible tools in stable order.
    text: (context) => {
      const mode = rt.modeFor(context.scope)
      if (mode === 'native') return ''
      const runtime = rt.requireCodeRuntime(mode)
      // Own-property read: a language like `toString`/`constructor` would
      // otherwise resolve an inherited Object.prototype member as a renderer.
      const render = SDK_RENDERERS[runtime.language]
      /* v8 ignore next -- requireCodeRuntime rejects an unknown language before this runs. */
      if (render === undefined) throw new Error(`dsh-tools: no SDK renderer for ${runtime.language}`)
      return render(rt.sdkSchemas(context.scope))
    },
  }
}

/**
 * The presentation one scope's agent sees: its own declaration, else the
 * deployment default.
 * @param rt - the owning runtime.
 * @param scope - the calling agent, or undefined for the global view.
 * @returns the resolved presentation mode.
 */
export function modeFor(rt: ToolRuntimeCore, scope?: ScopeKey): ToolPresentationMode {
  // Nearest scope wins along the chain: a preset's standing declaration
  // covers every agent parented under it, and an agent's own (were one ever
  // declared) would override its preset's. The mode decides what the model
  // SEES, which is exactly the class of fact the chain inherits.
  const layers = rt.layers.chainLayers(scope)
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const mode = layers[index]?.mode
    if (mode !== undefined) return mode
  }
  return rt.defaultMode
}

/**
 * Present the calling scope's tools in `mode` instead of the deployment
 * default. Nearest scope on the chain wins, so a preset's standing
 * declaration covers every agent joined under it.
 *
 * Scoped only, and one declaration per scope: this is how an agent preset
 * composes Code Mode agents beside native ones in the same process, and a
 * process-global override would be the `mode` config field instead.
 * @param rt - the owning runtime.
 * @param mode - the presentation the covered agents' models see.
 * @returns the exact disposer that restores the deployment default.
 */
export function presentAs(rt: ToolRuntimeCore, mode: ToolPresentationMode): () => void {
  const ctx = rt.ctx
  if (scopeOf(ctx) === undefined) {
    throw new Error('tools.presentAs() requires a scoped context (agent.ctx): a context-global presentation is the `mode` config field on the tools row')
  }
  const dispose = ctx.effect(function* (this: ToolRuntimeCore) {
    yield this.layers.effect(
      ctx,
      (layer) => {
        if (layer.mode !== undefined) {
          throw new Error(`tools.presentAs("${mode}") conflicts with "${layer.mode}" already declared for this scope; one composition selects one presentation`)
        }
        layer.mode = mode
        return () => { layer.mode = undefined }
      },
      { label: 'tools.presentAs()' },
    )
    // The SDK and collapse sections are per scope for the same reason the
    // mode is. Under a deployment that already defaults to a code mode this
    // shadows the global registration with an identical body, which costs
    // nothing and keeps one rule instead of a case analysis.
    if (mode !== 'native') {
      yield ctx.systemPrompt.section(this.collapseSection())
      yield ctx.systemPrompt.section(this.sdkSection())
    }
  }.bind(rt), 'tools.presentAs()')
  return dispose
}

/**
 * Build one scope's wire schemas and names for prompt-order validation.
 * Restrictions do not make known tools invalid, but a mode collapse does.
 */
export function wireSchemas(rt: ToolRuntimeCore, scope?: ScopeKey): ToolProviderResult {
  const view = rt.view(scope)
  const mode = rt.modeFor(scope)
  if (mode === 'native') {
    const schemas = [...view.visible.values()].map(definition => rt.schemaOf(definition, false))
    return { schemas, knownNames: [...view.knownNames] }
  }
  // Validate the runtime language BEFORE projecting schemas: schemaOf reads
  // run_code's language-aware description/parameters getters, whose own
  // flavor-table guard would otherwise surface first. This keeps the
  // renderer-table rejection the canonical assembly-time error for a
  // language with no SDK renderer.
  rt.requireCodeRuntime(mode)
  const schemas = [...view.visible.values()].map(definition => rt.schemaOf(definition, false))
  if (mode === 'code') {
    return {
      schemas: schemas.filter(schema => schema.name === RUN_CODE_NAME),
      knownNames: [RUN_CODE_NAME],
    }
  }
  return { schemas, knownNames: [...view.knownNames, RUN_CODE_NAME] }
}

/**
 * Project visible definitions onto the allowlisted model-facing schema fields,
 * excluding execution and presentation callbacks.
 * @param rt - the owning runtime.
 * @param scope - the viewing scope (the agent); omitted = the global view.
 * @returns one deep-cloned schema per visible tool.
 */
export function schemas(rt: ToolRuntimeCore, scope?: ScopeKey): ToolSchema[] {
  return [...rt.view(scope).visible.values()].map(definition => rt.schemaOf(definition, true))
}

/** Project visible callable tools onto the generated Code Mode SDK contract. */
export function sdkSchemas(rt: ToolRuntimeCore, scope?: ScopeKey): ToolSdkSchema[] {
  return [...rt.view(scope).visible.values()]
    .filter(definition => definition.name !== RUN_CODE_NAME)
    .map((definition): ToolSdkSchema => {
      const output = snapshotJsonValue(definition.output.schema)
      /* v8 ignore next -- registration already validated and retained this schema as lossless JSON. */
      if (output === undefined) {
        throw new Error(`tool "${definition.name}" output schema must be lossless JSON before SDK projection`)
      }
      return {
        ...rt.schemaOf(definition, true),
        output,
      }
    })
}

/** Project one definition onto the model-facing schema fields. */
export function schemaOf(_rt: ToolRuntimeCore, definition: ToolDefinition, detachParameters: boolean): ToolSchema {
  const { name, description, parameters } = definition
  const detached = detachParameters ? snapshotJsonValue(parameters) : parameters
  if (detached === undefined) {
    throw new Error(`tool "${name}" parameters must be lossless JSON before schema projection`)
  }
  return {
    name,
    description,
    parameters: detached,
  }
}

/**
 * Whether the `code` mode collapse denies a model-direct call: only the
 * reserved `run_code` transport may be named. Nested sub-dispatches (a
 * `parent` token set) bypass the collapse. One home for the
 * security-relevant predicate, shared by `resolveExecution` and
 * `createExecution` so the two can never drift apart.
 *
 * Resolved through `modeFor`, NOT `defaultMode`: an agent given `code`
 * by an agent preset under a native deployment is the composition
 * `dsh-agent-tool-presentation` exists for, and reading the deployment default would
 * leave exactly that agent uncollapsed — announcing one surface while
 * executing another, which is the bypass this collapse closes.
 * @param rt - the owning runtime.
 * @param name - the tool name as registered.
 * @param scope - the viewing scope whose effective presentation mode applies.
 * @param nested - whether the call is a transport sub-dispatch, not a model-direct call.
 */
export function collapses(rt: ToolRuntimeCore, name: string, scope: ScopeKey | undefined, nested: boolean): boolean {
  return !nested && rt.modeFor(scope) === 'code' && name !== RUN_CODE_NAME
}
