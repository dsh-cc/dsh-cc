import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { devStoreRestoreDecision, runStoreRestore } from '../bootstrap.mjs'

let root: string | null = null
afterEach(() => {
  if (root !== null) rmSync(root, { recursive: true, force: true })
  root = null
})

function tmp(): string {
  root ??= mkdtempSync(join(tmpdir(), 'dsh-cc-store-restore-'))
  return root
}

/** Lay out <tmp>/profiles/tui/node_modules/@dsh-cc with a stamp + sentinel package. */
function makeProfile(home: string, stamp: Record<string, unknown>): { home: string, profileDir: string, scope: string, backup: string, stampPath: string } {
  const profileDir = join(home, 'profiles', 'tui')
  const scope = join(profileDir, 'node_modules', '@dsh-cc')
  mkdirSync(scope, { recursive: true })
  const stampPath = join(scope, 'dsh-cc-build.json')
  writeFileSync(stampPath, JSON.stringify(stamp))
  mkdirSync(join(scope, 'bundle-tui'))
  writeFileSync(join(scope, 'bundle-tui', 'sentinel'), 'dev')
  return { home, profileDir, scope, backup: `${scope}.__dev-restore-backup`, stampPath }
}

const DEV_STAMP = { channel: 'dev', version: '0.6.3', commit: 'abc1234def56', dirty: false, launcherVersion: '0.6.3' }
const OK = { status: 0 }
const FAIL = { status: 1 }

describe('devStoreRestoreDecision', () => {
  const own = '0.6.3'
  it('returns null without stamp info', () => {
    expect(devStoreRestoreDecision(null, own)).toBe(null)
  })
  it('returns null for a non-dev channel', () => {
    expect(devStoreRestoreDecision({ channel: 'release' }, own)).toBe(null)
  })
  it('returns null when launcherVersion is null', () => {
    expect(devStoreRestoreDecision({ channel: 'dev', launcherVersion: null }, own)).toBe(null)
  })
  it('returns null when the launcher version is unchanged', () => {
    expect(devStoreRestoreDecision({ channel: 'dev', launcherVersion: own }, own)).toBe(null)
  })
  it('returns the from/to plan on a mismatch', () => {
    expect(devStoreRestoreDecision({ channel: 'dev', launcherVersion: '0.6.2' }, own)).toEqual({ from: '0.6.2', to: own })
  })
})

