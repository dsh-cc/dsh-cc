/**
 * S1-06: the read-only, advisory `recommend_skill` tool and its cordis plugin.
 *
 * The tool answers one question — "which visible skills fit this task?" — and
 * nothing else. It does not load bodies, execute shell inside skills, invoke
 * skills, change invocation policy or hide low-scoring skills: the model keeps
 * choosing from the original catalog and the normal skill tool stays the only
 * execution entry point (design § "Goals and non-goals"). It is mounted
 * explicitly and defaults to `mode: off`, under which it returns the off result
 * and touches nothing.
 *
 * Wiring, mirroring `@dsh-cc/tool-search`'s `index.ts`:
 *
 * - the settings namespace registers lazily (absent settings plane ⇒ defaults ⇒
 *   `mode: off`) and is read LIVE on every call;
 * - the bound runner arrives through the structural host resolver in
 *   `contract.ts` — a missing service, actor or identity is `unavailable`, never
 *   a thrown tool error;
 * - the catalog comes from `ctx.skills.list()` for the calling agent's cwd and
 *   scope; `ctx.skills.get()` is never called;
 * - the asynchronous judgment hangs off {@link createRecommendationRuntime}, so
 *   the tool signature stays a thin adapter;
 * - the plugin's effect aborts in-flight judgments, clears the cache and
 *   unregisters the tool on unload.
 *
 * @module @dsh-cc/skill-recommender
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: brings the `ctx.skills` Context merge into this program.
import type {} from '@deepseek-ai/dsh-skill'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@dsh-cc/tools'
import type { ToolCallView, ToolRunContext } from '@dsh-cc/tools'
// Type-only: brings the `ctx.tools` Context merge into this program.
import type {} from '@dsh-cc/tools'
import { RecommendationCache } from './cache.ts'
import type { SkillRecommendationHostFace } from './contract.ts'
import type { RecommendationOutcome } from './recommend.ts'
import { createRecommendationRuntime } from './runtime.ts'
import type { RecommendationRuntime } from './runtime.ts'
import {
  DEFAULT_RECOMMENDATION_SETTINGS,
  createWarnOnce,
  registerRecommendationSettings,
} from './settings.ts'
import type { RecommendationSettingsReader } from './settings.ts'
import type { SkillDescriptor, SkillRecommendationResult } from './types.ts'

/** The cordis plugin name. */
export const name = 'skill-recommender'

/** The skills catalog and the tool registry this plugin reads. */
export const inject = ['skills', 'tools']

/** The model-facing tool name. */
export const RECOMMEND_SKILL_NAME = 'recommend_skill'

/** A refused call: the only model-visible failure this tool has. */
class RecommendSkillError extends Error {}

/**
 * The tool's validated output, structurally the design's result contract. The
 * `execute` body always writes `advisory: true`; the field is typed `boolean`
 * here because this interface also describes the schema-validated value the
 * `render` callback receives.
 */
interface RecommendSkillOutput {
  status: SkillRecommendationResult['status']
  recommendations: Array<{ name: string; relevance: number; prerequisitesMet: number }>
  decisionIds: string[]
  advisory: boolean
}

/**
 * The calling agent's workspace directory, read structurally. A host that
 * exposes none simply reads the scope's global catalog — no `process.cwd()`
 * guess, which could silently judge a different directory's skills.
 * @param agent - the calling agent.
 * @returns the session header cwd, or `undefined`.
 */
function cwdOf(agent: Agent): string | undefined {
  try {
    const session = (agent as { readonly session?: { readonly header?: { readonly cwd?: unknown } } }).session
    const cwd = session?.header?.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
  } catch {
    return undefined
  }
}

/**
 * Map one catalog summary to the recommendation consumer's descriptor
 * (design § "Candidate eligibility and complete state": take only the fields
 * that already exist, omit the rest, assume no undeclared capability).
 *
 * `modelInvocable` is `false` only for an explicit `false`: the catalog's
 * policy is resolved by the skill registry, and an absent policy permits model
 * invocation. User-invocable-only and invocation-forbidden skills are excluded
 * from the pool later, by name, in `pool.ts`.
 * @param candidate - one `SkillSummary` from `ctx.skills.list()`.
 * @returns the descriptor the pool consumes.
 */
export function toDescriptor(candidate: SkillSummary): SkillDescriptor {
  const invocation = (candidate as { readonly invocation?: { readonly modelInvocable?: unknown } }).invocation
  return {
    name: candidate.name,
    ...typeof candidate.description === 'string' ? { description: candidate.description } : {},
    ...typeof candidate.whenToUse === 'string' ? { whenToUse: candidate.whenToUse } : {},
    source: typeof candidate.source === 'string' ? candidate.source : 'unknown',
    modelInvocable: invocation?.modelInvocable !== false,
  }
}

/**
 * Read the scope's catalog for the calling agent. Guarded on purpose: a missing
 * skills service, a provider fault or a malformed observation is `unavailable`
 * (§ "Cache, privacy, and failure table"), never a thrown tool error.
 * `ctx.skills.get()` is deliberately never called — no body is ever loaded.
 * @param ctx - the plugin context carrying the skills registry.
 * @param actor - the calling agent, structurally.
 * @returns the mapped descriptors, or `undefined` when the catalog is unreadable.
 */
