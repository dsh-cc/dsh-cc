/**
 * Model-facing `manage_skill` tool: create/update/delete/list learned skills
 * under `$DSH_HOME/learned-skills/` through the shared `LearnedSkillStore`
 * (§4.6 of docs/plans/2026-09-23-learned-skills.md). The `cc-learn.enabled`
 * gate is read at call time; a successful mutation emits the package-private
 * `skills/learned-changed` cordis event so the skill registry invalidates its
 * collect cache (§4.5).
 * @module @dsh-cc/tool-manage-skill
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { LearnedSkillStore } from '@dsh-cc/skill-loader'
import { defineTool } from '@dsh-cc/tools'
import type { ToolRunContext } from '@dsh-cc/tools'

export const name = 'tool-manage-skill'
export const inject = ['tools', 'skills']

/** Raw `cc-learn` settings section: tolerant, unknown siblings pass through. */
type LearnSection = {
  enabled?: unknown
  [key: string]: unknown
}

/** Model-visible failure (maps to an isError tool result carrying the code word). */
class ManageSkillError extends Error {}

/** Whether the `cc-learn` gate is on: default enabled when the section is absent. */
function gateEnabled(section: LearnSection | undefined): boolean {
  return section?.enabled !== false
}

/** Tool arguments: one action plus optional per-action fields. */
export interface ManageSkillArgs {
  action: 'create' | 'update' | 'delete' | 'list'
  name?: string
  description?: string
  body?: string
}

/** Validate per-action required params; `undefined` when complete. */
function missingParams(args: ManageSkillArgs): string | undefined {
  const has = (value: string | undefined): value is string => typeof value === 'string' && value.length > 0
  switch (args.action) {
    case 'create':
      if (!has(args.name) || !has(args.description) || !has(args.body)) {
        return 'create requires name, description and body'
      }
      return undefined
    case 'update':
      if (!has(args.name)) return 'update requires name'
      if (!has(args.body) && !has(args.description)) return 'update requires a body or description'
      return undefined
    case 'delete':
      if (!has(args.name)) return 'delete requires name'
      return undefined
    case 'list':
      return undefined
    default:
      return `unknown action ${JSON.stringify(args.action)}`
  }
}

export function apply(ctx: Context): void {
  // Gate read at call time: capture the (possibly absent) settings service at
  // apply time, resolve the live section on every call (headless fallback: enabled).
  let settings: { get(ns: string): unknown } | undefined
  ctx.inject(['settings'], (sctx) => {
    settings = (sctx as unknown as { settings?: unknown }).settings as
      | { get(ns: string): unknown }
      | undefined
  })

  const store = new LearnedSkillStore({
    dshHome: resolveDshHome(),
    listClaimants: async () => {
      const skills = (await ctx.skills.list({ cwd: process.cwd() })) as readonly SkillSummary[]
      return skills.map(c => ({ name: c.name, provider: c.provider, source: c.source }))
    },
    onChanged: () => {
      ctx.emit('skills/learned-changed')
    },
  })

  const tool = defineTool({
    name: 'manage_skill',
    description:
      'Create, update, delete, or list learned skills — durable, reusable procedural lessons distilled from this '
      + 'project\'s sessions. Promote only procedural, repeatable lessons ("how to do X here"): workflows, gotchas, '
      + 'command sequences. Facts, credentials, and secrets stay in memory, never in a learned skill. '
      + 'Actions: `create` (requires name — lowercase-kebab, description, body), `update` (requires name plus at '
      + 'least one of body/description; other frontmatter keys are preserved), `delete` (requires name; removes '
      + 'the whole skill), `list` (no arguments — enumerate learned skills). The name must match '
      + '^[a-z0-9][a-z0-9-]{0,63}$.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'One of create, update, delete, list.',
      },
      name: { type: 'string', description: 'Learned-skill name (lowercase kebab). Required for create/update/delete.' },
      description: { type: 'string', description: 'Model-facing one-line description. Required for create; optional for update.' },
      body: { type: 'string', description: 'Markdown skill body. Required for create; optional for update.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value: { message: string }) => [{ type: 'text', text: value.message }],
    },
    // Mutations touch the shared learned root: never overlap.
    isConcurrencySafe: () => false,
    async execute(args: ManageSkillArgs, _exec: ToolRunContext): Promise<{ message: string }> {
      const section = settings?.get('cc-learn') as LearnSection | undefined
      if (!gateEnabled(section)) {
        return { message: 'manage_skill is disabled (`cc-learn.enabled` is false in settings).' }
      }
      const missing = missingParams(args)
      if (missing !== undefined) {
        throw new ManageSkillError(`manage_skill invalid_params: ${missing}`)
      }
      const today = new Date().toISOString().slice(0, 10)
      switch (args.action) {
        case 'create': {
          const result = await store.create({
            name: args.name!,
            description: args.description!,
            learnedFrom: `manage_skill ${today}`,
            body: args.body!,
          })
          if (!result.ok) throw new ManageSkillError(`manage_skill ${result.code}: ${result.detail}`)
          return { message: `created learned skill ${args.name} (${result.value.bytes} B) at ${result.value.path}` }
        }
        case 'update': {
          const result = await store.update({
            name: args.name!,
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.body !== undefined ? { body: args.body } : {}),
          })
          if (!result.ok) throw new ManageSkillError(`manage_skill ${result.code}: ${result.detail}`)
          return { message: `updated learned skill ${args.name} (${result.value.bytes} B) at ${result.value.path}` }
        }
        case 'delete': {
          const result = await store.delete(args.name!)
          if (!result.ok) throw new ManageSkillError(`manage_skill ${result.code}: ${result.detail}`)
          return { message: `deleted learned skill ${args.name} (directory of ${result.value.path})` }
        }
        case 'list': {
          const result = await store.list()
          if (!result.ok) throw new ManageSkillError(`manage_skill ${result.code}: ${result.detail}`)
          if (result.value.length === 0) return { message: 'no learned skills' }
          return {
            message: result.value
              .map(entry => `${entry.name} — ${entry.description} (${entry.bytes} B) — ${entry.path}`)
              .join('\n'),
          }
        }
      }
    },
  })
  ctx.tools.register(tool as unknown as Parameters<typeof ctx.tools.register>[0])
}