describe('runStoreRestore', () => {
  it('restores store bundles on success, removing backup, stamp, and an unmarked preset copy', () => {
    const t = makeProfile(tmp(), DEV_STAMP)
    const preset = join(t.home, '.agent-presets', 'cc')
    mkdirSync(preset, { recursive: true })
    writeFileSync(join(preset, 'sentinel'), 'x')
    const calls: unknown[][] = []
    const logs: string[] = []
    const result = runStoreRestore(t.profileDir, '0.6.3', {
      spawnSyncImpl: (cmd, argv) => { calls.push([cmd, argv]); return { status: 0 } },
      log: (m) => { logs.push(String(m)) },
    })
    expect(result).toEqual({ restored: true, from: '0.6.3', to: '0.6.3' })
    expect(calls[0]).toEqual(['dsh', ['plugin', '--profile', 'tui', 'add', '@dsh-cc/bundle-permissions@0.6.3', '@dsh-cc/bundle-shell@0.6.3', '@dsh-cc/bundle-tui@0.6.3']])
    expect(existsSync(t.backup)).toBe(false)
    expect(existsSync(t.stampPath)).toBe(false)
    expect(existsSync(preset)).toBe(false)
    expect(logs.join('\n')).toContain('launcher updated 0.6.3 → 0.6.3')
  })

  it('preserves a preset with a VALID managed marker', () => {
    const t = makeProfile(tmp(), DEV_STAMP)
    const preset = join(t.home, '.agent-presets', 'cc')
    mkdirSync(preset, { recursive: true })
    writeFileSync(join(preset, '.dsh-cc-managed.json'), JSON.stringify({ owner: '@dsh-cc/tui' }))
    runStoreRestore(t.profileDir, '0.6.3', { spawnSyncImpl: () => OK })
    expect(existsSync(preset)).toBe(true)
  })

  it('rolls back byte-identically on plugin-add failure and keeps the stamp', () => {
    const t = makeProfile(tmp(), DEV_STAMP)
    const result = runStoreRestore(t.profileDir, '0.6.3', { spawnSyncImpl: () => FAIL })
    expect(result).toEqual({ restored: false, reason: 'plugin-add-failed' })
    expect(existsSync(join(t.scope, 'bundle-tui', 'sentinel'))).toBe(true)
    expect(existsSync(t.stampPath)).toBe(true)
    expect(existsSync(t.backup)).toBe(false)
  })

  it('rolls back on a spawn error', () => {
    const t = makeProfile(tmp(), DEV_STAMP)
    const result = runStoreRestore(t.profileDir, '0.6.3', { spawnSyncImpl: () => ({ error: new Error('ENOENT'), status: null }) })
    expect(result).toEqual({ restored: false, reason: 'plugin-add-failed' })
    expect(existsSync(join(t.scope, 'bundle-tui', 'sentinel'))).toBe(true)
    expect(existsSync(t.stampPath)).toBe(true)
  })

  it('skips when a fresh lock is held', () => {
    const t = makeProfile(tmp(), DEV_STAMP)
    writeFileSync(join(t.profileDir, 'node_modules', '.dsh-cc-restore.lock'), '')
    let spawned = false
    const result = runStoreRestore(t.profileDir, '0.6.3', { spawnSyncImpl: () => { spawned = true; return OK } })
    expect(result).toEqual({ restored: false, reason: 'locked' })
    expect(spawned).toBe(false)
    expect(existsSync(t.stampPath)).toBe(true)
    expect(existsSync(join(t.scope, 'bundle-tui', 'sentinel'))).toBe(true)
  })

  it('takes over a stale lock and proceeds', () => {
    const t = makeProfile(tmp(), DEV_STAMP)
    const lock = join(t.profileDir, 'node_modules', '.dsh-cc-restore.lock')
    writeFileSync(lock, '')
    const stale = new Date(Date.now() - 11 * 60 * 1000)
    utimesSync(lock, stale, stale)
    const result = runStoreRestore(t.profileDir, '0.6.3', { spawnSyncImpl: () => OK })
    expect(result.restored).toBe(true)
    expect(existsSync(lock)).toBe(false)
  })

  it('recovers an interrupted restore (backup present, scope missing) and completes', () => {
    const t = makeProfile(tmp(), DEV_STAMP)
    renameSync(t.scope, t.backup)
    const result = runStoreRestore(t.profileDir, '0.6.3', { spawnSyncImpl: () => OK })
    expect(result.restored).toBe(true)
    expect(existsSync(t.backup)).toBe(false)
    expect(existsSync(t.stampPath)).toBe(false)
  })

  it('never crash-recovers while a fresh lock is held by a live restore', () => {
    const t = makeProfile(tmp(), DEV_STAMP)
    renameSync(t.scope, t.backup) // a LIVE restore's in-flight state
    const lock = join(t.profileDir, 'node_modules', '.dsh-cc-restore.lock')
    writeFileSync(lock, '') // fresh lock held by the other process
    const result = runStoreRestore(t.profileDir, '0.6.4', { spawnSyncImpl: () => OK })
    expect(result).toEqual({ restored: false, reason: 'locked' })
    // Untouched: no recovery rename, no stamp deletion, holder's lock survives.
    expect(existsSync(join(t.backup, 'bundle-tui', 'sentinel'))).toBe(true)
    expect(existsSync(t.scope)).toBe(false)
    expect(existsSync(lock)).toBe(true)
  })

  it('reports error and keeps dev state when the spawn impl throws', () => {
    const t = makeProfile(tmp(), DEV_STAMP)
    const result = runStoreRestore(t.profileDir, '0.6.3', { spawnSyncImpl: () => { throw new Error('boom') } })
    expect(result).toEqual({ restored: false, reason: 'error' })
    expect(existsSync(join(t.scope, 'bundle-tui', 'sentinel'))).toBe(true)
    expect(existsSync(t.backup)).toBe(false)
  })

  it('never destroys intact dev state on a pre-set-aside error (guarded rollback)', () => {
    // chmod is a no-op against root's permission bypass.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    const t = makeProfile(tmp(), DEV_STAMP)
    const nm = join(t.profileDir, 'node_modules')
    // Lock creation then fails with EACCES (non-EEXIST) BEFORE any set-aside.
    chmodSync(nm, 0o500)
    let result
    try {
      result = runStoreRestore(t.profileDir, '0.6.4', { spawnSyncImpl: () => OK })
    } finally {
      chmodSync(nm, 0o700)
    }
    expect(result).toEqual({ restored: false, reason: 'error' })
    expect(existsSync(join(t.scope, 'bundle-tui', 'sentinel'))).toBe(true)
    expect(existsSync(t.stampPath)).toBe(true)
    expect(existsSync(t.backup)).toBe(false)
  })

  it('bin --version prints the dev label and exits before any restore logic', () => {
    // launcherVersion deliberately diverges from the bin's own version so a
    // broken exit-ordering WOULD attempt a restore (spawn dsh off the stripped
    // PATH, fail, log) — silence on the restore log channel proves the exit
    // happened first.
    const t = makeProfile(tmp(), { ...DEV_STAMP, launcherVersion: '0.0.0' })
    const bin = fileURLToPath(new URL('../bin/dsh-cc.js', import.meta.url))
    const r = spawnSync(process.execPath, [bin, '--version'], {
      env: { ...process.env, DSH_HOME: t.home, PATH: '/nonexistent' },
      encoding: 'utf8',
    })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('0.6.3-dev+abc1234def56')
    expect(r.stderr).not.toContain('dev-store restore')
    expect(existsSync(t.stampPath)).toBe(true)
    expect(existsSync(join(t.profileDir, 'node_modules', '.dsh-cc-restore.lock'))).toBe(false)
  })
})
