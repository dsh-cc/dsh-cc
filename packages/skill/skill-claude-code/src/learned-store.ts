/**
 * Shared learned-skill store: create/update/delete/list over
 * `<dshHome>/learned-skills/<name>/SKILL.md`.
 *
 * Cordis-free by design: the caller injects `listClaimants` (the registry's
 * merged view) and `onChanged` (the refresh-event emit), so the store is
 * directly unit-testable with fakes. Writers (command-learn promotion and the
 * manage_skill tool) share this implementation.
 *
 * @module
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { parseCcFrontmatterDocument } from './frontmatter.ts'

/** Directory name of the learned root under `$DSH_HOME`. */
export const LEARNED_SKILLS_DIRNAME = 'learned-skills'

/** Size cap over the final serialized file bytes (frontmatter + body). */
export const MAX_LEARNED_SKILL_BYTES = 64_000

/** Kebab-name grammar for learned skills. */
export const LEARNED_NAME_SOURCE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Whether `name` satisfies the learned-skill charset. */
export function isLearnedSkillName(name: string): boolean {
  return LEARNED_NAME_SOURCE.test(name)
}

/**
 * Sanitize a machine-generated description for the model-facing catalog:
 * strip control/format characters and `<`/`>`/backticks, collapse whitespace
 * runs to single spaces, and reduce to a single line.
 */
