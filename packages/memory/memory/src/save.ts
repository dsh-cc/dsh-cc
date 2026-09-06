/**
 * The `memory_save` tool: the model-facing save channel for the memory
 * directory.
 *
 * Direct `write`/`edit` calls aimed at the memory directory always fail — it
 * lives in the harness home, outside every session workspace, so the fs
 * sandbox fences them. This tool is the working alternative: the model passes
 * structured fields, the plugin generates the frontmatter, maintains the
 * MEMORY.md pointer, and writes host-side under a per-call policy confined to
 * the memory directory (see `writeback.ts`).
 * @module @dsh-cc/memory/save
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { defineTool } from '@dsh-cc/tools'
import { MEMORY_TYPES } from './types.ts'
import { ENTRYPOINT_NAME } from './truncate.ts'
import { validateMemoryWrites, writeMemoryFiles } from './writeback.ts'
import { cwdOf, resolveWorkspaceMemoryDir } from './paths.ts'
import type { MemorySection } from './section.ts'

/** The registered tool name. */
export const MEMORY_SAVE_TOOL = 'memory_save'

/** Topic slugs are kebab-case; the file is `<name>.md`. */
const NAME_RULE = /^[a-z0-9][a-z0-9-]*$/
/** One-line relevance description cap. */
const MAX_DESCRIPTION_CHARS = 200

/** Where a saved memory lands. */
export const MEMORY_SAVE_SCOPES = ['workspace', 'global'] as const

/** A model-visible save failure (maps to an isError tool result). */
export class MemorySaveError extends Error {}

export interface MemorySaveArgs {
  /** Kebab-case topic slug; the topic file is `<name>.md`. */
  name: string
  /** One of the four memory types. */
  type: string
  /** One-line relevance description for the MEMORY.md pointer. */
  description: string
  /** Markdown body (frontmatter is generated host-side). */
  body: string
  /** `workspace` (default) saves to this workspace's directory; `global` saves to the cross-workspace directory. */
  scope?: string
}

/** Assemble the topic file body with rationalized frontmatter. */
export function renderTopicFile(args: MemorySaveArgs): string {
  return [
    '---',
    `name: ${args.name}`,
    `description: ${args.description}`,
    `type: ${args.type}`,
    '---',
    '',
    args.body.trimEnd(),
    '',
  ].join('\n')
}

/** The MEMORY.md pointer line for one topic (mirrors the section's index format). */
export function pointerLine(args: MemorySaveArgs): string {
  return `- [${args.name}](${args.name}.md) — ${args.description}`
}

/**
 * Upsert the topic's pointer in the MEMORY.md body: replace the line whose
 * link target is `<name>.md`, append otherwise.
 */
export function upsertPointer(entrypoint: string, args: MemorySaveArgs): string {
  const line = pointerLine(args)
  const target = `](${args.name}.md)`
  const lines = entrypoint.split('\n')
  const at = lines.findIndex(l => l.includes(target))
  if (at >= 0) {
    lines[at] = line
    return lines.join('\n')
  }
  const trimmed = entrypoint.trimEnd()
  return trimmed.length > 0 ? `${trimmed}\n${line}\n` : `${line}\n`
}

function validateArgs(args: MemorySaveArgs): void {
  if (!NAME_RULE.test(args.name)) {
    throw new MemorySaveError(
      `invalid memory name "${args.name}": use a kebab-case slug (lowercase letters, digits, dashes)`,
    )
  }
  if (args.name.toLowerCase() === 'memory') {
    throw new MemorySaveError('the name "memory" is reserved for the MEMORY.md index')
  }
  if (!(MEMORY_TYPES as readonly string[]).includes(args.type)) {
    throw new MemorySaveError(`invalid memory type "${args.type}": use one of ${MEMORY_TYPES.join(', ')}`)
  }
  if (args.description.trim().length === 0 || args.description.includes('\n')) {
    throw new MemorySaveError('description must be a single non-empty line')
  }
  if (args.description.length > MAX_DESCRIPTION_CHARS) {
    throw new MemorySaveError(`description is ${args.description.length} chars, over the ${MAX_DESCRIPTION_CHARS} cap`)
  }
  if (args.body.trim().length === 0) {
    throw new MemorySaveError('body must not be empty')
  }
  if (args.scope !== undefined && !(MEMORY_SAVE_SCOPES as readonly string[]).includes(args.scope)) {
    throw new MemorySaveError(`invalid memory scope "${args.scope}": use one of ${MEMORY_SAVE_SCOPES.join(', ')}`)
  }
}

