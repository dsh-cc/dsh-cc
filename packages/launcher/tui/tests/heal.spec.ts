import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BOOTSTRAP_STAMP, healDecision, HEAL_LOCK, readBootstrapVersion, runStoreHeal, writeBootstrapStamp } from '../bootstrap.mjs'

let root: string | null = null
afterEach(() => {
  if (root !== null) rmSync(root, { recursive: true, force: true })
  root = null
})

function tmp(): string {
  root ??= mkdtempSync(join(tmpdir(), 'dsh-cc-heal-'))
  return root
}

/** Lay out <tmp>/profiles/tui with an optional bootstrap stamp. */
function makeProfile(stampVersion?: string): { home: string, profileDir: string, stampPath: string } {
  const home = tmp()
  const profileDir = join(home, 'profiles', 'tui')
  mkdirSync(profileDir, { recursive: true })
  const stampPath = join(profileDir, BOOTSTRAP_STAMP)
  if (stampVersion !== undefined) {
    writeFileSync(stampPath, JSON.stringify({ launcherVersion: stampVersion }))
  }
  return { home, profileDir, stampPath }
}

describe('readBootstrapVersion', () => {
  it('reads the stamped launcher version', () => {
    const { stampPath } = makeProfile('0.7.1')
    expect(readBootstrapVersion(stampPath)).toBe('0.7.1')
  })
  it('fails open to null on a missing stamp', () => {
    const { stampPath } = makeProfile()
    expect(readBootstrapVersion(stampPath)).toBe(null)
  })
  it('fails open to null on malformed json', () => {
    const { stampPath } = makeProfile()
    writeFileSync(stampPath, '{')
    expect(readBootstrapVersion(stampPath)).toBe(null)
  })
  it('fails open to null when launcherVersion is not a string', () => {
    const { stampPath } = makeProfile()
    writeFileSync(stampPath, JSON.stringify({ launcherVersion: 7 }))
    expect(readBootstrapVersion(stampPath)).toBe(null)
  })
})

describe('healDecision', () => {
  const own = '0.7.1'
  it('returns null when the profile does not exist', () => {
    expect(healDecision({ profileExists: false, stampVersion: null, ownVersion: own })).toBe(null)
  })
  it('heals on a missing stamp — every pre-heal profile, including 0.7.0-broken installs', () => {
    expect(healDecision({ profileExists: true, stampVersion: null, ownVersion: own })).toEqual({ from: 'unknown (pre-heal profile)' })
  })
  it('heals on a version mismatch', () => {
    expect(healDecision({ profileExists: true, stampVersion: '0.6.3', ownVersion: own })).toEqual({ from: '0.6.3' })
  })
  it('skips when the stamp matches', () => {
    expect(healDecision({ profileExists: true, stampVersion: own, ownVersion: own })).toBe(null)
  })
  it('never heals a dev pairing, regardless of stamp or version match — that is the restore path', () => {
    const dev = { channel: 'dev', launcherVersion: own }
    expect(healDecision({ profileExists: true, stampVersion: null, ownVersion: own, buildInfo: dev })).toBe(null)
    expect(healDecision({ profileExists: true, stampVersion: '0.6.3', ownVersion: own, buildInfo: dev })).toBe(null)
  })
})

describe('writeBootstrapStamp', () => {
  it('writes the launcher version', () => {
    const { stampPath } = makeProfile()
    writeBootstrapStamp(stampPath, '0.7.1')
    expect(JSON.parse(readFileSync(stampPath, 'utf8'))).toEqual({ launcherVersion: '0.7.1' })
  })
  it('reports loudly when the stamp cannot be written', () => {
    const { stampPath } = makeProfile()
    const logs: string[] = []
    // A directory at the stamp path makes the write fail (EISDIR).
    mkdirSync(stampPath)
    writeBootstrapStamp(stampPath, '0.7.1', m => logs.push(String(m)))
    expect(logs.some(m => m.includes('CRITICAL'))).toBe(true)
  })
})

describe('runStoreHeal', () => {
  it('re-adds the bundles at the launcher version and stamps on success', () => {
    const { profileDir, stampPath } = makeProfile('0.6.3')
    const calls: unknown[][] = []
    const result = runStoreHeal(profileDir, '0.7.1', {
      from: '0.6.3',
      spawnSyncImpl: (cmd, argv) => { calls.push([cmd, argv]); return { status: 0 } },
      log: () => {},
    })
    expect(result).toEqual({ healed: true })
    expect(calls).toEqual([['dsh', ['plugin', '--profile', 'tui', 'add', '@dsh-cc/bundle-permissions@0.7.1', '@dsh-cc/bundle-shell@0.7.1', '@dsh-cc/bundle-tui@0.7.1']]])
    expect(readBootstrapVersion(stampPath)).toBe('0.7.1')
    expect(existsSync(join(profileDir, HEAL_LOCK))).toBe(false)
  })

  it('warns and leaves the stale stamp on a failed add (retry next launch)', () => {
    const { profileDir, stampPath } = makeProfile('0.6.3')
    const logs: string[] = []
    const result = runStoreHeal(profileDir, '0.7.1', {
      spawnSyncImpl: () => ({ status: 1 }),
      log: m => logs.push(String(m)),
    })
    expect(result).toEqual({ healed: false, reason: 'plugin-add-failed' })
    expect(readBootstrapVersion(stampPath)).toBe('0.6.3')
    expect(logs.some(m => m.includes('minimum-release-age'))).toBe(true)
    expect(existsSync(join(profileDir, HEAL_LOCK))).toBe(false)
  })

  it('logs CRITICAL when the add succeeds but the stamp cannot be written', () => {
    const { profileDir, stampPath } = makeProfile('0.6.3')
    rmSync(stampPath)
    mkdirSync(stampPath) // EISDIR on stamp write
    const logs: string[] = []
    const result = runStoreHeal(profileDir, '0.7.1', {
      spawnSyncImpl: () => ({ status: 0 }),
      log: m => logs.push(String(m)),
    })
    expect(result).toEqual({ healed: true })
    expect(logs.some(m => m.includes('CRITICAL'))).toBe(true)
  })

  it('skips when a fresh heal lock is held by another launch', () => {
    const { profileDir } = makeProfile('0.6.3')
    const lock = join(profileDir, HEAL_LOCK)
    writeFileSync(lock, '')
    const calls: unknown[][] = []
    const result = runStoreHeal(profileDir, '0.7.1', {
      spawnSyncImpl: (cmd, argv) => { calls.push([cmd, argv]); return { status: 0 } },
      log: () => {},
    })
    expect(result).toEqual({ healed: false, reason: 'locked' })
    expect(calls).toEqual([])
    expect(existsSync(lock)).toBe(true) // not ours to remove
  })

  it('takes over a stale lock (older than ten minutes)', () => {
    const { profileDir, stampPath } = makeProfile('0.6.3')
    const lock = join(profileDir, HEAL_LOCK)
    writeFileSync(lock, '')
    const stale = new Date(Date.now() - 11 * 60 * 1000)
    utimesSync(lock, stale, stale)
    const result = runStoreHeal(profileDir, '0.7.1', {
      spawnSyncImpl: () => ({ status: 0 }),
      log: () => {},
    })
    expect(result).toEqual({ healed: true })
    expect(readBootstrapVersion(stampPath)).toBe('0.7.1')
    expect(existsSync(lock)).toBe(false)
  })
})
