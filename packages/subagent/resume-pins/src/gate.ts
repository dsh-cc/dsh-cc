/**
 * The PURE resume gate (plan §4.6): re-evaluates one pin against current
 * environment facts on every cold resume. No cordis, no IO of its own — the
 * environment supplies already-probed facts and throwing availability
 * resolvers; the caller (the plugin) persists any deny to the pin BEFORE the
 * decision is returned (durability ordering) and is also responsible for
 * skipping the gate entirely when no pin exists (legacy/foreign child).
 *
 * A persisted `resume.state='blocked'` never short-circuits: policy flips and
 * recovered conditions are authoritative, the stored state is derived.
 *
 * @module @dsh-cc/subagent-resume-pins/gate
 */

import type {
  CorruptPin,
} from './store.ts'
import type { OverlayTuple, ResumePin } from './pin.ts'
import type { ResumePolicy } from './policy.ts'

/** Why a cold resume was denied. The first five always block (no fallback). */
export type DenyCode =
  | 'PIN_ORPHANED'
  | 'PIN_UNREADABLE'
  | 'WORKSPACE_MISSING'
  | 'PINNED_TOOL_UNAVAILABLE'
  | 'SUBAGENT_MODEL_UNAVAILABLE'
  | 'WORKSPACE_CHANGED'
  | 'DEFINITION_CHANGED'
  | 'STORE_WRITE_FAILURE'

/** A resolved call config as the availability preflight returns it. */
export interface GateResolvedConfig {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string | undefined
  readonly maxTokens?: number | undefined
}

/** The route fields a selector resolution may contribute. */
export interface GateDetailedRoute {
  readonly via: 'alias' | 'literal' | 'inherit'
  readonly route:
    | { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string }
    | undefined
}

/** The probed environment facts + availability resolvers one evaluation uses. */
export interface GateEnv {
  /** The child has a persisted session (step 0: false → orphaned pin). */
  readonly sessionExists: boolean
  /** The pinned workspace cwd still exists on disk. */
  readonly cwdExists: boolean
  /** The CURRENT git identity of the workspace cwd (probe already run). */
  readonly currentGit: {
    readonly gitDir: string
    readonly gitCommonDir: string
    readonly branch: string
  }
  /**
   * Re-fingerprinted definition identity (step 3, named pins only): a current
   * fingerprint string, `'missing'` for a gone/unreadable definition, or
   * `null` when no current information exists (no current information check).
   */
  readonly currentDefinitionFingerprint: string | 'missing' | null
  /**
   * The calling parent agent's CURRENT route ({@link AgentOptions} subset).
   * The route-current fallback overlays a freshly-resolved selector onto THIS
   * route — never onto the pinned tuple — so parent-route drift is honored.
   */
  readonly currentRoute?: { readonly provider?: string; readonly model?: string; readonly maxTokens?: number }
  /** The current restrictable tool-name universe (step 4). */
  readonly restrictableNames: ReadonlySet<string>
  /**
   * §4.3 preflight against the LIVE registrations; throws when the provider
   * is unmounted, the route invalid, or a requested control unsupported.
   */
  resolveCallConfig(config: {
    provider: string
    model: string
    maxTokens?: number
    reasoningEffort?: string
  }): Promise<GateResolvedConfig>
  /** Atomic provenance re-resolution of a model selector (undefined = inherit). */
  resolveDetailed(selector: string | undefined): GateDetailedRoute
}

/** One gate outcome. Denies carry a stable code and a human reason. */
export type GateDecision =
  | { readonly action: 'pass'; readonly notices: readonly string[]; readonly clearBlocked?: boolean; readonly overlay?: OverlayTuple }
  | { readonly action: 'deny'; readonly code: DenyCode; readonly reason: string }

