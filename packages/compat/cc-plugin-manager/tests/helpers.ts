/**
 * Shared test rig for the S4 specs: a tmp claudeHome + cwd with a directory
 * marketplace `internal` declaring two plugins (formatter 1.0.0, linter
 * 0.9.0) in real on-disk layout.
 *
 * @module @dsh-cc/plugin-manager/test-helpers
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const temps: string[] = []

export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

export async function cleanupTemps(): Promise<void> {
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
}

export interface Rig {
  claudeHome: string
  cwd: string
  marketplacesDir: string
  /** `<claudeHome>/plugins/cache` */
  cacheDir: string
  marketplaceDir: string
  knownFile: string
  installedFile: string
}

/**
 * Build a rig with a directory marketplace `internal` at
 * `<claudeHome>/plugins/marketplaces/internal`, declaring formatter and
 * linter with on-disk plugin manifests.
 */
export async function rig(): Promise<Rig> {
  const claudeHome = await tempDir('pm-s4-home-')
  const cwd = await tempDir('pm-s4-cwd-')
  const marketplacesDir = join(claudeHome, 'plugins', 'marketplaces')
  const cacheDir = join(claudeHome, 'plugins', 'cache')
  const marketplaceDir = join(marketplacesDir, 'internal')
  await mkdir(join(marketplaceDir, '.claude-plugin'), { recursive: true })
  await writeFile(
    join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: 'internal', plugins: [{ name: 'formatter', source: 'plugins/formatter' }, { name: 'linter', source: 'plugins/linter' }] }),
    'utf8',
  )
  for (const [name, version] of [['formatter', '1.0.0'], ['linter', '0.9.0']] as const) {
    await mkdir(join(marketplaceDir, 'plugins', name, '.claude-plugin'), { recursive: true })
    await writeFile(join(marketplaceDir, 'plugins', name, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version }), 'utf8')
    await writeFile(join(marketplaceDir, 'plugins', name, 'skill.md'), `# ${name}`, 'utf8')
  }
  const knownFile = join(claudeHome, 'plugins', 'known_marketplaces.json')
  await writeFile(
    knownFile,
    JSON.stringify({
      internal: {
        source: { source: 'github', repo: 'acme/internal' },
        installLocation: marketplaceDir,
        lastUpdated: '2026-09-06T09:00:00.000Z',
      },
    }),
    'utf8',
  )
  return { claudeHome, cwd, marketplacesDir, cacheDir, marketplaceDir, knownFile, installedFile: join(claudeHome, 'plugins', 'installed_plugins.json') }
}

export async function readJson(file: string): Promise<any> {
  const { readFile } = await import('node:fs/promises')
  return JSON.parse(await readFile(file, 'utf8'))
}

/**
 * Byte snapshot of a whole tree (plan W1): relative file path → sha256 of
 * its contents. Empty (or missing) dir ⇒ empty map. Used to assert a seeded
 * claude home is byte-identical before/after a mutation.
 */
export function snapshotTree(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!existsSync(dir)) return out
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = join(abs, entry.name)
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(childAbs, childRel)
      else if (statSync(childAbs).isFile()) out.set(childRel, createHash('sha256').update(readFileSync(childAbs)).digest('hex'))
    }
  }
  walk(dir, '')
  return out
}
export async function readRaw(file: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(file, 'utf8')
}

/** Dual-home deps: separate dsh write home (plan §3.1), optional extras (now/runGit). */
export function dualDeps(r: Rig, dshHome: string, extra: Record<string, unknown> = {}): any {
  return { claudeHome: r.claudeHome, dshHome, cwd: r.cwd, ...extra }
}

export async function expectError(fn: () => Promise<unknown>): Promise<Error> {
  return fn().then(
    () => {
      throw new Error('expected to throw')
    },
    error => error as Error,
  )
}
