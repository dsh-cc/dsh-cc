/**
 * §5 items 1-3 unit tests: fake-session capture into tmp homes, plugin-state
 * legs (corrupt / missing / two-scope / dual-home / loader pick), and the
 * crash-recovery repair leg (§3.3). Tests never touch the real ~/.dsh or
 * ~/.claude — every leg uses tmp homes via the PathInputs seam.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, basename, join } from 'node:path'
import { drain, onSessionCreated, resolveHome, type SnapshotDeps } from '../src/capture.ts'
import { SidecarWriter } from '../src/writer.ts'
import { encodeSegment } from '../src/encode.ts'
import { SCHEMA_VERSION, selectRow, type SnapshotRow } from '../src/row.ts'
import type { Context } from '@deepseek-ai/cordis'

let tmpRoot: string
let home: string
let claudeHome: string
let projectDir: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'config-snapshot-test-'))
  home = join(tmpRoot, 'dsh')
  claudeHome = join(tmpRoot, 'claude')
  projectDir = join(tmpRoot, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(claudeHome, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  // Env fallback paths are exercised with these; PathInputs.dshHome comes from deps.
  process.env.CLAUDE_CONFIG_DIR = claudeHome
})

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR
  rmSync(tmpRoot, { recursive: true, force: true })
})

/** Install-entry fixture matching the plugin-manager `InstallEntry` shape. */
function entry(scope: 'user' | 'project' | 'local', version: string, lastUpdated: string, projectPath?: string) {
  return {
    scope,
    installPath: join(claudeHome, 'plugins', 'cache', 'mp', 'p', version),
    version,
    installedAt: '2026-01-01T00:00:00.000Z',
    lastUpdated,
    ...(projectPath !== undefined ? { projectPath } : {}),
  }
}

/** Seed `<claudeHome>/plugins/installed_plugins.json` and the dsh enablement file. */
function seedState(plugins: Record<string, unknown[]>, enabledPlugins: Record<string, boolean> = {}, dshInstalled?: Record<string, unknown[]>): void {
  mkdirSync(join(claudeHome, 'plugins'), { recursive: true })
  writeFileSync(join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }))
  if (dshInstalled !== undefined) {
    mkdirSync(join(home, 'plugins'), { recursive: true })
    writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: dshInstalled }))
  }
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ enabledPlugins }))
}

function makeDeps(overrides: Partial<SnapshotDeps> = {}): SnapshotDeps {
  return {
    home,
    bootId: 'test-boot',
    writer: new SidecarWriter(),
    enabled: () => true,
    get: () => undefined,
    debug: (m) => { console.error('DBG', m) },
    inflight: new Set<Promise<void>>(),
    ...overrides,
  }
}

function capture(deps: SnapshotDeps, id = 'session-1', header: Record<string, unknown> = { cwd: projectDir }): Promise<void> {
  onSessionCreated(deps, { id, header } as never)
  return drain(deps)
}

function ledgerFile(id: string): string {
  return join(home, 'config-snapshot', `${encodeSegment(id)}.jsonl`)
}

function readRows(id: string): SnapshotRow[] {
  return readFileSync(ledgerFile(id), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SnapshotRow)
}

describe('capture (§5 item 1)', () => {
  it('writes one row with the full shape, raw sessionId, and encoded single-component filename', async () => {
    await capture(makeDeps(), 'session-1', { cwd: projectDir, delegationDepth: 2, parentSession: 'parent-1', origin: 'subagent' })
    const rows = readRows('session-1')
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      sessionId: 'session-1',
      seq: 1,
      bootId: 'test-boot',
      dshCc: '0.9.0-rc.3',
      harness: null,
      preset: { id: null },
      plugins: [],
      delegationDepth: 2,
      parentSession: 'parent-1',
      origin: 'subagent',
    })
    expect(row.appendedAt).toBeGreaterThan(0)
    expect(basename(ledgerFile('session-1'))).not.toContain('/')
  })

  it('harness null-tolerance: string, {version} wire shape, and absence', async () => {
    const get = (key: string): unknown => (key === 'harnessVersion' ? { version: '9.9.9' } : undefined)
    await capture(makeDeps({ get }))
    expect(readRows('session-1')[0]!.harness).toBe('9.9.9')
  })

  it('preset.id typeof guard: string passes, non-string falls back to null', async () => {
    await capture(makeDeps({ get: (key) => (key === 'agentPresets' ? { defaultId: 'preset-x' } : undefined) }))
    expect(readRows('session-1')[0]!.preset).toEqual({ id: 'preset-x' })
    await capture(makeDeps({ get: (key) => (key === 'agentPresets' ? { defaultId: 42 } : undefined) }), 'session-2')
    expect(readRows('session-2')[0]!.preset).toEqual({ id: null })
  })

  it('plugin rows are sorted by id then scope', async () => {
    seedState(
      { 'b@mp': [entry('user', '2.0.0', '2026-01-01')], 'a@mp': [entry('user', '1.0.0', '2026-01-01')] },
      { 'a@mp': true, 'b@mp': true },
    )
    await capture(makeDeps(), 'sorted')
    const ids = readRows('sorted')[0]!.plugins.map((p) => p.id)
    expect(ids).toEqual(['a@mp', 'b@mp'])
  })

  it('hostile session ids stay one path component and the row keeps the raw id', async () => {
    await capture(makeDeps(), '../evil')
    const rows = readRows('../evil')
    expect(rows[0]!.sessionId).toBe('../evil')
    expect(dirname(ledgerFile('../evil'))).toBe(join(home, 'config-snapshot'))
  })

  it('providerless host (no home) no-ops without throwing', () => {
    expect(() => onSessionCreated(makeDeps({ home: undefined }), { id: 'session-x' })).not.toThrow()
  })

  it('kill switch disabled ⇒ no file', async () => {
    await capture(makeDeps({ enabled: () => false }), 'switched-off')
    expect(existsSync(ledgerFile('switched-off'))).toBe(false)
  })
})

