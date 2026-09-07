/**
 * Human-facing `/memory` command: list the memdir memory files (name, type,
 * first line) or print one memory's body by name, reading through `ctx.fs`.
 * @module @dsh-cc/command-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import {
  scanMemoryDirectory,
  parseMemoryFile,
  resolveMemoryHome,
  resolveProjectMemoryRoot,
  type MemoryDirectoryState,
  type MemoryIndexEntry,
} from '@dsh-cc/memory'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { helpable } from '@dsh-cc/command-usage'
import { firstLine, formatIndex, formatMemory, type MemoryIndexLine } from './memory.ts'

export const name = 'command-memory'
export const inject = ['commands', 'fs']

/** `/memory` configuration: an explicit memory directory override. */
export interface Config {
  /** Memory directory root; defaults to the harness/home memory dir. */
  readonly memoryHome?: string
}

/** Resolve the memory directory: configured home, else project root, else default home. */
async function resolveDir(ctx: Context, config: Config, cwd: string): Promise<string> {
  if (config.memoryHome !== undefined && config.memoryHome.length > 0) return config.memoryHome
  const projectRoot = await resolveProjectMemoryRoot(ctx, cwd).catch(() => undefined)
  return projectRoot ?? resolveMemoryHome()
}

/** Read a topic's parsed body by its recorded display path, or undefined on failure. */
async function readTopicBody(fs: FileSystem, path: string): Promise<string | undefined> {
  try {
    const target = await fs.resolve(path)
    const raw = await fs.readText(target)
    return parseMemoryFile(raw)?.body
  } catch {
    return undefined
  }
}

/** Build the enriched index lines for a scanned directory (reading bodies). */
async function indexLines(fs: FileSystem, state: MemoryDirectoryState): Promise<MemoryIndexLine[]> {
  const lines: MemoryIndexLine[] = []
  for (const entry of state.topics) {
    const body = await readTopicBody(fs, entry.path)
    const name = entry.frontmatter.name
    let type: string | undefined
    for (const t of ['user', 'feedback', 'project', 'reference'] as const) {
      if (entry.frontmatter.type === t) { type = t; break }
    }
    const line: MemoryIndexLine = {
      name,
      ...type === undefined ? {} : { type },
      firstLine: body === undefined
        ? entry.frontmatter.description
        : firstLine(body),
    }
    lines.push(line)
  }
  lines.sort((a, b) => a.name.localeCompare(b.name))
  return lines
}

/** Find a fully-loaded memory (topic + body) by name or filename. */
async function findLoadedTopic(
  fs: FileSystem,
  state: MemoryDirectoryState,
  query: string,
): Promise<{ entry: MemoryIndexEntry; body: string | undefined } | undefined> {
  const lowered = query.trim().toLowerCase()
  const entry = state.topics.find(candidate =>
    candidate.frontmatter.name.toLowerCase() === lowered
    || candidate.filename.replace(/\.md$/u, '').toLowerCase() === lowered)
  if (entry === undefined) return undefined
  return { entry, body: await readTopicBody(fs, entry.path) }
}

/** Execute `/memory [name]`. */
async function executeMemory(
  ctx: Context,
  config: Config,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const cwd = invocation.agent.session.header.cwd ?? process.cwd()
  const dir = await resolveDir(ctx, config, cwd)
  const state = await scanMemoryDirectory(ctx.fs, dir, invocation.signal)
  const name = invocation.rawInput.trim()
  if (name.length === 0) {
    const lines = await indexLines(ctx.fs, state)
    return { kind: 'success', text: formatIndex(dir, lines) }
  }
  const loaded = await findLoadedTopic(ctx.fs, state, name)
  if (loaded === undefined) {
    return { kind: 'success', text: `No memory named "${name}".` }
  }
  const { entry, body } = loaded
  return {
    kind: 'success',
    text: formatMemory(
      entry.frontmatter.name,
      entry.filename,
      entry.frontmatter.type,
      entry.frontmatter.description,
      body ?? '(unreadable)',
    ),
  }
}

/**
 * Register the `/memory` command for every composed command adapter.
 * @param ctx - context carrying the command registry and filesystem service.
 * @param config - memory directory override.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.commands.register(helpable({
    name: 'memory',
    description: 'list memory files (name, type, first line) or show one by name',
    input: { hint: '[name]' },
    handler: (invocation: CommandInvocation) => executeMemory(ctx, config, invocation),
  }))
}