/**
 * Register the `memory_save` tool. No-op when the host has no tools service
 * or no fs seam (a providerless host keeps memory read-only).
 * @param ctx - the host context.
 * @param home - the memory home: the global directory and the root under
 *   which each workspace's private directory lives (`projects/<slug>`).
 * @param section - the memory section to refresh after a successful save.
 * @returns the registration disposer, or `undefined` when not registered.
 */
export function registerMemorySaveTool(
  ctx: Context,
  home: string,
  section: MemorySection,
): (() => void) | undefined {
  const tools = ctx.get('tools') as { register(def: unknown): () => void } | undefined
  if (tools === undefined) return undefined
  return tools.register(defineTool({
    name: MEMORY_SAVE_TOOL,
    description:
      'Save a durable memory (a fact or preference useful in FUTURE conversations) to the persistent memory '
      + 'system. By default the memory is private to the current workspace; pass `scope: "global"` for facts '
      + 'useful across all workspaces. Writes the topic file and updates the MEMORY.md index for you. This is '
      + 'the ONLY way to save memories: direct write/edit calls to a memory directory are fenced by the '
      + 'sandbox and always fail. Do not use it for ephemeral task detail.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Kebab-case topic slug, e.g. "user-profile". The topic file is `<name>.md`; saving an existing name overwrites it.',
      },
      type: {
        type: 'string',
        enum: MEMORY_TYPES,
        required: true,
        description: 'user: who the user is; feedback: how the user wants you to work; project: ongoing work state; reference: pointers to external resources.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'One-line relevance note shown in the MEMORY.md index (max 200 chars).',
      },
      body: {
        type: 'string',
        required: true,
        description: 'Markdown body of the memory (without frontmatter — it is generated for you).',
      },
      scope: {
        type: 'string',
        enum: MEMORY_SAVE_SCOPES,
        description: 'workspace (default): visible only to sessions in the current workspace. global: visible to every workspace.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args: MemorySaveArgs, value: { path: string; message: string }) =>
        [{ type: 'text', text: value.message }],
    },
    isConcurrencySafe: () => false,
    async execute(args: MemorySaveArgs, exec: { agent?: Agent }) {
      const fs = ctx.get('fs') as FileSystem | undefined
      if (fs === undefined) throw new MemorySaveError('memory save unavailable: no fs seam')
      validateArgs(args)
      const dir = args.scope === 'global'
        ? home
        : resolveWorkspaceMemoryDir(home, exec.agent !== undefined ? cwdOf(exec.agent) : process.cwd())
      const filename = `${args.name}.md`
      const writes = [
        { path: filename, content: renderTopicFile(args) },
      ]
      // Reuse the write-back validator so tool saves and fork reports share
      // one security boundary (filename rule + size caps).
      const validated = validateMemoryWrites({ writes })
      // Upsert the index pointer first from the CURRENT entrypoint body, then
      // write both files under the policy confined to the memory directory.
      let entrypoint = ''
      try {
        entrypoint = await fs.readText(await fs.resolve(join(dir, ENTRYPOINT_NAME)))
      } catch {
        // No index yet — the upsert starts from an empty body.
      }
      validated.push({ path: ENTRYPOINT_NAME, content: upsertPointer(entrypoint, args) })
      await writeMemoryFiles(fs, dir, validated)
      await section.refresh(exec.agent)
      return {
        path: join(dir, filename),
        message: `Saved memory "${args.name}" (${args.type}) to ${filename} and updated ${ENTRYPOINT_NAME}.`,
      }
    },
  }))
}
