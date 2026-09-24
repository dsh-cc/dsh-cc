/**
 * Claude Code skill discovery: root ordering, directory walking, and realpath
 * deduplication.
 *
 * This module finds `<name>/SKILL.md` skills across managed, project, user, and
 * additional roots in that priority order, plus legacy `.claude/commands/*.md`
 * files marked as deprecated sources. Discovery reads only frontmatter so the
 * catalog stays cheap; bodies load on `get()`.
 *
 * @module
 */

import { access, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { LEARNED_SKILLS_DIRNAME } from './learned-store.ts'

/** Discovery source bucket for one Claude Code skill file. */
export type CcSkillSource = 'managed' | 'user' | 'project' | 'additional' | 'learned'

/** Precedence rank (lower wins) for a discovery root within the provider. */
export type CcRootRank = 100 | 200 | 300 | 400 | 500

/** A discovered Claude Code skill file locator. */
export interface CcSkillFile {
  /** Kebab-case skill name derived from its directory or file name. */
  readonly name: string
  /** Absolute path to `SKILL.md` or a deprecated flat `.md`. */
  readonly path: string
  /** Absolute base directory for relative resources in the body. */
  readonly directory: string
  /** Discovery source bucket. */
  readonly source: CcSkillSource
  /** Precedence rank (lower wins name conflicts). */
  readonly rank: CcRootRank
  /** Whether this came from legacy `.claude/commands/*.md`. */
  readonly deprecated: boolean
}

/** One candidate root scanned for skills, in discovery order. */
export interface CcRoot {
  /** Absolute root path containing `<name>/SKILL.md` entries. */
  readonly path: string
  /** Discovery source bucket. */
  readonly source: CcSkillSource
  /** Precedence rank (lower wins). */
  readonly rank: CcRootRank
  /** Legacy flat-`.md` directory (`.claude/commands`) when applicable. */
  readonly legacyMdDir?: string
}

/** Options for one discovery pass. */
export interface CcDiscoveryOptions {
  /** Harness home which owns the managed and user skill roots. */
  readonly dshHome: string
  /** Optional explicit managed policy root, scanned first when set. */
  readonly managedDir?: string | undefined
  /** Workspace used to locate project `.claude/skills`. */
  readonly projectCwd?: string | undefined
  /** Additional skill roots appended after the defaults. */
  readonly additionalDirs: readonly string[]
}

const MANAGED_RANK = 100
const PROJECT_RANK = 200
const USER_RANK = 300
const ADDITIONAL_RANK = 400
const LEARNED_RANK = 500
const LEGACY_COMMANDS = 'commands'

/**
 * Compute the ordered discovery roots for a workspace. Scans managed, project,
 * user, and additional roots; the list is already in precedence order so a
 * first-wins realpath dedup below is deterministic.
 * @param options - discovery inputs (home, managed dir, cwd, additional dirs).
 * @returns the ordered roots to scan.
 */
export async function discoverCcRoots(options: CcDiscoveryOptions): Promise<readonly CcRoot[]> {
  const roots: CcRoot[] = []
  if (options.managedDir !== undefined) {
    roots.push({ path: resolve(options.managedDir), source: 'managed', rank: MANAGED_RANK })
  }
  if (options.projectCwd !== undefined) {
    const projectRoot = await findProjectRoot(resolve(options.projectCwd))
    const skillsDir = join(projectRoot, '.claude', 'skills')
    roots.push({
      path: skillsDir,
      source: 'project',
      rank: PROJECT_RANK,
      legacyMdDir: join(projectRoot, '.claude', LEGACY_COMMANDS),
    })
  }
  roots.push({ path: join(resolve(options.dshHome), 'skills'), source: 'user', rank: USER_RANK })
  for (const dir of options.additionalDirs) {
    roots.push({ path: resolve(dir), source: 'additional', rank: ADDITIONAL_RANK })
  }
  roots.push({
    path: join(resolve(options.dshHome), LEARNED_SKILLS_DIRNAME),
    source: 'learned',
    rank: LEARNED_RANK,
  })
  return roots
}

/**
 * Discover every Claude Code skill file for a workspace, deduplicated by the
 * resolved real path so symlinked or overlapping roots yield each file once.
 * @param options - discovery inputs.
 * @returns the deduplicated skill files in precedence order.
 */
export async function discoverCcSkills(options: CcDiscoveryOptions): Promise<readonly CcSkillFile[]> {
  const roots = await discoverCcRoots(options)
  const files: CcSkillFile[] = []
  for (const root of roots) {
    files.push(...await scanDirectoryRoot(root))
    if (root.legacyMdDir !== undefined) {
      files.push(...await scanLegacyDirectory(root.legacyMdDir, root))
    }
  }
  return deduplicateByRealpath(files)
}

async function scanDirectoryRoot(root: CcRoot): Promise<CcSkillFile[]> {
  let entries
  try {
    entries = await readdir(root.path, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    // Absent or unreadable roots are valid empty state for discovery.
    return []
  }
  const found: CcSkillFile[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dirPath = join(root.path, entry.name)
    const skillPath = join(dirPath, 'SKILL.md')
    if (!await isReadableFile(skillPath)) continue
    found.push({
      name: entry.name,
      path: skillPath,
      directory: dirPath,
      source: root.source,
      rank: root.rank,
      deprecated: false,
    })
  }
  return found
}

async function scanLegacyDirectory(dir: string, root: CcRoot): Promise<CcSkillFile[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return []
  }
  const found: CcSkillFile[] = []
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    if (!entry.name.endsWith('.md')) continue
    const filePath = join(dir, entry.name)
    const name = entry.name.replace(/\.md$/, '')
    found.push({
      name,
      path: filePath,
      directory: dir,
      source: root.source,
      rank: root.rank,
      deprecated: true,
    })
  }
  return found
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

/** Resolve the project root (nearest ancestor containing `.git`) for a cwd. */
export async function findProjectRoot(cwd: string): Promise<string> {
  let current = cwd
  while (true) {
    if (await pathExists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function deduplicateByRealpath(files: readonly CcSkillFile[]): Promise<CcSkillFile[]> {
  const seen = new Set<string>()
  const result: CcSkillFile[] = []
  for (const file of files) {
    const identity = await realpath(file.path).catch(() => null)
    if (identity === null) {
      result.push(file)
      continue
    }
    if (seen.has(identity)) continue
    seen.add(identity)
    result.push(file)
  }
  return result
}
