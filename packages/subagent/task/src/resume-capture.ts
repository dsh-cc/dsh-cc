/**
 * Spawn-time resume-pin capture (plan §4.3 + §4.5): build and write the pin
 * for a continuable background child BEFORE `startContinuable`, and tombstone
 * it when the creation throws.
 *
 * The capture flow lives in the task package (not resume-pins) because it is
 * cordis-facing: it reads `ctx.llm.resolveCallConfig` for the §4.3 preflight
 * and `ctx.logger` for the never-fail-the-spawn degradation warnings. Only
 * pure helpers (`overlayRoute`, `probeWorkspace`) are exported for direct
 * reuse and testing.
 *
 * Failure policy: a capture problem never fails the spawn. An unresolvable
 * route degrades the pin to explicit-fields-only (`effective.complete:false` +
 * a warning); an unwriteable pin skips capture entirely (a missing pin reads
 * as a legacy/foreign child). Only the tombstone path rethrows nothing — the
 * original `startContinuable` error is rethrown unchanged by the caller.
 *
 * @module @dsh-cc/subagent-task/resume-capture
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { realpathSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentDefinition, ToolRestriction } from '@dsh-cc/claude-code-agents'
import type { DetailedRoute } from '@dsh-cc/model-aliases'
import {
  PinStore,
  definitionFingerprint,
  personaHash,
  type PinDefinition,
  type PinEffective,
  type PinModelSelector,
  type PinWorkspace,
  type ResumePin,
  type ResumePinDraft,
} from '@dsh-cc/subagent-resume-pins'

/** The additive `apply(ctx, config)` option that arms spawn-time capture. */
export interface ResumePinsConfig {
  /** Directory holding one `<childId>.json` pin file per child. */
  readonly pinsRoot: string
  /** Test seam: inject a store instead of constructing one over `pinsRoot`. */
  readonly store?: PinStore
}

/** The parent's route fields the harness child-agent spread inherits from. */
export interface ParentRouteLike {
  readonly provider?: string
  readonly model?: string
  readonly maxTokens?: number
}

/**
 * The pre-preflight effective tuple: parent options overlaid with the alias
 * route (§4.3). Mirrors the harness child-agent inheritance semantics
 * (`child-agent.ts:73-79`): the parent's provider/model/maxTokens are spread
 * conditionally, then the requested route's present fields win — `undefined`
 * never shadows an inherited value.
 */
export function overlayRoute(
  parent: ParentRouteLike,
  route: DetailedRoute['route'],
): ParentRouteLike & { readonly reasoningEffort?: string } {
  return {
    ...parent.provider !== undefined ? { provider: parent.provider } : {},
    ...parent.model !== undefined ? { model: parent.model } : {},
    ...parent.maxTokens !== undefined ? { maxTokens: parent.maxTokens } : {},
    ...route?.provider !== undefined ? { provider: route.provider } : {},
    ...route?.model !== undefined ? { model: route.model } : {},
    ...route?.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {},
  }
}

/** The git probe timeout; a hung git must never delay a spawn. */
const GIT_PROBE_TIMEOUT_MS = 2_000

/**
 * Normalize one `git rev-parse` output to a cwd-anchored absolute path (git
 * prints repository-relative values like `.git`), realpath'ed when cheap.
 * Residual limit (documented): two DIFFERENT standalone repos initialized
 * sequentially at the same path normalize to the same path strings, so that
 * replacement is not detectable — the worktree↔standalone flip and cwd moves
 * ARE (the comparison is the --git-dir path pair, per the implemented rule).
 */
function normalizeGitPath(cwd: string, value: string): string {
  if (value.length === 0) return 'unknown'
  const absolute = isAbsolute(value) ? value : join(cwd, value)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

/**
 * Workspace/worktree identity via ONE best-effort git probe. `cwd` is always
 * present; on any probe failure (non-repo, git missing, timeout) the git
 * fields fall back to the `'unknown'` sentinel — the pin schema has no
 * optional fields, and a sentinel is parseable and visibly not an identity.
 * gitDir/gitCommonDir are cwd-anchored ABSOLUTE paths so pins pin an
 * identity, not a cwd-relative spelling.
 */
export function probeWorkspace(cwd: string): PinWorkspace {
  const fallback: PinWorkspace = { cwd, gitDir: 'unknown', gitCommonDir: 'unknown', branch: 'unknown' }
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync(
      'git',
      ['-C', cwd, 'rev-parse', '--git-dir', '--git-common-dir', '--abbrev-ref', 'HEAD'],
      { timeout: GIT_PROBE_TIMEOUT_MS, encoding: 'utf8' },
    )
  } catch {
    return fallback
  }
  if (result.status !== 0 || typeof result.stdout !== 'string') return fallback
  const [gitDir, gitCommonDir, branch] = result.stdout.trim().split('\n')
  if (gitDir === undefined || gitCommonDir === undefined || branch === undefined || branch.length === 0) {
    return fallback
  }
  return {
    cwd,
    gitDir: normalizeGitPath(cwd, gitDir),
    gitCommonDir: normalizeGitPath(cwd, gitCommonDir),
    branch,
  }
}

/** The `ctx.llm` surface the preflight needs. */
interface LlmLike {
  resolveCallConfig(config: {
    provider: string
    model: string
    maxTokens?: number
    reasoningEffort?: string
  }): Promise<{ provider: string; model: string; maxTokens?: number; reasoningEffort?: string }>
}

