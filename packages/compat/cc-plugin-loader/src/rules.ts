/**
 * Mount a Cursor plugin's rules (`rules/*.mdc`).
 *
 * Discovers `.mdc` rule files from the default `rules/` directory and any
 * manifest-declared `rules` paths (append-default-dir convention, plan §3.3;
 * S2 glob policy: `dir/**` walks, other metacharacters skip with a warning),
 * parses typed frontmatter (`alwaysApply` boolean, `globs` inline or block
 * YAML list), and merges the entries through the optional `rules` guest seam
 * with copy-on-write disposal mirroring the hooks seam. A missing seam or a
 * malformed rule file tallies skipped — never a load failure, never a throw.
 *
 * @module
 */

import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { parseCcFrontmatterDocument } from '@dsh-cc/skill-loader'
import type { CcPluginManifest, RuleEntry, TurnRuleChannel } from './types.ts'
import { ComponentTally, type RulesSeam } from './seams.ts'
import { globPathKind } from './manifest.ts'

/** The rules seam: accepts a plugin's parsed rule entries. */
export { type RulesSeam } from './seams.ts'

/** Options for mounting one plugin's rules. */
export interface MountRulesOptions {
  /** The plugin root directory; the default `rules/` dir resolves against it. */
  readonly pluginRoot: string
  /** The parsed manifest; `rules` paths (cursor default dir included) drive the mount. */
  readonly manifest: CcPluginManifest
  /** The rules seam (probed; `undefined` to skip rules). */
  readonly rules: RulesSeam | undefined
}

/**
 * Discover and merge a plugin's rules through the optional seam.
 * @param options - plugin root, manifest, and the rules seam.
 * @returns mounted disposers and per-component counts.
 */
export async function mountRules(options: MountRulesOptions): Promise<{ disposers: (() => void)[]; tally: ComponentTally; warnings: string[] }> {
  const tally = new ComponentTally('rules')
  const disposers: (() => void)[] = []
  const warnings: string[] = []
  // A plugin declaring nothing (cc flavor never declares rules) mounts no
  // rules component at all — zero-change behavior for cc plugins.
  if (options.manifest.rules.length === 0) {
    return { disposers, tally, warnings }
  }
  if (options.rules === undefined) {
    for (const path of options.manifest.rules) {
      tally.addSkipped(`skipped rule path "${path}": rules seam "rules" is not mounted`)
    }
    return { disposers, tally, warnings }
  }
  const files: string[] = []
  for (const declared of options.manifest.rules) {
    // Append-default-dir convention (agents precedent): a declared path that
    // does not already live under `rules/` is read relative to the default dir.
    const relative = declared.startsWith('rules/') || declared === 'rules' ? declared : `rules/${declared}`
    // Glob policy (plan §3.4): `dir/**` walks recursively; any other glob
    // metacharacter is skipped with a warning, never expanded.
    const kind = globPathKind(relative)
    if (kind === 'unsupported') {
      const reason = `skipped rules entry "${declared}": glob patterns other than a trailing "/**" are not expanded`
      tally.addSkipped(reason)
      warnings.push(reason)
      continue
    }
    const before = files.length
    const resolved = resolve(options.pluginRoot, kind === 'recursive' ? relative.slice(0, -3) : relative)
    await collectRuleFiles(resolved, files)
    if (files.length === before) tally.addSkipped(`no rule files found under "${declared}"`)
  }
  if (files.length === 0) return { disposers, tally, warnings }
  const entries: RuleEntry[] = []
  for (const file of files) {
    const entry = await parseRuleFile(file, tally, warnings)
    if (entry !== undefined) {
      entries.push({
        ...entry,
        // Paths on the seam are plugin-root-relative (RuleEntry contract).
        path: relative(options.pluginRoot, file),
      })
    }
  }
  // Merge even when every file was malformed: the seam call is the mount
  // signal (an empty list), matching the never-throw hooks seam behavior.
  // The report tallies loaded rule PATHS (one per parsed entry), per S4.
  for (const _entry of entries) tally.addLoaded()
  disposers.push(options.rules.mergePluginRules(options.manifest.name, entries))
  return { disposers, tally, warnings }
}

/** Collect `.mdc` files: a `.mdc` path is one file, anything else walks recursively. */
async function collectRuleFiles(path: string, found: string[]): Promise<void> {
  if (path.endsWith('.mdc')) {
    found.push(path)
    return
  }
  await walkMdc(path, found)
}

/** Depth-first walk collecting every `.mdc` file under `dir` (absent dir is fine). */
async function walkMdc(dir: string, found: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const child = join(dir, entry.name)
    if (entry.isDirectory()) await walkMdc(child, found)
    else if (entry.isFile() && entry.name.endsWith('.mdc')) found.push(child)
  }
}