async function listCandidates(ctx: Context, actor: object): Promise<readonly SkillDescriptor[] | undefined> {
  try {
    const registry = ctx.skills as { list?: (options: unknown) => Promise<unknown> } | undefined
    if (typeof registry?.list !== 'function') return undefined
    const agent = actor as Agent
    const cwd = cwdOf(agent)
    const candidates = await registry.list({
      ...cwd === undefined ? {} : { cwd },
      scope: actor,
    })
    if (!Array.isArray(candidates)) return undefined
    return (candidates as SkillSummary[]).map(candidate => toDescriptor(candidate))
  } catch {
    return undefined
  }
}

/**
 * The fixed model-facing copy (design § "Settings and tool contract": display
 * copy comes from a fixed template and notes that existing explicit
 * instructions still apply; no generated rationale is ever returned).
 * @param value - the validated tool result.
 * @returns the rendered text block content.
 */
export function renderRecommendationText(value: RecommendSkillOutput): string {
  const advisory = 'Explicit skill choices from the user or from higher-level instructions still apply and take precedence.'
  switch (value.status) {
    case 'off':
      return `Skill recommendation is off. Choose skills from the catalog as you normally would. ${advisory}`
    case 'shadow':
      return `Skill recommendation ran in shadow mode: the judgment is recorded for audit only and no names are returned. `
        + `Choose skills from the catalog as you normally would. ${advisory}`
    case 'cancelled':
      return `Skill recommendation was cancelled; nothing was recommended and no skill was loaded. ${advisory}`
    case 'unavailable':
      return `Skill recommendation is unavailable for this task. The full catalog is still available and nothing was `
        + `loaded on your behalf. ${advisory}`
    case 'recommended': {
      if (value.recommendations.length === 0) {
        return `No visible skill met the relevance and prerequisite thresholds for this task. The full catalog is `
          + `still available. ${advisory}`
      }
      const listed = value.recommendations
        .map(entry => `${entry.name} (relevance ${entry.relevance.toFixed(1)}, prerequisites ${entry.prerequisitesMet.toFixed(2)})`)
        .join(', ')
      return `Advisory skill recommendations for this task: ${listed}. These are suggestions only: load a skill through `
        + `the normal skill tool, which still resolves the name and applies the original invocation rules. ${advisory}`
    }
  }
}

/**
 * The model-facing tool definition. Parameters are exactly `task`: the caller
 * cannot pass a catalog, path-activation results, invocation permissions or a
 * scope (design § "Settings and tool contract").
 * @param runtime - the recommendation runtime for this plugin fiber.
 * @returns the definition registered on `ctx.tools`.
 */
function toolDefinition(runtime: RecommendationRuntime) {
  return defineTool({
    name: RECOMMEND_SKILL_NAME,
    description: 'Ask which visible skills fit a task, before choosing one. Read-only and advisory: it returns a few '
      + 'skill names with relevance and prerequisite evidence, and never loads, runs or invokes a skill. Explicit skill '
      + 'instructions from the user or higher-level rules always take precedence over its suggestions.',
    parameters: {
      task: {
        type: 'string',
        required: true,
        description: 'What the work to be done is, in one or two sentences.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: {
            type: 'string',
            required: true,
            enum: ['off', 'shadow', 'recommended', 'unavailable', 'cancelled'],
          },
          recommendations: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                relevance: { type: 'number', required: true },
                prerequisitesMet: { type: 'number', required: true },
              },
            },
          },
          decisionIds: { type: 'array', required: true, items: { type: 'string' } },
          advisory: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderRecommendationText(value) }],
    },
    execute: async (args, exec: ToolRunContext): Promise<RecommendSkillOutput> => {
      // Required non-empty by contract; a blank task names no work to judge.
      if (args.task.trim().length === 0) {
        throw new RecommendSkillError('task must be a non-empty description of the work to be done')
      }
      const result = await runtime.recommend({
        task: args.task,
        actor: exec.agent,
        signal: exec.signal,
      })
      return {
        status: result.status,
        recommendations: result.recommendations.map(entry => ({
          name: entry.name,
          relevance: entry.relevance,
          prerequisitesMet: entry.prerequisitesMet,
        })),
        decisionIds: [...result.decisionIds],
        advisory: true,
      }
    },
    presentCall: (args): ToolCallView =>
      ({ card: 'generic', title: 'Recommend a skill', kind: 'read', rawInput: args.task }),
  })
}

/**
 * Mount the recommendation plugin: settings namespace, runtime and tool.
 * @param ctx - the plugin context (declares `skills` and `tools`).
 */
export function apply(ctx: Context): void {
  const warn = (message: string): void => {
    try {
      ctx.logger.warn(message)
    } catch {
      // An absent logger must not break a tool call.
    }
  }
  const reporter = createWarnOnce(warn)
  const readSettings: RecommendationSettingsReader = registerRecommendationSettings(ctx, reporter)
  const cache = new RecommendationCache<RecommendationOutcome>({
    // Both knobs are live settings: a mid-session change applies to the next call.
    limits: () => {
      const settings = readSettings() ?? DEFAULT_RECOMMENDATION_SETTINGS
      return { maxEntries: settings.cacheEntries, ttlMs: settings.cacheTtlMs }
    },
  })
  const runtime = createRecommendationRuntime({
    readSettings,
    listCandidates: actor => listCandidates(ctx, actor),
    host: ctx as unknown as SkillRecommendationHostFace,
    cache,
    warn,
  })
  const unregister = ctx.tools.register(toolDefinition(runtime))
  // Unload: abort in-flight judgments (their waiters resolve cancelled), clear
  // the cache and remove the tool — the design's rollback path.
  ctx.effect(() => () => {
    runtime.dispose()
    unregister()
  }, 'skill-recommender: unload')
}
