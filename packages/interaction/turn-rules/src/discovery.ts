/**
 * Rule discovery (plan docs/plans/2026-09-23-turn-rules.md §4.2): re-read the
 * same cursor-plugin rules corpus the cc-plugin-loader mounts, from disk, at
 * `apply()` time. DEFAULT discovery options only (installed ∩ enabled), cursor
 * flavor only, manifest `rules` declaration order with the append-default-`rules/`
 * convention, lexicographic file sort inside a declared directory. Trigger-less
 * rules are dropped — the matching engine only ever sees trigger-bearing rules.
 * The corpus is a snapshot: plugin install/enable changes take effect on the
 * next preset remount.
 *
 * @module
 */

import { readFile, readdir } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import {
  CURSOR_MANIFEST,
  NESTED_MANIFEST,
  TOP_LEVEL_MANIFEST,
  ComponentTally,
  discoverCcPluginRoots,
  globPathKind,
  parsePluginManifest,
  parseRuleFile,
  type DiscoverCcPluginRootsOptions,
  type RuleEntry,
  type TurnRuleChannel,
} from '@dsh-cc/plugin-loader'

/** One trigger-bearing rule ready for the matching engine. */
export interface TurnRule {
  /** `<pluginRoot-basename>/<relative-rule-path>` — the stable ledger key (§4.6). */
  readonly ruleKey: string
  /** JS regex source (validated at parse time). */
  readonly trigger: string
  /** Channels the trigger matches (default: both). */
  readonly triggerOn: readonly TurnRuleChannel[]
  /** Repeat policy (default `once`). */
  readonly repeat: 'once' | 'after-gap'
  /** Re-arm gap in turn stops under `after-gap` (default 10). */
  readonly repeatGap: number
  /** The rule markdown body — injected verbatim as the advisory reminder. */
  readonly body: string
  /** Optional frontmatter description. */
  readonly description?: string
}

/** Both channels, the `triggerOn` default. */
const BOTH_CHANNELS: readonly TurnRuleChannel[] = ['tool-results', 'user-prompts']

/**
 * Discover trigger-bearing rules across installed+enabled cursor plugins, in
 * the deterministic §4.2 order: discovery order across plugins, manifest
 * declaration order, lexicographic file sort within a declared directory.
 * Fail-soft: an unreadable/invalid manifest or rule file contributes nothing.
 */
export async function discoverTurnRules(options: DiscoverCcPluginRootsOptions = {}): Promise<TurnRule[]> {
  const out: TurnRule[] = []
  for (const { root } of discoverCcPluginRoots(options)) {
    const manifest = await readManifest(root)
    if (manifest === undefined || manifest.flavor !== 'cursor') continue
    for (const declared of manifest.rules) {
      // Append-default-dir convention (cc-plugin-loader rules.ts precedent):
      // a declared path not already under `rules/` reads under the default dir.
      const path = declared.startsWith('rules/') || declared === 'rules' ? declared : `rules/${declared}`
      const kind = globPathKind(path)
      if (kind === 'unsupported') continue
      const resolved = join(root, kind === 'recursive' ? path.slice(0, -3) : path)
      const files = await collectRuleFiles(resolved)
      // readdir order is NOT deterministic; the lexicographic sort is mandatory.
      files.sort()
      for (const file of files) {
        const entry = await parseRuleEntry(file)
        const rule = entry === undefined ? undefined : toTurnRule(entry, basename(root), relative(root, file))
        if (rule !== undefined) out.push(rule)
      }
    }
  }
  return out
}

/** Parse the winning manifest for one root; `undefined` when none parses. */
async function readManifest(root: string): Promise<ReturnType<typeof parsePluginManifest> | undefined> {
  // Candidate order mirrors discovery (plan §3.1): cc-nested, cursor-nested, top-level.
  const candidates: { path: string; flavor: 'cc' | 'cursor' }[] = [
    { path: join(root, NESTED_MANIFEST), flavor: 'cc' },
    { path: join(root, CURSOR_MANIFEST), flavor: 'cursor' },
    { path: join(root, TOP_LEVEL_MANIFEST), flavor: 'cc' },
  ]
  for (const candidate of candidates) {
    let raw: string
    try {
      raw = await readFile(candidate.path, 'utf8')
    } catch {
      continue
    }
    try {
      return parsePluginManifest(JSON.parse(raw), basename(root), { flavor: candidate.flavor })
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Parse one rule file, fail-soft to `undefined`. */
async function parseRuleEntry(file: string): Promise<RuleEntry | undefined> {
  try {
    return await parseRuleFile(file, new ComponentTally('rules'), [])
  } catch {
    return undefined
  }
}

/** Coerce a parsed entry into a trigger-bearing rule; `undefined` when trigger-less. */
function toTurnRule(entry: RuleEntry, rootName: string, relativePath: string): TurnRule | undefined {
  if (entry.trigger === undefined) return undefined
  return {
    ruleKey: `${rootName}/${relativePath}`,
    trigger: entry.trigger,
    triggerOn: entry.triggerOn ?? BOTH_CHANNELS,
    repeat: entry.repeat ?? 'once',
    repeatGap: entry.repeatGap ?? 10,
    body: entry.body,
    ...entry.description !== undefined ? { description: entry.description } : {},
  }
}

/** Collect `.mdc` files: a `.mdc` path is one file, anything else walks recursively. */
async function collectRuleFiles(path: string): Promise<string[]> {
  const found: string[] = []
  if (path.endsWith('.mdc')) {
    found.push(path)
    return found
  }
  await walkMdc(path, found)
  return found
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
