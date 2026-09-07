/**
 * Human-facing `/export` command: writes the current session transcript to a
 * file through `ctx.fs` as markdown (default) or lossless JSON.
 * @module @dsh-cc/command-export
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import z from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { renderTranscript, type ExportFormat } from './transcript.ts'
import { helpable } from '@dsh-cc/command-usage'

export const name = 'command-export'
export const inject = ['commands', 'fs']

/** `/export` configuration: the default export directory. */
export interface Config {
  /** Directory written to when no output path is supplied. */
  readonly defaultDir: string
}

/** Loader schema; an empty default directory falls back to the current working directory. */
export const Config = z.object({
  defaultDir: z.string().default(''),
})

/** One parsed `/export` invocation. */
export interface ExportRequest {
  readonly format: ExportFormat
  /** Exact output path after the format token, or undefined to use the default directory. */
  readonly path: string | undefined
}

/**
 * Parse the `/export` argument line into a format and optional path.
 * @param rawInput - exact text following the command name.
 * @returns the parsed format and path (or undefined when no path was supplied).
 */
export function parseExport(rawInput: string): ExportRequest {
  const tokens = rawInput.trim().split(/\s+/u).filter(token => token.length > 0)
  let format: ExportFormat = 'markdown'
  const rest: string[] = []
  for (const token of tokens) {
    if (format === 'markdown' && token.startsWith('json') && !rest.includes(token)) format = 'json'
    else rest.push(token)
  }
  return { format, path: rest.length === 0 ? undefined : rest.join(' ') }
}

/** File extension per export format. */
const EXTENSION: Record<ExportFormat, string> = { markdown: '.md', json: '.json' }

/** The default output file name derived from the session id. */
function defaultName(sessionId: string): string {
  return `transcript-${sessionId.replace(/[^a-zA-Z0-9._-]/u, '-')}`
}

/**
 * Split an output path into directory and file components, applying the format
 * extension and the default directory when either part is absent.
 * @param config - command configuration carrying the default directory.
 * @param request - parsed invocation.
 * @param sessionId - owning session id used for the default file name.
 * @returns the resolved directory and file name.
 */
export function resolveOutput(config: Config, request: ExportRequest, sessionId: string): {
  dir: string
  name: string
} {
  const ext = EXTENSION[request.format]
  const name = defaultName(sessionId)
  if (request.path === undefined) return { dir: config.defaultDir, name: `${name}${ext}` }
  const trimmed = request.path.trim()
  if (trimmed.length === 0) return { dir: config.defaultDir, name: `${name}${ext}` }
  if (trimmed.endsWith('/')) return { dir: trimmed.replace(/\/+$/u, ''), name: `${name}${ext}` }
  const slash = trimmed.lastIndexOf('/')
  const dir = slash === -1 ? config.defaultDir : trimmed.slice(0, slash)
  const base = slash === -1 ? trimmed : trimmed.slice(slash + 1)
  const tail = base.endsWith(ext) ? base : `${base}${ext}`
  return { dir, name: tail }
}

/** Execute `/export`, writing the transcript through the filesystem service. */
async function executeExport(
  ctx: Context,
  config: Config,
  request: ExportRequest,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const events = invocation.agent.session.events
  const sessionId = invocation.agent.session.id
  const { dir, name } = resolveOutput(config, request, sessionId)
  const target = await ctx.fs.resolve(joinPath(dir, name))
  const content = renderTranscript(events, request.format, sessionId)
  await ctx.fs.writeText(target, content)
  return {
    kind: 'success',
    text: `Exported ${request.format} transcript to ${ctx.fs.processPath(target)} (${content.length} bytes).`,
  }
}

/** Join a directory and file name into a single path without a trailing duplicate slash. */
function joinPath(dir: string, name: string): string {
  if (dir.length === 0) return name
  return `${dir.replace(/\/+$/u, '')}/${name}`
}

/**
 * Register the `/export` command for every composed command adapter.
 * @param ctx - context carrying the command registry and filesystem service.
 * @param config - default export directory.
 */
export function apply(ctx: Context, config: Config): void {
  // Native /export comes from @deepseek-ai/dsh-session-log-export, mounted by
  // dsh-web-app's session-log-download row on the WEB profile (a browser-download
  // stub); it is absent on CLI-only profiles. We defer to it where the name is
  // taken and register our file-writing /export only where it is free. Whether
  // the native command is present is a property of the active runtime profile,
  // not of any particular package version, and may change across releases.
  //
  // This behaviour depends on mount-order luck: bundles mount after base/web-app
  // rows, so ours registers LAST — the native command is already registered on
  // web when we get here, absent when not. Relies on the loader throwing a plain
  // Error whose message matches /is already registered/ for a duplicate name.
  try {
    ctx.commands.register(helpable({
      name: 'export',
      description: 'export this session transcript to a markdown or json file',
      input: { hint: '[json] [<path>]' },
      handler: (invocation: CommandInvocation) => executeExport(ctx, config, parseExport(invocation.rawInput), invocation),
    }))
  } catch (error: unknown) {
    if (error instanceof Error && /is already registered/.test(error.message)) {
      ctx.logger.info('native /export present, ours skipped')
      return
    }
    throw error
  }
}