/** Field-by-field tuple comparison WITH absence semantics (`null` = absent). */
function tupleDrift(pinned: OverlayTuple, current: GateResolvedConfig): string | undefined {
  if (current.provider !== pinned.provider) return `provider ${pinned.provider} -> ${current.provider}`
  if (current.model !== pinned.model) return `model ${pinned.model} -> ${current.model}`
  if ((current.reasoningEffort ?? null) !== pinned.reasoningEffort) {
    return `reasoningEffort ${JSON.stringify(pinned.reasoningEffort)} -> ${JSON.stringify(current.reasoningEffort ?? null)}`
  }
  if ((current.maxTokens ?? null) !== pinned.maxTokens) {
    return `maxTokens ${JSON.stringify(pinned.maxTokens)} -> ${JSON.stringify(current.maxTokens ?? null)}`
  }
  return undefined
}

/** Re-resolution of the pinned route: throws when unavailable. */
function resolvePinned(env: GateEnv, pin: ResumePin): Promise<GateResolvedConfig> {
  return env.resolveCallConfig({
    provider: pin.effective.provider,
    model: pin.effective.model,
    ...(pin.effective.reasoningEffort !== null ? { reasoningEffort: pin.effective.reasoningEffort } : {}),
    ...(pin.effective.maxTokens !== null ? { maxTokens: pin.effective.maxTokens } : {}),
  })
}

/** Alias drift: the selector no longer resolves (to the pinned model) via alias. */
function aliasDrift(env: GateEnv, pin: ResumePin): string | undefined {
  if (pin.modelSelector.via !== 'alias') return undefined
  const detailed = env.resolveDetailed(pin.modelSelector.raw)
  if (detailed.via !== 'alias' || detailed.route?.model === undefined) {
    return `alias "${pin.modelSelector.raw}" no longer resolves`
  }
  if (detailed.route.model !== pin.effective.model) {
    return `alias "${pin.modelSelector.raw}" now resolves to "${detailed.route.model}"`
  }
  if (detailed.route.provider !== undefined && detailed.route.provider !== pin.effective.provider) {
    return `alias "${pin.modelSelector.raw}" now routes to provider "${detailed.route.provider}"`
  }
  return undefined
}

/**
 * The route-current fallback (§4.6 step 5): resolve the selector fresh via
 * `resolveDetailed`, overlay the resolution onto the CURRENT parent route
 * (`env.currentRoute` — never the pinned tuple), and preflight the complete
 * tuple atomically. Alias drift detection is unchanged; the fallback route
 * itself is always the current one, so an alias that no longer resolves falls
 * back to the parent's current default route rather than the pinned tuple.
 * An unresolvable current route (no parent route on record, or a preflight
 * failure) resolves `undefined`.
 */
async function currentTuple(
  env: GateEnv,
  pin: ResumePin,
): Promise<OverlayTuple | undefined> {
  const base: {
    provider?: string | undefined
    model?: string | undefined
    reasoningEffort?: string | undefined
    maxTokens?: number | undefined
  } = { ...env.currentRoute }
  const detailed = env.resolveDetailed(pin.modelSelector.via === 'inherit' ? undefined : pin.modelSelector.raw)
  const route = detailed.route
  if (route?.model !== undefined) base.model = route.model
  if (route?.provider !== undefined) base.provider = route.provider
  if (route?.reasoningEffort !== undefined) base.reasoningEffort = route.reasoningEffort
  if (base.provider === undefined || base.model === undefined) return undefined
  try {
    const resolved = await env.resolveCallConfig({
      provider: base.provider,
      model: base.model,
      ...(base.reasoningEffort !== undefined ? { reasoningEffort: base.reasoningEffort } : {}),
      ...(base.maxTokens !== undefined ? { maxTokens: base.maxTokens } : {}),
    })
    return {
      provider: resolved.provider,
      model: resolved.model,
      reasoningEffort: resolved.reasoningEffort ?? null,
      maxTokens: resolved.maxTokens ?? null,
    }
  } catch {
    return undefined
  }
}