/** Everything one pinned spawn contributes to the pin (§4.5). */
export interface CaptureInput {
  readonly parentSessionId: string
  readonly label: string
  readonly childId: string
  /** A named definition (with discovery metadata); undefined for plain spawns. */
  readonly definition?: AgentDefinition | undefined
  /** Atomic provenance resolution of the definition's `model` selector. */
  readonly selector: DetailedRoute
  readonly parentRoute: ParentRouteLike
  /** The sanitized tool filter exactly as forwarded to the seam. */
  readonly toolFilter?: ToolRestriction | undefined
  /** The session workspace cwd (workspace-identity probe root). */
  readonly cwd: string
}

/**
 * Owns the write-before-spawn and tombstone-on-throw lifecycle for one
 * mounted `resumePins` config. Never throws on capture trouble — a degraded
 * or skipped pin is reported through `ctx.logger.warn` and the spawn proceeds.
 */
export class SpawnPinCapture {
  constructor(
    private readonly ctx: Context,
    readonly store: PinStore,
  ) {}

  /** Preallocate the durable child id (it becomes the child's session id). */
  preallocateChildId(): string {
    return randomUUID()
  }

  /** The selector recorded when no route service is mounted: plain inherit. */
  static inheritSelector(model: string | undefined): DetailedRoute {
    return { selector: model, via: 'inherit', route: undefined }
  }

  /**
   * Build the pin and write it before the spawn. The spawn is NEVER failed by
   * capture trouble and capture is never silently skipped: resolves
   * `undefined` on success, or the failure reason on a skipped capture — the
   * caller MUST surface it as an explicit `captureWarning` line in the
   * subagent_fork tool result ("this child will resume with legacy
   * semantics"), so an unpinned launch is never silent.
   */
  async write(input: CaptureInput): Promise<string | undefined> {
    try {
      this.store.write(await this.build(input))
      return undefined
    } catch (error) {
      const reason = (error as Error).message
      this.ctx.logger.warn(`resume pin capture failed (spawn proceeds unpinned): ${reason}`)
      return reason
    }
  }

  /**
   * Tombstone the pin after a failed `startContinuable`: delete the file; if
   * the delete fails, rewrite it as blocked so it can never be mistaken for
   * a live agent. Idempotent; never throws.
   */
  async tombstone(childId: string): Promise<void> {
    try {
      this.store.remove(childId)
      return
    } catch {
      // Fall through to the blocked rewrite.
    }
    try {
      this.store.update(childId, (draft: ResumePinDraft) => {
        draft.resume = { state: 'blocked', reason: 'spawn-aborted' }
      })
    } catch (error) {
      this.ctx.logger.warn(
        `resume pin tombstone failed for child ${childId}: ${(error as Error).message}`,
      )
    }
  }

  private async build(input: CaptureInput): Promise<ResumePin> {
    const route = input.selector.route
    const overlay = overlayRoute(input.parentRoute, route)
    if (overlay.provider === undefined || overlay.model === undefined) {
      throw new Error('no explicit provider/model route to pin')
    }
    const effective = await this.preflight(overlay)
    const definition: PinDefinition = input.definition === undefined
      ? { kind: 'plain' }
      : {
          kind: 'named',
          agentType: input.definition.agentType,
          source: input.definition.source,
          fingerprint: definitionFingerprint(input.definition),
          personaHash: personaHash(input.definition.systemPrompt),
          // Gate-time re-fingerprinting needs the discovery location (§4.4).
          baseDir: input.definition.baseDir,
          filename: input.definition.filename,
        }
    const modelSelector: PinModelSelector = {
      raw: input.selector.selector ?? 'inherit',
      via: input.selector.via,
    }
    return {
      version: 1,
      childId: input.childId,
      parentSessionId: input.parentSessionId,
      label: input.label,
      mode: 'continuable-background',
      createdAt: new Date().toISOString(),
      definition,
      modelSelector,
      effective,
      toolFilter: {
        allow: [...(input.toolFilter?.allow ?? [])],
        deny: [...(input.toolFilter?.deny ?? [])],
      },
      ...input.definition?.maxTurns !== undefined ? { maxTurns: input.definition.maxTurns } : {},
      workspace: probeWorkspace(input.cwd),
      resume: { state: 'ok' },
    }
  }

  /**
   * §4.3 preflight: materialize the complete tuple with explicit nulls for
   * absent effort/maxTokens. Failure degrades to the explicit overlay fields
   * with `complete:false` plus a warning — never a spawn failure.
   */
  private async preflight(
    overlay: ParentRouteLike & { readonly reasoningEffort?: string },
  ): Promise<PinEffective> {
    const llm = this.ctx.get('llm') as LlmLike | undefined
    try {
      if (llm === undefined) throw new Error('no llm service for the preflight')
      const config = await llm.resolveCallConfig({
        provider: overlay.provider!,
        model: overlay.model!,
        ...(overlay.maxTokens !== undefined ? { maxTokens: overlay.maxTokens } : {}),
        ...(overlay.reasoningEffort !== undefined ? { reasoningEffort: overlay.reasoningEffort } : {}),
      })
      return {
        provider: config.provider,
        model: config.model,
        reasoningEffort: config.reasoningEffort ?? null,
        maxTokens: config.maxTokens ?? null,
        complete: true,
      }
    } catch {
      this.ctx.logger.warn(
        'resume pin degraded: route not preflightable; only explicit options pinned',
      )
      return {
        provider: overlay.provider!,
        model: overlay.model!,
        reasoningEffort: overlay.reasoningEffort ?? null,
        maxTokens: overlay.maxTokens ?? null,
        complete: false,
      }
    }
  }
}
