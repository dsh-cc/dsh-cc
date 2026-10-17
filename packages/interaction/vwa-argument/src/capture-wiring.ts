/**
 * Turn-seam capture wiring (design docs/plans/2026-10-16-vwa-evidence-argument.md
 * §10.3): projects the host tool pipeline's `tools/post-execute` results into
 * a per-SESSION {@link CaptureRegistry}, and reads bound-artifact bytes from
 * the caller's workspace.
 *
 * - `read`/`write`/`edit`: the event bytes are the file's bytes on disk right
 *   after the successful call (what the read returned / what the write left).
 * - `web_fetch`: the event bytes are the result's text content; it has no
 *   file path, so it is keyed by its URL and only participates through the
 *   byte-identical write/edit upgrade rule.
 *
 * Fail-soft by contract: the listener always returns the downstream decision
 * and never throws into the waterfall. Memory is bounded per session.
 *
 * @module @dsh-cc/vwa-argument/capture-wiring
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { CaptureRegistry, type CaptureEvent } from './sources.ts'
import { validateArtifactPath } from './artifact.ts'

const FILE_TOOLS = new Set(['read', 'write', 'edit'])
const MAX_EVENT_BYTES = 8 * 1024 * 1024
/** Per-session cap on retained events; the oldest are dropped first. */
export const MAX_EVENTS_PER_SESSION = 512

/** Session id of an agent (agent.session.id, else agent.id); undefined → no session. */
export function sessionKeyOf(agent: unknown): string | undefined {
  const value = agent as { id?: unknown; session?: { id?: unknown } } | undefined
  const key = value?.session?.id ?? value?.id
  return key === undefined ? undefined : String(key)
}

/** Per-session capture registries; an agent never sees another session's events. */
export class SessionCaptures {
  private readonly bySession = new Map<string, CaptureRegistry>()

  /** The registry of the calling agent's session (a fresh empty one when unknown). */
  for(agent: unknown): CaptureRegistry {
    const key = sessionKeyOf(agent)
    if (key === undefined) return new CaptureRegistry()
    let registry = this.bySession.get(key)
    if (registry === undefined) {
      registry = new CaptureRegistry(MAX_EVENTS_PER_SESSION)
      this.bySession.set(key, registry)
    }
    return registry
  }

  clear(): void {
    this.bySession.clear()
  }
}

interface PostExecuteExec { name: string; arguments: unknown; agent?: unknown }
interface PostExecuteResult { isError: boolean; content?: { type: string; text?: string }[] }

/** Project one successful tool result into a capture event (undefined → not a capture). */
export function captureEventOf(
  exec: PostExecuteExec,
  result: PostExecuteResult,
  workspaceRoot: string | undefined,
  at: string = new Date().toISOString(),
): CaptureEvent | undefined {
  if (result.isError) return undefined
  const args = (exec.arguments ?? {}) as Record<string, unknown>
  if (FILE_TOOLS.has(exec.name)) {
    const raw = args.file_path
    if (typeof raw !== 'string' || raw.length === 0) return undefined
    const path = isAbsolute(raw) ? raw : workspaceRoot === undefined ? undefined : resolve(workspaceRoot, raw)
    if (path === undefined) return undefined
    try {
      if (statSync(path).size > MAX_EVENT_BYTES) return undefined
      return { tool: exec.name as CaptureEvent['tool'], path: resolve(path), bytes: readFileSync(path), at }
    } catch {
      return undefined
    }
  }
  if (exec.name === 'web_fetch') {
    const url = args.url
    if (typeof url !== 'string' || url.length === 0) return undefined
    const text = (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')
    const bytes = Buffer.from(text, 'utf8')
    if (bytes.length === 0 || bytes.length > MAX_EVENT_BYTES) return undefined
    return { tool: 'web_fetch', path: url, bytes, at }
  }
  return undefined
}

/**
 * Register the `tools/post-execute` projection. Never throws into the
 * waterfall; returns the listener disposer.
 */
export function registerCaptureWiring(
  ctx: Context,
  captures: SessionCaptures,
  workspaceRoot: (agent: unknown) => string | undefined,
): () => void {
  return ctx.on('tools/post-execute' as never, (async (exec: PostExecuteExec, result: PostExecuteResult, next: () => Promise<unknown>) => {
    const decision = await next()
    try {
      const event = captureEventOf(exec, result, workspaceRoot(exec.agent))
      if (event !== undefined && sessionKeyOf(exec.agent) !== undefined) captures.for(exec.agent).record(event)
    } catch {
      // Capture projection is advisory; never break the tool pipeline.
    }
    return decision
  }) as never) as unknown as () => void
}

/**
 * Read a bound artifact's text from the caller's workspace (§10.5/§12): the
 * path is the workspace-relative artifact path (validateArtifactPath rules),
 * and its realpath must stay inside the realpath of the root.
 */
export function readWorkspaceArtifact(root: string, path: string): string | undefined {
  validateArtifactPath(path)
  try {
    const rootReal = realpathSync(root)
    const real = realpathSync(resolve(rootReal, path))
    if (!real.startsWith(rootReal + sep)) return undefined
    return readFileSync(real, 'utf8')
  } catch {
    return undefined
  }
}
