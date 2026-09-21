/**
 * The `actor-contract` settings gate for the plugin loader (docs/plans/
 * 2026-09-21-subagent-actor-contract-prompts.md §3.2): the settings namespace
 * holding the model-pattern list that decides whether a marked actor-contract
 * block survives into a subagent persona. The section is installed at plugin
 * mount; `AgentProvider.start` reads the patterns live at spawn time so hot
 * reload and mid-session settings edits apply on the next spawn.
 *
 * This package publishes NO cordis service: the task package owns
 * `ccActorContractGate`, and a duplicate provide would throw on co-mount.
 * Only the settings section is installed here (installSectionSafe's
 * multi-owner semantics mean the second mounter gets a live setSource via
 * settings/updated; identical schema + defaults make that safe), and the
 * returned gate instance is the package's local live reader.
 *
 * KEEP IN SYNC: the namespace + schema are duplicated in
 * `packages/subagent/task/src/actor-contract-gate.ts` so either mount order
 * wins via installSectionSafe's multi-owner semantics; the candidates rule
 * and dispatch default are shared from `@dsh-cc/claude-code-agents`.
 *
 * @module @dsh-cc/plugin-loader/actor-contract-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { installSectionSafe } from '@dsh-cc/settings-ns'
import { DEFAULT_ACTOR_CONTRACT_MODELS, gateCandidates } from '@dsh-cc/claude-code-agents'

// The candidates rule and dispatch default live in @dsh-cc/claude-code-agents
// so every seam (task, loader, resume-pins re-fingerprint) shares one source.
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

  /** The configured patterns; read at spawn time by the seam call site. */
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
 * Install the `actor-contract` settings section when a settings provider
 * exists (absent provider → default patterns) and return the local live gate
 * the plugin's `AgentProvider`s read at spawn time. No cordis service is
 * provided — the task package owns `ccActorContractGate`.
 * @param ctx - the context the loader mounts on.
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
  return gate
}