describe('plugin-state legs (§5 item 2)', () => {
  it('corrupt installed_plugins.json ⇒ plugins [] + fixed note, other fields recorded, no tmp path', async () => {
    mkdirSync(join(claudeHome, 'plugins'), { recursive: true })
    writeFileSync(join(claudeHome, 'plugins', 'installed_plugins.json'), '{ not json')
    await capture(makeDeps({ get: (key) => (key === 'agentPresets' ? { defaultId: 'preset-x' } : undefined) }), 'corrupt')
    const row = readRows('corrupt')[0]!
    expect(row.plugins).toEqual([])
    expect(row.note).toBe('plugins-state-corrupt')
    expect(row.preset).toEqual({ id: 'preset-x' })
    expect(JSON.stringify(row)).not.toContain(tmpRoot)
  })

  it('missing state files ⇒ zero plugin rows and NO note', async () => {
    await capture(makeDeps(), 'fresh')
    const row = readRows('fresh')[0]!
    expect(row.plugins).toEqual([])
    expect(row.note).toBeUndefined()
  })
})

describe('loader selection and dual-home (§5 item 3)', () => {
  it('one id in two scopes ⇒ two rows, distinct versions, exactly one loaderSelected per the loader rule', async () => {
    seedState(
      { 'a@mp': [entry('user', '1.0.0', '2026-01-01'), entry('project', '1.1.0', '2026-01-02', projectDir)] },
      { 'a@mp': true },
    )
    await capture(makeDeps(), 'two-scope')
    const plugins = readRows('two-scope')[0]!.plugins
    expect(plugins).toHaveLength(2)
    const projectRow = plugins.find((p) => p.scope === 'project')!
    const userRow = plugins.find((p) => p.scope === 'user')!
    expect(projectRow.version).toBe('1.1.0')
    expect(userRow.version).toBe('1.0.0')
    expect(projectRow.loaderSelected).toBe(true) // greatest lastUpdated
    expect(userRow.loaderSelected).toBeUndefined()
  })

  it('a disabled id ⇒ enabled: false and NO loaderSelected row', async () => {
    seedState({ 'b@mp': [entry('user', '2.0.0', '2026-01-01')] }, {})
    await capture(makeDeps(), 'disabled')
    const plugins = readRows('disabled')[0]!.plugins
    expect(plugins).toHaveLength(1)
    expect(plugins[0]).toMatchObject({ id: 'b@mp', enabled: false })
    expect(plugins[0]!.loaderSelected).toBeUndefined()
  })

  it('dual-home: claude-only id passes through; a dsh empty list shadows the claude id', async () => {
    seedState(
      { 'c@mp': [entry('user', '3.0.0', '2026-01-01')], 'a@mp': [entry('user', '1.0.0', '2026-01-01')] },
      { 'c@mp': true, 'a@mp': true },
      { 'a@mp': [] },
    )
    await capture(makeDeps(), 'dual-home')
    const plugins = readRows('dual-home')[0]!.plugins
    expect(plugins.map((p) => p.id)).toEqual(['c@mp'])
  })
})

describe('crash recovery (§5 item 3 repair leg)', () => {
  it('torn unterminated fragment ⇒ repair-on-append, both new rows parse', async () => {
    const deps = makeDeps()
    seedState({}, {})
    const file = ledgerFile('crash')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, sessionId: 'crash', seq: 1 })}\n{"seq":`) // valid row + torn tail, no final newline
    await capture(deps, 'crash')
    await capture(deps, 'crash')
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(4) // valid seed + torn fragment + 2 new rows
    const parsed = lines
      .map((line) => {
        try {
          return JSON.parse(line) as SnapshotRow
        } catch {
          return null
        }
      })
      .filter((row): row is SnapshotRow => row !== null)
    expect(parsed).toHaveLength(3) // the fragment never swallowed a new row
    // seq init counts EVERY line (the torn fragment included), so new rows
    // continue at 3, 4 — the doc's collision-free guarantee (§3.4).
    expect(parsed.map((row) => row.seq)).toEqual([1, 3, 4])
  })
})

describe('home resolution (§3.3)', () => {
  it('boot seam wins when mounted', () => {
    const ctx = { dshHomePath: () => '/seam/home' } as unknown as Context
    expect(resolveHome(ctx)).toBe('/seam/home')
  })

  it('$DSH_HOME fallback when the seam is absent', () => {
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = '/env/home'
    try {
      expect(resolveHome({} as Context)).toBe('/env/home')
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    }
  })
})

describe('consumer join (§5 item 1 selection rule on a real two-row file)', () => {
  it('rows from two constructions of the same id select per the §3.4 rule', async () => {
    const deps = makeDeps()
    await capture(deps, 'resume')
    await capture(deps, 'resume')
    const rows = readRows('resume')
    expect(rows.map((row) => row.seq)).toEqual([1, 2])
    const [first, second] = rows
    expect(selectRow(rows, first!.appendedAt - 1)).toBeNull()
    expect(selectRow(rows, first!.appendedAt)?.seq).toBe(1)
    expect(selectRow(rows, second!.appendedAt)?.seq).toBe(2)
  })
})