export function sanitizeLearnedDescription(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}<>`]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** Inputs to serialize one learned skill file. */
export interface LearnedSkillInput {
  readonly name: string
  readonly description: string
  /** Writer provenance, e.g. `/learn 2026-09-24` or `manage_skill 2026-09-24`. */
  readonly learnedFrom: string
  readonly body: string
}

/** Frontmatter fields serialized for one learned skill. */
export interface LearnedFrontmatter {
  [key: string]: unknown
  name: string
  description: string
  learnedFrom: string
}

/** Serialize the full `SKILL.md` text for a learned skill. */
export function serializeLearnedSkill(input: LearnedSkillInput): string {
  const frontmatter: LearnedFrontmatter = {
    name: input.name,
    description: input.description,
    learnedFrom: input.learnedFrom,
  }
  const yaml = stringifyYaml(frontmatter).trimEnd()
  return `---\n${yaml}\n---\n\n${input.body.trimEnd()}\n`
}

/** Absolute path of one learned skill's `SKILL.md`. */
export function learnedSkillPath(dshHome: string, name: string): string {
  return join(resolve(dshHome), LEARNED_SKILLS_DIRNAME, name, 'SKILL.md')
}

/** A learned-skill list entry. */
export interface LearnedSkillEntry {
  readonly name: string
  readonly description: string
  readonly bytes: number
  readonly path: string
}

/** A claimant from the registry's merged view (mapped from `SkillSummary`). */
export interface LearnedClaimant {
  readonly name: string
  readonly provider: string
  readonly source: string
}

/** Options for one LearnedSkillStore. */
export interface LearnedSkillStoreOptions {
  readonly dshHome: string
  readonly listClaimants: () => Promise<readonly LearnedClaimant[]>
  /** Called after every successful mutation (never on failure). */
  readonly onChanged: () => void
}

/** Stable refusal codes for learned-skill operations. */
export type LearnedSkillErrorCode = 'invalid_name' | 'invalid_params' | 'too_large' | 'shadowed' | 'already_exists' | 'not_found'

/** Discriminated store result: `ok` or a stable error code. */
export type LearnedSkillResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: LearnedSkillErrorCode; detail: string }

function failure(code: LearnedSkillErrorCode, detail: string): { ok: false; code: LearnedSkillErrorCode; detail: string } {
  return { ok: false, code, detail }
}

/** Shared create/update/delete/list implementation over the learned root. */
export class LearnedSkillStore {
  private readonly dshHome: string

  constructor(private readonly options: LearnedSkillStoreOptions) {
    this.dshHome = resolve(options.dshHome)
  }

  /** Path of a learned skill under this store's home. */
  private path(name: string): string {
    return learnedSkillPath(this.dshHome, name)
  }

  /** Create a learned skill exclusively. */
  async create(input: { readonly name: string; readonly description: string; readonly learnedFrom: string; readonly body: string }): Promise<LearnedSkillResult<{ path: string; bytes: number }>> {
    const invalid = validateName(input.name)
    if (invalid) return invalid
    const description = sanitizeLearnedDescription(input.description)
    if (description === '') {
      return failure('invalid_params', 'description is empty after sanitization')
    }
    const path = this.path(input.name)
    // Claim check per §4.4, evaluated in order: on-disk file first, then the
    // registry view by `source`; the wx EEXIST below is the race backstop.
    try {
      await readFile(path, 'utf8')
      return failure('already_exists', `learned skill already exists at ${path}`)
    } catch {
      // no file on disk — fall through to the registry claim check
    }
    const claimant = (await this.options.listClaimants()).find(c => c.name === input.name)
    if (claimant !== undefined && claimant.source !== 'learned') {
      return failure('shadowed', `name is claimed by an authored skill provided by ${claimant.provider} (source ${claimant.source})`)
    }
    const serialized = serializeLearnedSkill({
      name: input.name,
      description,
      learnedFrom: input.learnedFrom,
      body: input.body,
    })
    if (Buffer.byteLength(serialized) > MAX_LEARNED_SKILL_BYTES) {
      return failure('too_large', `serialized file exceeds ${MAX_LEARNED_SKILL_BYTES} bytes`)
    }
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(path, serialized, { flag: 'wx' })
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') {
        return failure('already_exists', `learned skill already exists at ${path}`)
      }
      throw error
    }
    this.options.onChanged()
    return { ok: true, value: { path, bytes: Buffer.byteLength(serialized) } }
  }

  /** Update body and/or description, preserving all other frontmatter keys. */
  async update(input: { readonly name: string; readonly description?: string; readonly body?: string; readonly learnedFrom?: string }): Promise<LearnedSkillResult<{ path: string; bytes: number }>> {
    const invalid = validateName(input.name)
    if (invalid) return invalid
    if (input.description === undefined && input.body === undefined) {
      return failure('invalid_params', 'update requires a body or description')
    }
    const path = this.path(input.name)
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      return this.notFound(input.name, path)
    }
    const document = parseCcFrontmatterDocument(raw)
    if (document === undefined) {
      return failure('invalid_params', `existing skill at ${path} has no parsable frontmatter`)
    }
    const data: Record<string, unknown> = { ...document.data }
    let description: string | undefined
    if (input.description !== undefined) {
      description = sanitizeLearnedDescription(input.description)
      if (description === '') {
        return failure('invalid_params', 'description is empty after sanitization')
      }
      data.description = description
    }
    if (input.learnedFrom !== undefined) data.learnedFrom = input.learnedFrom
    const body = input.body !== undefined ? input.body : document.body
    const yaml = stringifyYaml(data).trimEnd()
    const serialized = `---\n${yaml}\n---\n\n${body.trimEnd()}\n`
    if (Buffer.byteLength(serialized) > MAX_LEARNED_SKILL_BYTES) {
      return failure('too_large', `serialized file exceeds ${MAX_LEARNED_SKILL_BYTES} bytes`)
    }
    // Temp + rename within the same directory: failures never partially write.
    const temp = `${path}.tmp-${Date.now()}`
    try {
      await writeFile(temp, serialized, 'utf8')
      await rename(temp, path)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
    this.options.onChanged()
    return { ok: true, value: { path, bytes: Buffer.byteLength(serialized) } }
  }

  /** Delete the whole learned skill directory. */
  async delete(name: string): Promise<LearnedSkillResult<{ path: string }>> {
    const invalid = validateName(name)
    if (invalid) return invalid
    const path = this.path(name)
    try {
      // on-disk existence is the sole oracle; rm -r also covers the dir.
      await readFile(path, 'utf8')
    } catch {
      return this.notFound(name, path)
    }
    await rm(dirname(path), { recursive: true })
    this.options.onChanged()
    return { ok: true, value: { path } }
  }

  /** List all learned skills by reading each frontmatter. */
  async list(): Promise<LearnedSkillResult<readonly LearnedSkillEntry[]>> {
    const root = join(this.dshHome, LEARNED_SKILLS_DIRNAME)
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch {
      return { ok: true, value: [] }
    }
    const skills: LearnedSkillEntry[] = []
    for (const name of entries.sort()) {
      const path = join(root, name, 'SKILL.md')
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch {
        continue
      }
      const document = parseCcFrontmatterDocument(raw)
      const description = typeof document?.data.description === 'string' ? document.data.description : ''
      skills.push({ name, description, bytes: Buffer.byteLength(raw), path })
    }
    return { ok: true, value: skills }
  }

  /** Not-found refusal, enriched with the authored-claimant hint when present. */
  private async notFound(name: string, path: string): Promise<{ ok: false; code: LearnedSkillErrorCode; detail: string }> {
    let detail = `no learned skill at ${path}`
    try {
      const claimant = (await this.options.listClaimants()).find(c => c.name === name)
      if (claimant !== undefined && claimant.source !== 'learned') {
        detail += `; an authored skill with that name is provided by ${claimant.provider} (source ${claimant.source}) and is not managed by this tool`
      }
    } catch {
      // hint is best-effort only
    }
    return failure('not_found', detail)
  }
}

function validateName(name: string): { ok: false; code: LearnedSkillErrorCode; detail: string } | undefined {
  if (!isLearnedSkillName(name)) {
    return failure('invalid_name', `name must match ${LEARNED_NAME_SOURCE.source}`)
  }
  return undefined
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error
}
