/**
 * Semantic translation of Claude Code skill frontmatter onto harness seams.
 *
 * This module turns the parsed fields into actionable harness primitives:
 * an `allowed-tools` allow-list into a `tools.restrict()` filter, `paths` into a
 * conditional-activation matcher wired onto `fs/observed`, and the execution
 * controls a consumer forwards to `ctx.subagents`. Translation is pure where it
 * can be; only path activation registers a listener.
 *
 * @module
 */

import { relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FsObservation, FsTarget } from '@deepseek-ai/dsh-fs'
import { translateToolNames, type ToolRestriction } from '@dsh-cc/tools'

/** Mutating first-party fs tools that should trigger path activation. */
const TOUCH_TOOLS = new Set(['read', 'write', 'edit'])

/**
 * Build an allow-only tool restriction from a Claude Code `allowed-tools` list.
 * Names are translated leniently via {@link translateToolNames}: known CC names
 * map to harness names (e.g. `Read` → `read` + `read_image`), names already in
 * the harness registry pass through, and any unknown name is dropped — with a
 * diagnostic — rather than crashing the session, because skill activation is
 * user/model-driven. Arg-spec parens are stripped (name-level gate only), and
 * every input dropping to nothing yields `undefined` (no restriction). A `*`
 * entry (allow every tool) and an empty/missing list also produce `undefined`,
 * meaning no restriction applies; the skill then inherits the caller's surface.
 * Consumers apply the returned filter via `ctx.tools.restrict()` at activation.
 * @param allowedTools - parsed `allowed-tools` names, or undefined when absent.
 * @param onDiagnostic - invoked for each dropped name; defaults to a no-op.
 * @returns an allow-only restriction, or `undefined` when nothing to restrict.
 */
export function ccRestriction(
  allowedTools: readonly string[] | undefined,
  onDiagnostic?: (message: string) => void,
): ToolRestriction | undefined {
  if (allowedTools === undefined || allowedTools.length === 0) return undefined
  if (allowedTools.includes('*')) return undefined
  const translated = translateToolNames(allowedTools, 'lenient', onDiagnostic)
  if (translated === undefined) return undefined
  return { allow: translated }
}

/**
 * Build a gitignore-style path matcher over Claude Code `paths` patterns.
 * Patterns are matched against PROJECT-RELATIVE paths (the same base a
 * `.gitignore` uses). A bare directory pattern matches that directory and
 * everything beneath it; `**` spans any number of path segments; `*` and `?`
 * match within one segment.
 * @param patterns - parsed `paths` patterns.
 * @returns a matcher returning whether a project-relative path matches.
 */
export function ccPathMatcher(patterns: readonly string[]): (path: string) => boolean {
  const matchers = patterns
    .map(pattern => globToRegex(pattern))
    .filter((regex): regex is RegExp => regex !== undefined)
  return (path: string): boolean => {
    const normalized = path.replaceAll('\\', '/')
    return matchers.some(regex => regex.test(normalized))
  }
}

function globToRegex(pattern: string): RegExp | undefined {
  if (pattern.length === 0) return undefined
  let out = '^'
  let i = 0
  const n = pattern.length
  while (i < n) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the loop bound proves the index exists.
    const char = pattern[i]!
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches any number of leading components (possibly none).
        if (pattern[i + 2] === '/') {
          out += '(?:[^/]+/)*'
          i += 3
          continue
        }
        out += '.*'
        i += 2
        continue
      }
      out += '[^/]*'
      i += 1
      continue
    }
    if (char === '?') {
      out += '[^/]'
      i += 1
      continue
    }
    const escaped = /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char
    out += escaped
    i += 1
  }
  // A pattern naming a directory (or a file) also matches beneath it, matching
  // the `ignore` library's "path matches everything inside" behavior.
  out += '(?:/.*)?$'
  return new RegExp(out)
}

/** One project's conditional-activation wiring. */
export interface PathActivationProject {
  /** Project root whose touched files are considered. */
  readonly root: string
  /** Matcher over absolute paths; true touches activate the listed skills. */
  readonly matcher: (path: string) => boolean
  /** Skill names to activate when the matcher fires. */
  readonly skillNames: readonly string[]
}

/** Options for {@link registerPathActivator}. */
export interface RegisterPathActivatorOptions {
  /** Per-project matchers and the skills they activate. */
  readonly projects: readonly PathActivationProject[]
  /** Callback invoked with each activated skill name on a matching touch. */
  onActivate(name: string): void
}

/**
 * Register an `fs/observed` listener that activates path-conditional skills
 * when a Read/Write/Edit tool touches a matching file. The listener is a
 * synchronous recorder: it must not throw or await. Only `read`, `write`, and
 * `edit` tool actors (identified by their `name`) trigger activation.
 * @param ctx - active context.
 * @param options - project matchers and the activation callback.
 * @returns the exact disposer that removes the listener.
 */
export function registerPathActivator(ctx: Context, options: RegisterPathActivatorOptions): () => void {
  const normalized = options.projects.map(project => ({
    root: project.root.replaceAll('\\', '/'),
    matcher: project.matcher,
    skillNames: project.skillNames,
  }))
  return ctx.on('fs/observed', (target: FsTarget, _observation: FsObservation, actor: object | undefined) => {
    if (!touchActor(actor)) return
    const path = target.displayPath.replaceAll('\\', '/')
    for (const project of normalized) {
      if (!path.startsWith(project.root)) continue
      const rel = relative(project.root, target.displayPath).replaceAll('\\', '/')
      if (!project.matcher(rel)) continue
      for (const name of project.skillNames) options.onActivate(name)
    }
  })
}

function touchActor(actor: object | undefined): boolean {
  if (actor === undefined || !('name' in actor)) return false
  const value = actor.name
  return typeof value === 'string' && TOUCH_TOOLS.has(value)
}