/**
 * Evaluate the gate steps 0-5 for one pin (or an unreadable one — corrupt
 * pins deny before any environment probe). Every deny the caller persists as
 * `resume.state='blocked'`; an all-passing evaluation clears it.
 * @param pin - the read pin (a {@link CorruptPin} denies `PIN_UNREADABLE`).
 * @param env - probed environment facts and availability resolvers.
 * @param policy - the LIVE policy read at evaluation time.
 */
export async function evaluateGate(
  pin: ResumePin | CorruptPin,
  env: GateEnv,
  policy: ResumePolicy,
): Promise<GateDecision> {
  // Step 1 (readability — probed before anything else: a corrupt pin has no
  // fields to evaluate against, and fail-closed beats every notice path).
  if ('kind' in pin) {
    return { action: 'deny', code: 'PIN_UNREADABLE', reason: `[PIN_UNREADABLE] resume pin is unreadable (${pin.reason}); refusing to resume` }
  }
  const resumedPin: ResumePin = pin
  const notices: string[] = []

  // Step 0: the persisted session must exist — otherwise the pin is an
  // orphan of an aborted spawn and the id is unaddressable.
  if (!env.sessionExists) {
    return { action: 'deny', code: 'PIN_ORPHANED', reason: '[PIN_ORPHANED] no persisted session exists for this pinned child; the spawn must have been aborted' }
  }

  // Step 2: workspace. A missing cwd has no fallback; a changed canonical
  // repo identity is a policy; branch-only drift is a notice either way.
  if (!env.cwdExists) {
    return { action: 'deny', code: 'WORKSPACE_MISSING', reason: `[WORKSPACE_MISSING] pinned workspace ${resumedPin.workspace.cwd} no longer exists; there is no relocatable fallback` }
  }
  const repoIdentityChanged = env.currentGit.gitDir !== resumedPin.workspace.gitDir
    || env.currentGit.gitCommonDir !== resumedPin.workspace.gitCommonDir
  if (repoIdentityChanged) {
    if (policy.onWorkspaceChanged === 'block') {
      return { action: 'deny', code: 'WORKSPACE_CHANGED', reason: `[WORKSPACE_CHANGED] workspace repository identity changed since spawn (pinned ${resumedPin.workspace.gitDir}/${resumedPin.workspace.gitCommonDir}, current ${env.currentGit.gitDir}/${env.currentGit.gitCommonDir}); policy onWorkspaceChanged=block` }
    }
    notices.push('resumed after the workspace repository identity changed (branch/worktree re-provisioned); continuing in the current workspace')
  }
  if (env.currentGit.branch !== resumedPin.workspace.branch) {
    notices.push(`workspace branch changed since spawn (pinned ${resumedPin.workspace.branch}, current ${env.currentGit.branch}); continuing on the current branch`)
  }

  // Step 3: definition identity (named pins only). The child keeps its
  // PINNED persona/tool filter — the harness descriptor restores those, so
  // nothing is re-guessed even when the file changed.
  if (resumedPin.definition.kind === 'named' && env.currentDefinitionFingerprint !== null) {
    if (env.currentDefinitionFingerprint !== resumedPin.definition.fingerprint) {
      if (policy.onDefinitionChanged === 'block') {
        return { action: 'deny', code: 'DEFINITION_CHANGED', reason: `[DEFINITION_CHANGED] definition "${resumedPin.definition.agentType}" changed since spawn and policy onDefinitionChanged=block` }
      }
      notices.push('resumed with changed definition (pinned persona retained)')
    }
  }

  // Step 4: every pinned filter name must still be restrictable — pruning an
  // allow entry shrinks capability, pruning a deny entry widens permissions.
  const missing = [...resumedPin.toolFilter.allow, ...resumedPin.toolFilter.deny]
    .filter(name => !env.restrictableNames.has(name))
  if (missing.length > 0) {
    return { action: 'deny', code: 'PINNED_TOOL_UNAVAILABLE', reason: `[PINNED_TOOL_UNAVAILABLE] pinned tool filter names tools this composition no longer knows: ${missing.join(', ')}` }
  }

  // Step 5: model/route availability & drift.
  const unavailable = (detail: string): string =>
    `[SUBAGENT_MODEL_UNAVAILABLE] pinned route ${resumedPin.effective.provider}/${resumedPin.effective.model} is no longer available (${detail}); unblock with subagents-resume.onUnavailableModel: 'route-current'`
  if (resumedPin.effective.complete) {
    let resolved: GateResolvedConfig
    try {
      resolved = await resolvePinned(env, pin)
    } catch (error) {
      const detail = (error as Error).message
      if (policy.onUnavailableModel === 'block') {
        return { action: 'deny', code: 'SUBAGENT_MODEL_UNAVAILABLE', reason: unavailable(detail) }
      }
      const overlay = await currentTuple(env, pin)
      if (overlay === undefined) {
        return { action: 'deny', code: 'SUBAGENT_MODEL_UNAVAILABLE', reason: unavailable(`${detail}; the route-current fallback is unavailable too`) }
      }
      notices.push(`original model ${resumedPin.effective.provider}/${resumedPin.effective.model} unavailable; resumed with current default route ${overlay.provider}/${overlay.model} per policy`)
      return finish({ overlay })
    }
    const drift = tupleDrift(resumedPin.effective, resolved) ?? aliasDrift(env, pin)
    if (drift === undefined) return finish()
    if (policy.onUnavailableModel === 'block') {
      return { action: 'deny', code: 'SUBAGENT_MODEL_UNAVAILABLE', reason: unavailable(drift) }
    }
    const overlay = await currentTuple(env, pin)
    if (overlay === undefined) {
      return { action: 'deny', code: 'SUBAGENT_MODEL_UNAVAILABLE', reason: unavailable(`${drift}; the route-current fallback is unavailable too`) }
    }
    notices.push(`original model ${resumedPin.effective.provider}/${resumedPin.effective.model} unavailable; resumed with current default route ${overlay.provider}/${overlay.model} per policy`)
    return finish({ overlay })
  }
  // Degraded pin: only provider-mounted and alias-drift are checkable.
  try {
    await resolvePinned(env, pin)
  } catch (error) {
    const detail = (error as Error).message
    if (policy.onUnavailableModel === 'block') {
      return { action: 'deny', code: 'SUBAGENT_MODEL_UNAVAILABLE', reason: unavailable(detail) }
    }
    const overlay = await currentTuple(env, pin)
    if (overlay === undefined) {
      return { action: 'deny', code: 'SUBAGENT_MODEL_UNAVAILABLE', reason: unavailable(`${detail}; the route-current fallback is unavailable too`) }
    }
    notices.push(`original model ${resumedPin.effective.provider}/${resumedPin.effective.model} unavailable; resumed with current default route ${overlay.provider}/${overlay.model} per policy`)
    return finish({ overlay })
  }
  const drift = aliasDrift(env, pin)
  if (drift !== undefined) {
    if (policy.onUnavailableModel === 'block') {
      return { action: 'deny', code: 'SUBAGENT_MODEL_UNAVAILABLE', reason: unavailable(drift) }
    }
    const overlay = await currentTuple(env, pin)
    if (overlay === undefined) {
      return { action: 'deny', code: 'SUBAGENT_MODEL_UNAVAILABLE', reason: unavailable(`${drift}; the route-current fallback is unavailable too`) }
    }
    notices.push(`original model ${resumedPin.effective.provider}/${resumedPin.effective.model} unavailable; resumed with current default route ${overlay.provider}/${overlay.model} per policy`)
    return finish({ overlay })
  }
  return finish()

  function finish(extra: { overlay?: OverlayTuple } = {}): GateDecision {
    return {
      action: 'pass',
      notices,
      ...resumedPin.resume.state === 'blocked' ? { clearBlocked: true } : {},
      ...extra.overlay !== undefined ? { overlay: extra.overlay } : {},
    }
  }
}
