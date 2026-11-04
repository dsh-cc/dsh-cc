/**
 * Repo-wide session-event registration audit. Every custom session event
 * type a dsh-cc package writes into the session log MUST be registered into
 * the live `KNOWN_SESSION_EVENT_TYPES` set at that package's module load —
 * otherwise the jsonl persistence backend refuses to reopen any session
 * that contains the event (SessionFormatUnsupportedError on open(read|write)),
 * permanently breaking resume. This bug class shipped three times
 * (permission/* gauge events, retry-attendant/event poisoning 1557 real
 * sessions, tool/code-dispatch* latent), so this spec pins the invariant
 * mechanically instead of per package.
 *
 * Required surface (static scan of all packages/<group>/<pkg>/src trees):
 *   1. keys declared in `declare module '@deepseek-ai/dsh-session/types'`
 *      SessionEventMap augmentations, and
 *   2. event-type string literals passed straight to `.append(`.
 * Constant-based appends whose type is neither declared in a SessionEventMap
 * nor literally appended escape this scan (permission-rules, session-cwd,
 * progress-rebuild today — all register next to their constant definitions).
 * Registration is verified dynamically: each involved package's src/index.ts
 * is imported and the live set is diffed around it, so a registration that
 * is not reachable from the package entry fails exactly like production.
 *
 * Hosted in @dsh-cc/tools (the base package every preset composition loads)
 * because the audit spans packages.
 *
 * @module
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')
/** Vendored trees that never touch the harness session surface. */
const EXCLUDED_PACKAGES = new Set(['pi-tui'])

/** Matches event-type literals passed directly to `.append(`. */
const APPEND_LITERAL = /\.append\(\s*'([a-z][a-z0-9-]+\/[a-z][a-z0-9-]+)'/g
/** Matches SessionEventMap key declarations (`'ns/name':`). */
const EVENT_MAP_KEY = /'([a-z][a-z0-9-]+\/[a-z][a-z0-9-]+)'\s*:/g
const SESSION_MAP_MODULE = 'declare module \'@deepseek-ai/dsh-session/types\''

interface PackageInfo {
  /** Absolute path of the built package entry (lib/index.js, the production root). */
  entry: string
  /** Custom event types the package may write to session logs. */
  required: Set<string>
}

function* walkSrc(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'lib' || entry === 'tests') continue
    const path = join(dir, entry)
    let stats
    try { stats = statSync(path) } catch { continue }
    if (stats.isDirectory()) yield* walkSrc(path)
    else if (entry.endsWith('.ts')) yield path
  }
}

function scanPackages(): Map<string, PackageInfo> {
  const packages = new Map<string, PackageInfo>()
  for (const group of readdirSync(PACKAGES_DIR)) {
    const groupDir = join(PACKAGES_DIR, group)
    try { if (!statSync(groupDir).isDirectory()) continue } catch { continue }
    for (const pkg of readdirSync(groupDir)) {
      if (EXCLUDED_PACKAGES.has(pkg)) continue
      const pkgDir = join(groupDir, pkg)
      try { if (!statSync(join(pkgDir, 'src')).isDirectory()) continue } catch { continue }
      for (const file of walkSrc(join(pkgDir, 'src'))) {
        const text = readFileSync(file, 'utf8')
        const found = new Set<string>()
        for (const match of text.matchAll(APPEND_LITERAL)) found.add(match[1]!)
        if (text.includes(SESSION_MAP_MODULE)) {
          for (const match of text.matchAll(EVENT_MAP_KEY)) found.add(match[1]!)
        }
        if (found.size === 0) continue
        const key = `${group}/${pkg}`
        const info = packages.get(key) ?? { entry: join(pkgDir, 'lib', 'index.js'), required: new Set<string>() }
        for (const type of found) info.required.add(type)
        packages.set(key, info)
      }
    }
  }
  return packages
}

it('every custom session event type is registered into KNOWN_SESSION_EVENT_TYPES at package load', async () => {
  // Snapshot the harness baseline BEFORE any dsh-cc package import pollutes
  // the live set, then import each involved package entry and diff. Only
  // packages holding non-baseline types are imported: harness-native types
  // need no registration, and skipping those packages keeps this audit
  // independent of workspace builds unrelated to custom events.
  const baseline = new Set(KNOWN_SESSION_EVENT_TYPES)
  const packages = scanPackages()

  const registered = new Set<string>()
  for (const info of packages.values()) {
    const custom = [...info.required].filter((type) => !baseline.has(type))
    if (custom.length === 0) continue
    const before = new Set(KNOWN_SESSION_EVENT_TYPES)
    // eslint-disable-next-line no-await-in-loop -- sequential imports keep the diff attribution readable
    await import(info.entry)
    for (const type of KNOWN_SESSION_EVENT_TYPES) if (!before.has(type)) registered.add(type)
  }

  const missing: string[] = []
  for (const [key, info] of packages) {
    for (const type of info.required) {
      if (!baseline.has(type) && !registered.has(type)) missing.push(`${key} → ${type}`)
    }
  }
  expect(
    missing,
    `custom session event types with no KNOWN_SESSION_EVENT_TYPES registration poison session resume (SessionFormatUnsupportedError on open); register them at module load (idiom: packages/interaction/completion-gate/src/events.ts):\n${missing.join('\n')}`,
  ).toEqual([])
})
