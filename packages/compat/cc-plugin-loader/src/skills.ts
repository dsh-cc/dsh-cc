/**
 * Mount a Claude Code plugin's skills.
 *
 * Discovers `SKILL.md` skills in the plugin's standard `skills/` directory and
 * any inline manifest `skills` paths, parses each with the skill-claude-code
 * frontmatter translator, registers it on the skill registry as a runtime
 * skill, and wires the consumer-side activation semantics (allowed-tools,
 * `context: fork`, `paths`, MCP-source shell). Every registration is a Cordis
 * effect so unmounting the plugin recalls it.
 *
 * @module
 */

import { access, readdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  ccInvocation,
  parseCcFrontmatter,
  parseCcFrontmatterDocument,
  type CcSkillMetadata,
} from '@dsh-cc/skill-loader'
import { isSkillName, type SkillDefinition } from '@deepseek-ai/dsh-skill'
import type { CcPluginManifest } from './types.ts'
import { ComponentTally } from './seams.ts'
import { PROVIDER, registerSkillPathActivator, activationFor } from './skill-semantics.ts'

/** Skills live under this directory in a plugin root, when present. */
export const STANDARD_SKILLS_DIR = 'skills'

/** One skill file located under a plugin skill root. */
interface PluginSkillFile {
  readonly name: string
  readonly path: string
  readonly directory: string
}

/** The skill registry seam that accepts runtime skill registrations. */
export interface SkillsSeam {
  /**
   * Register a runtime skill definition.
   * @param skill - the skill definition to register.
   * @returns the exact disposer that unregisters the skill.
   */
  register(skill: unknown): () => void
}

/** Options for mounting one plugin's skills. */
export interface MountSkillsOptions {
  /** Active context carrying the `fs/observed` event for path activation. */
  readonly ctx: Context
  /** The plugin root directory; standard `skills/` resolves against it. */
  readonly pluginRoot: string
  /** The parsed manifest, whose `skills` paths add extra skill roots. */
  readonly manifest: CcPluginManifest
  /** The skill registry seam (probed; `undefined` to skip skills). */
  readonly skills: SkillsSeam | undefined
  /** The subagent seam presence (drives `context: fork` routing). */
  readonly subagentsPresent: boolean
}

/**
 * Discover and register a plugin's skills, wiring activation semantics.
 * @param options - plugin root, manifest, and the skill/subagent seams.
 * @returns mounted disposers and per-component counts.
 */
export async function mountSkills(options: MountSkillsOptions): Promise<{ disposers: (() => void)[]; tally: ComponentTally }> {
  const tally = new ComponentTally('skills')
  const disposers: (() => void)[] = []
  if (options.skills === undefined) {
    tally.addSkipped('skill registry seam "skills" is not mounted')
    return { disposers, tally }
  }
  const roots = skillRoots(options.pluginRoot, options.manifest)
  if (roots.length === 0) {
    tally.addSkipped('plugin ships no skills directory or manifest skills paths')
    return { disposers, tally }
  }
  const files = await collectSkillFiles(roots)
  if (files.length === 0) {
    tally.addSkipped('plugin ships no skills')
    return { disposers, tally }
  }
  for (const file of files) {
    const loaded = await loadSkillFile(file)
    if (loaded === undefined) {
      tally.addFailed(`could not parse skill "${file.name}"`)
      continue
    }
    if (!isSkillName(file.name)) {
      tally.addFailed(`skill "${file.name}" has an invalid registry name`)
      continue
    }
    const { parsed, body } = loaded
    const metadata = toMetadata(parsed)
    const definition: SkillDefinition = {
      name: file.name,
      description: parsed.description,
      ...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
      invocation: ccInvocation(parsed),
      source: 'project-dsh',
      provider: PROVIDER,
      resourceBase: { kind: 'directory', path: file.directory },
      path: file.path,
      content: body,
      metadata: metadata as unknown as Readonly<Record<string, unknown>>,
    }
    disposers.push(options.skills.register(definition))
    disposers.push(registerSkillPathActivator(options.ctx, definition, options.pluginRoot))
    activationFor(metadata, options.subagentsPresent)
    tally.addLoaded()
  }
  return { disposers, tally }
}

/** Default `skills/` plus manifest paths; overlay replace drops the default dir. */
function skillRoots(pluginRoot: string, manifest: CcPluginManifest): string[] {
  const roots: string[] = []
  if (!manifest.skillsReplaceDefault) roots.push(join(pluginRoot, STANDARD_SKILLS_DIR))
  for (const path of manifest.skills) roots.push(resolve(pluginRoot, path))
  return roots
}

/**
 * Collect `SKILL.md` files from plugin skill roots. A root that itself holds
 * `SKILL.md` is one skill (marketplace overlay listing `./skills/xlsx`);
 * otherwise scan one-level children (`skills/<name>/SKILL.md`).
 */
async function collectSkillFiles(roots: string[]): Promise<PluginSkillFile[]> {
  const found: PluginSkillFile[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    for (const file of await skillsInRoot(root)) {
      if (seen.has(file.path)) continue
      seen.add(file.path)
      found.push(file)
    }
  }
  return found
}

async function skillsInRoot(root: string): Promise<PluginSkillFile[]> {
  const direct = join(root, 'SKILL.md')
  if (await isReadable(direct)) {
    return [{ name: basename(root), path: direct, directory: root }]
  }
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found: PluginSkillFile[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const directory = join(root, entry.name)
    const path = join(directory, 'SKILL.md')
    if (!await isReadable(path)) continue
    found.push({ name: entry.name, path, directory })
  }
  return found
}

async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Read and parse one skill file's frontmatter and body. */
async function loadSkillFile(file: PluginSkillFile): Promise<{ parsed: CcPluginFrontmatter; body: string } | undefined> {
  let raw: string
  try {
    raw = await readFile(file.path, 'utf8')
  } catch {
    return undefined
  }
  const document = parseCcFrontmatterDocument(raw)
  const parsed = parseCcFrontmatter(raw)
  if (document === undefined || parsed === undefined) return undefined
  return { parsed, body: document.body }
}

/** The frontmatter surface the loader's metadata builder reads. */
type CcPluginFrontmatter = ReturnType<typeof parseCcFrontmatter> & {}

/** Build CC metadata for a parsed plugin skill, mirroring the provider's view. */
function toMetadata(parsed: CcPluginFrontmatter): CcSkillMetadata {
  return {
    allowedTools: parsed.allowedTools,
    arguments: parsed.arguments,
    deprecated: false,
    source: 'additional',
    unknown: parsed.unknown,
    ...parsed.argumentHint !== undefined ? { argumentHint: parsed.argumentHint } : {},
    ...parsed.version !== undefined ? { version: parsed.version } : {},
    ...parsed.model !== undefined ? { model: parsed.model } : {},
    ...parsed.executionContext !== undefined ? { executionContext: parsed.executionContext } : {},
    ...parsed.agent !== undefined ? { agent: parsed.agent } : {},
    ...parsed.effort !== undefined ? { effort: parsed.effort } : {},
    ...parsed.shell !== undefined ? { shell: parsed.shell } : {},
    ...parsed.hooks !== undefined ? { hooks: parsed.hooks } : {},
    ...parsed.paths !== undefined ? { paths: parsed.paths } : {},
  }
}