/**
 * Parse one `.mdc` file's typed frontmatter; malformed files skip with a
 * reason. Trigger keys (turn-rules, plan docs/plans/2026-09-23-turn-rules.md
 * §4.1) are read straight off the preserved frontmatter record; a malformed
 * trigger value (non-string trigger, invalid regex source, unknown
 * triggerOn/repeat enum, non-positive-integer repeatGap) skips the rule with
 * a tally warning — never a load failure, never a throw.
 */
export async function parseRuleFile(
  file: string,
  tally: ComponentTally,
  warnings: string[],
): Promise<RuleEntry | undefined> {
  const path = file
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    const reason = `skipped rule "${path}": file could not be read`
    tally.addSkipped(reason)
    warnings.push(reason)
    return undefined
  }
  const document = parseCcFrontmatterDocument(raw)
  if (document === undefined) {
    const reason = `skipped rule "${path}": frontmatter could not be parsed`
    tally.addSkipped(reason)
    warnings.push(reason)
    return undefined
  }
  const typed = typedFields(document.data)
  if (typeof typed === 'string') {
    const reason = `skipped rule "${path}": ${typed}`
    tally.addSkipped(reason)
    warnings.push(reason)
    return undefined
  }
  const triggered = triggerFields(path, document.data)
  if (typeof triggered === 'string') {
    const reason = `skipped rule "${path}": ${triggered}`
    tally.addSkipped(reason)
    warnings.push(reason)
    return undefined
  }
  return {
    path: file,
    description: typed.description,
    alwaysApply: typed.alwaysApply,
    globs: typed.globs,
    body: document.body,
    ...triggered,
  }
}

/**
 * Coerce the trigger fields off the raw frontmatter record; a string return
 * is a skip reason. Absent keys stay `undefined` — rules without a trigger
 * are byte-for-byte unaffected.
 */
function triggerFields(
  path: string,
  data: Record<string, unknown>,
): { trigger?: string; triggerOn?: readonly TurnRuleChannel[]; repeat?: 'once' | 'after-gap'; repeatGap?: number } | string {
  const out: { trigger?: string; triggerOn?: readonly TurnRuleChannel[]; repeat?: 'once' | 'after-gap'; repeatGap?: number } = {}
  if (data.trigger !== undefined) {
    if (typeof data.trigger !== 'string') return 'frontmatter field "trigger" must be a string'
    try {
      void new RegExp(data.trigger)
    } catch {
      return `frontmatter field "trigger" is not a valid regex source (rule "${path}")`
    }
    out.trigger = data.trigger
  }
  if (data.triggerOn !== undefined) {
    const raw = data.triggerOn
    const list = Array.isArray(raw) ? raw : [raw]
    if (list.some(item => item !== 'tool-results' && item !== 'user-prompts')) {
      return 'frontmatter field "triggerOn" must be "tool-results", "user-prompts", or a list of those'
    }
    out.triggerOn = list as TurnRuleChannel[]
  }
  if (data.repeat !== undefined) {
    if (data.repeat !== 'once' && data.repeat !== 'after-gap') {
      return 'frontmatter field "repeat" must be "once" or "after-gap"'
    }
    out.repeat = data.repeat
  }
  if (data.repeatGap !== undefined) {
    const raw = data.repeatGap
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
      return 'frontmatter field "repeatGap" must be a positive integer'
    }
    out.repeatGap = raw
  }
  return out
}

/** Coerce the typed rule fields; a string return is a skip reason. */
function typedFields(data: Record<string, unknown>): { description: string | undefined; alwaysApply: boolean; globs: string[] } | string {
  let description: string | undefined
  if (data.description !== undefined) {
    if (typeof data.description !== 'string') return 'frontmatter field "description" must be a string'
    description = data.description
  }
  let alwaysApply = false
  if (data.alwaysApply !== undefined) {
    const raw = data.alwaysApply
    if (typeof raw === 'boolean') alwaysApply = raw
    else if (raw === 'true') alwaysApply = true
    else if (raw === 'false') alwaysApply = false
    else return 'frontmatter field "alwaysApply" must be a boolean'
  }
  let globs: string[] = []
  if (data.globs !== undefined) {
    const raw = data.globs
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null
    if (list === null || list.some(item => typeof item !== 'string')) {
      return 'frontmatter field "globs" must be a string or a list of strings'
    }
    globs = list.map(item => (item as string).trim()).filter(item => item.length > 0)
  }
  return { description, alwaysApply, globs }
}
