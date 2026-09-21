/**
 * The `actor-contract` settings gate (docs/plans/2026-09-21-subagent-actor-
 * contract-prompts.md §3.2): the settings namespace holding the model-pattern
 * list that decides whether a marked actor-contract block survives into a
 * subagent persona. Mounted by this plugin's apply; read live at spawn time
 * so hot reload and mid-session settings edits apply on the next dispatch.
 *
 * KEEP IN SYNC: the same schema + namespace is duplicated in
 * `packages/compat/cc-plugin-loader/src/actor-contract-gate.ts` (later slice)
 * so either mount order wins via installSectionSafe's multi-owner semantics.
 *
 * @module @dsh-cc/subagent-task/actor-contract-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { installSectionSafe } from '@dsh-cc/settings-ns'
import { DEFAULT_ACTOR_CONTRACT_MODELS, gateCandidates } from '@dsh-cc/claude-code-agents'

// The candidates rule and dispatch default live in @dsh-cc/claude-code-agents
// so the resume-pins re-fingerprinting seam shares one source (§3.7).
export { DEFAULT_ACTOR_CONTRACT_MODELS, gateCandidates }

/** The settings namespace for the actor-contract gate (kebab-case discipline). */
export const ACTOR_CONTRACT_NAMESPACE = 'actor-contract' as SettingsNamespace

/** The resolved settings section for the namespace. */
export interface ActorContractSettings {
  /** Model patterns (case-insensitive globs, `*` the only wildcard). */
  readonly models: string[]
}

/**
 * The section schema. The default DOES materialize (unlike permission-rules'
 * absence-preserving sub-objects): gate-on-by-default is the product decision,
 * while an explicit user `[]` stays a real array and closes the gate.
 */
export function actorContractSettingsSchema(): z<ActorContractSettings> {
  return z.object({
    models: z.array(z.string()).default([...DEFAULT_ACTOR_CONTRACT_MODELS]),
  }) as unknown as z<ActorContractSettings>
}

/**
 * Live gate state pinned to one context: `setSource`/`onChange` follow the
 * settings-ns hook surface (the second owner of the namespace gets a live
 * `setSource` via `settings/updated`, so patterns stay hot). When no settings
 * provider ever attaches, the class keeps the DISPATCH-TIME default.
 */
export class ActorContractGate {
  private current: readonly string[] = DEFAULT_ACTOR_CONTRACT_MODELS
  private read: (() => ActorContractSettings) | undefined

  /** The configured patterns; read at spawn time by both seam call sites. */
  patterns(): readonly string[] {
    return this.current
  }

  /** Settings-ns hook: point the live read at the current section source. */
  setSource(current: () => ActorContractSettings): void {
    this.read = current
  }

  /** Settings-ns hook: re-read the section (attach or a committed change). */
  onChange(): void {
    this.current = this.read?.().models ?? [...DEFAULT_ACTOR_CONTRACT_MODELS]
  }
}

/**
 * Mount the gate: install the `actor-contract` section idempotently when a
 * settings provider exists (absent provider → default patterns, per the
 * unit/fake-context contract) and publish the gate as the
 * `ccActorContractGate` service the spawn seams read.
 * @param ctx - the plug context.
 * @returns the live gate instance.
 */
export function mountActorContractGate(ctx: Context): ActorContractGate {
  const gate = new ActorContractGate()
  ctx.inject(['settings'], () => {
    installSectionSafe<ActorContractSettings>(ctx, ACTOR_CONTRACT_NAMESPACE, actorContractSettingsSchema(), {
      models: [...DEFAULT_ACTOR_CONTRACT_MODELS],
    }, {
      setSource: (current) => { gate.setSource(current) },
      onChange: () => gate.onChange(),
    })
  })
  ctx.provide('ccActorContractGate', gate)
  return gate
}

/**
 * Read the live gate patterns from a context: the mounted service when
 * present, the DISPATCH-TIME default otherwise (unmounted gate, e.g. a bare
 * `registerTaskTool` composition without the plugin apply).
 * @param ctx - the context the Task tool executes on.
 * @returns the pattern list for {@link applyActorContract}.
 */
export function actorContractPatterns(ctx: Context): readonly string[] {
  return (ctx.get('ccActorContractGate') as ActorContractGate | undefined)?.patterns() ?? DEFAULT_ACTOR_CONTRACT_MODELS
}
