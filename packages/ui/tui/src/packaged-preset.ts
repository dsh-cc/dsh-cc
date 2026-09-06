/**
 * Materialize the CC preset into `$DSH_HOME/.agent-presets/cc`. The official
 * launcher replaces system preset roots, so the user root is the supported
 * extension seam (same pattern as dsh-TUI's packaged presets).
 * @module @dsh-cc/tui/packaged-preset
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const OWNER = '@dsh-cc/tui'
const MARKER = '.dsh-cc-managed.json'
export const CC_PRESET_ID = 'cc'

export interface ManagedMarker {
  owner: string
  preset: string
  revision: string
}

export type PackagedPresetStatus = 'installed' | 'updated' | 'current' | 'conflict' | 'missing-source'

export interface PackagedPresetResult {
  id: string
  status: PackagedPresetStatus
}

export interface PackagedPresetOptions {
  dshHome?: string
  sourceRoot?: string
  revision?: string
}

function readMarker(directory: string): ManagedMarker | undefined {
  try {
    const value = JSON.parse(readFileSync(join(directory, MARKER), 'utf8')) as Partial<ManagedMarker>
    if (
      value.owner === OWNER
      && typeof value.preset === 'string'
      && typeof value.revision === 'string'
      && value.revision.length > 0
    ) {
      return value as ManagedMarker
    }
  } catch {
    // Absent or user-authored marker: not ours.
  }
  return undefined
}

/**
 * Resolve the packaged preset directory (src layout or compiled `presets/cc`).
 */
export function packagedPresetRoot(moduleUrl: string = import.meta.url): string | undefined {
  const directory = dirname(fileURLToPath(moduleUrl))
  const candidates = [
    join(directory, '../presets', CC_PRESET_ID),
    join(directory, '../../presets', CC_PRESET_ID),
    join(directory, '../../../preset/cc'),
    join(directory, '../../../../preset/cc'),
  ]
  return candidates.find(candidate => existsSync(join(candidate, 'agent.cordis.yml')))
}

function writeMarker(directory: string, revision: string): void {
  const marker: ManagedMarker = { owner: OWNER, preset: CC_PRESET_ID, revision }
  writeFileSync(join(directory, MARKER), `${JSON.stringify(marker, null, 2)}\n`)
}

/**
 * Copy the CC preset into the user root when missing or stale. Never overwrites
 * an unmarked directory (a person authored that id).
 */
export function ensurePackagedPreset(options: PackagedPresetOptions = {}): PackagedPresetResult {
  const source = options.sourceRoot ?? packagedPresetRoot()
  if (source === undefined || !existsSync(join(source, 'agent.cordis.yml'))) {
    return { id: CC_PRESET_ID, status: 'missing-source' }
  }
  const revision = options.revision
    ?? (existsSync(join(source, MARKER)) ? readMarker(source)?.revision : undefined)
    ?? '0.1.0'
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const targetRoot = join(dshHome, '.agent-presets')
  const target = join(targetRoot, CC_PRESET_ID)

  if (!existsSync(target)) {
    mkdirSync(targetRoot, { recursive: true })
    cpSync(source, target, { recursive: true, force: false, errorOnExist: true, filter: () => true })
    writeMarker(target, revision)
    return { id: CC_PRESET_ID, status: 'installed' }
  }

  const targetMarker = readMarker(target)
  if (targetMarker === undefined || targetMarker.preset !== CC_PRESET_ID) {
    return { id: CC_PRESET_ID, status: 'conflict' }
  }
  if (targetMarker.revision === revision) {
    return { id: CC_PRESET_ID, status: 'current' }
  }

  const suffix = `${process.pid}-${randomUUID()}`
  const staged = join(targetRoot, `.${CC_PRESET_ID}.staged-${suffix}`)
  const backup = join(targetRoot, `.${CC_PRESET_ID}.backup-${suffix}`)
  mkdirSync(staged, { recursive: true })
  cpSync(source, staged, { recursive: true, force: true, filter: () => true })
  writeMarker(staged, revision)
  try {
    renameSync(target, backup)
    renameSync(staged, target)
    rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    if (!existsSync(target) && existsSync(backup)) renameSync(backup, target)
    rmSync(staged, { recursive: true, force: true })
    throw error
  }
  return { id: CC_PRESET_ID, status: 'updated' }
}
