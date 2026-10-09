import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectKeyOf } from '@dsh-cc/sidecar-io'
import { apply } from '../src/index.ts'

/**
 * U2 rollup tests (design §5 step 3): fake ctx rig like telemetry.spec.ts,
 * with synthetic ledgers, learned-dir fixtures (mtimes set via fs.utimes) and
 * a fake catalog on ctx.get('skills'). Clocks are honest — real Date.now()
 * with generous margins.
 */

// Test-only hook: when armed, the readJsonl override advances the ledger
// (as if a load committed) DURING the scan, after the watermark was taken.
const scanState = { advanceLedgerDuringScan: false }
vi.mock('@dsh-cc/sidecar-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dsh-cc/sidecar-io')>()
  return {
    ...actual,
    readJsonl: async <T>(filePath: string): Promise<T[]> => {
      const rows = await actual.readJsonl<T>(filePath)
      if (scanState.advanceLedgerDuringScan) {
        scanState.advanceLedgerDuringScan = false
        const { appendFileSync } = await import('node:fs')
        appendFileSync(filePath, JSON.stringify({ v: 1, ts: Date.now(), sessionId: 'late', skill: 'late-skill', via: 'tool' }) + '\n')
      }
      return rows
    },
  }
})

const dirs: string[] = []
afterEach(() => {
  scanState.advanceLedgerDuringScan = false
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'skill-usage-rollup-'))
  dirs.push(home)
  return home
}

interface Rig {
  ctx: { logger: { debug: ReturnType<typeof vi.fn> } }
  onSessionCreated: (session: unknown) => void
  onLearnedChanged: () => void
  home: string
  setCatalog: (list: unknown) => void
}

function rig(home = tempHome()): Rig {
  const registrations: Array<[string, (...args: never[]) => unknown]> = []
  let catalog: unknown
  const ctx = {
    logger: { debug: vi.fn() },
    on: vi.fn((event: string, listener: (...args: never[]) => unknown) => {
      registrations.push([event, listener])
    }),
    get: (name: string) => (name === 'skills' ? catalog : undefined),
    dshHomePath: () => home,
  }
  apply(ctx as never)
  const byEvent = (event: string): (...args: never[]) => unknown => {
    const call = registrations.find(([name]) => name === event)
    expect(call, `expected a ${event} registration`).toBeDefined()
    return call![1]
  }
  return {
    ctx: ctx as unknown as Rig['ctx'],
    onSessionCreated: byEvent('session/created') as unknown as Rig['onSessionCreated'],
    onLearnedChanged: byEvent('skills/learned-changed') as unknown as Rig['onLearnedChanged'],
    home,
    setCatalog: (list: unknown) => { catalog = { list: vi.fn(async () => list) } },
  }
}

const DAY = 24 * 60 * 60 * 1000
const usageDir = (home: string): string => join(home, 'skill-usage')
const reportFile = (home: string, key: string): string => join(usageDir(home), `utility-${key}.md`)
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25))

function sessionAt(cwd: string): unknown {
  return { id: 'session-1', header: { cwd }, snapshotEvents: () => [] }
}

function seedLedger(home: string, cwd: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(usageDir(home), { recursive: true })
  writeFileSync(
    join(usageDir(home), `loads-${projectKeyOf(cwd)}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
  )
}

function seedLearned(home: string, name: string, ageDays: number): void {
  const file = join(home, 'learned-skills', name, 'SKILL.md')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `---\nname: ${name}\n---\nbody\n`)
  const t = new Date(Date.now() - ageDays * DAY)
  utimesSync(file, t, t)
}

function seedMarker(home: string, key: string, ageDays: number | null): void {
  mkdirSync(usageDir(home), { recursive: true })
  if (ageDays === null) {
    rmSync(join(usageDir(home), `observing-since-${key}`), { force: true })
    return
  }
  writeFileSync(join(usageDir(home), `observing-since-${key}`), String(Date.now() - ageDays * DAY))
}

// A freshly published report (current watermark, current mtime) — "fresh".

describe('skill-usage utility rollup', () => {
  it('zero-load workspace at session/created: marker created, report written with honest empty sections, no leftover temp files', async () => {
    const { onSessionCreated, home } = rig()
    onSessionCreated(sessionAt(home))
    await flush()
    const key = projectKeyOf(home)
    const text = readFileSync(reportFile(home, key), 'utf8')
    expect(existsSync(join(usageDir(home), `observing-since-${key}`))).toBe(true)
    expect(text).toContain('# Skill utility report — ' + key)
    expect(text).toContain('Observation coverage since: ')
    expect(text).toContain('disabling deletes the marker and restarts coverage')
    expect(text).toContain('zero-load periods still count')
    expect(text).toContain('Input watermark: 0.')
    expect(text).toContain('Age basis: SKILL.md mtime (edits reset age)')
    expect(text).toContain('current shadowing cannot certify historical ownership')
    expect(text).toContain('Classification source: catalog SkillSummary.source + learned dir enumeration.')
    expect(text).toContain('## By loads (30d / all-time)')
    expect(text).toContain('## Never loaded (learned skills, untouched > 30)')
    expect(text).toContain('rule: learned, 0 loads in 30d, age > 14d, coverage ≥ 30d')
    expect(text).toContain('Demotion is manual')
    expect(text).toContain('manage_skill')
    expect(text).toContain('## Insufficient observation window (excluded from demote list)')
    expect(text).toContain('## Shadowed learned skills (attribution uncertain)')
    // Honest empties: no per-skill bullets anywhere.
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toEqual([])
    // Temp+rename: nothing left over.
    expect(readdirSync(usageDir(home)).filter((f) => f.includes('.tmp-'))).toEqual([])
  })

  it('aggregates loads per name (30d / all-time, sessions, last date) and never-loaded/demote sections', async () => {
    const { onSessionCreated, home } = rig()
    const key = projectKeyOf(home)
    const now = Date.now()
    seedLedger(home, home, [
      { v: 1, ts: now - 1 * DAY, sessionId: 'a', skill: 'used', via: 'tool' },
      { v: 1, ts: now - 2 * DAY, sessionId: 'a', skill: 'used', via: 'slash' },
      { v: 1, ts: now - 40 * DAY, sessionId: 'b', skill: 'used', via: 'tool' },
      { v: 1, ts: now - 40 * DAY, sessionId: 'c', skill: 'stale-but-used', via: 'tool' },
    ])
    seedLearned(home, 'old-quiet', 40)
    seedLearned(home, 'young-quiet', 5)
    onSessionCreated(sessionAt(home))
    await flush()
    const text = readFileSync(reportFile(home, key), 'utf8')
    expect(text).toContain('- used: 2 / 3 loads, 2 sessions, last ')
    expect(text).toContain('- stale-but-used: 0 / 1 loads, 1 sessions, last ')
    // Never loaded: untouched > 30d and zero loads — only the old one.
    expect(text).toContain('## Never loaded (learned skills, untouched > 30)')
    expect(text).toContain('- old-quiet: last touched ')
    expect(text).not.toContain('- young-quiet: last touched ')
    // Demote: learned, 0 loads in 30d, age > 14d, coverage ≥ 30d.
    expect(text).toContain('## Demote candidates (rule: learned, 0 loads in 30d, age > 14d, coverage ≥ 30d)')
    expect(text).toContain('- old-quiet: last touched ')
    expect(text).toContain('0 loads in 30d')
    // Young skill: age guard fails AND coverage window may pass but age is 5d.
    const demoteSection = text.slice(text.indexOf('## Demote candidates'), text.indexOf('## Insufficient'))
    expect(demoteSection).not.toContain('young-quiet')
  })

  it('demote coverage guard: marker younger than 30d ⇒ insufficient observation window, not demote list', async () => {
    const { onSessionCreated, home } = rig()
    const key = projectKeyOf(home)
    seedLearned(home, 'old-quiet', 40)
    onSessionCreated(sessionAt(home))
    await flush()
    // The trigger just created the marker (age ~0) — insufficient window.
    const text = readFileSync(reportFile(home, key), 'utf8')
    const demote = text.slice(text.indexOf('## Demote candidates'), text.indexOf('## Insufficient'))
    const insufficient = text.slice(text.indexOf('## Insufficient'), text.indexOf('## Shadowed'))
    expect(demote).not.toContain('old-quiet')
    expect(insufficient).toContain('- old-quiet')
  })

  it('mtime age semantics: an edit (fresh utimes) resets age — skill leaves the demote list', async () => {
    const { onSessionCreated, home } = rig()
    const key = projectKeyOf(home)
    seedLearned(home, 'edited', 40)
    // First pass: aged ⇒ demote candidate (backdate the marker for coverage).
    seedMarker(home, key, 40)
    onSessionCreated(sessionAt(home))
    await flush()
    expect(readFileSync(reportFile(home, key), 'utf8')).toContain('- edited: last touched ')
    // Simulate an edit: reset SKILL.md mtime to now, force staleness via age.
    const file = join(home, 'learned-skills', 'edited', 'SKILL.md')
    const t = new Date()
    utimesSync(file, t, t)
    const report = reportFile(home, key)
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
    utimesSync(report, old, old) // older than default rollup-stale-hours = 24h
    onSessionCreated(sessionAt(home))
    await flush()
    const text = readFileSync(report, 'utf8')
    const demote = text.slice(text.indexOf('## Demote candidates'), text.indexOf('## Insufficient'))
    expect(demote).not.toContain('- edited')
    const never = text.slice(text.indexOf('## Never loaded'), text.indexOf('## Demote candidates'))
    expect(never).not.toContain('- edited')
  })

  it('staleness: fresh report skips — ledger NOT rescanned (content byte-identical)', async () => {
    const { onSessionCreated, home } = rig()
    const key = projectKeyOf(home)
    seedLedger(home, home, [{ v: 1, ts: Date.now(), sessionId: 'a', skill: 'used', via: 'tool' }])
    // First trigger publishes a real report.
    onSessionCreated(sessionAt(home))
    await flush()
    const before = readFileSync(reportFile(home, key), 'utf8')
    expect(before).toContain('- used: 1 / 1 loads')
    // Second trigger with a fresh report: skip — nothing recomputed.
    onSessionCreated(sessionAt(home))
    await flush()
    expect(readFileSync(reportFile(home, key), 'utf8')).toBe(before)
  })

  it('staleness: ledger mtime newer than the recorded watermark ⇒ recompute', async () => {
    const { onSessionCreated, home } = rig()
    const key = projectKeyOf(home)
    seedLedger(home, home, [{ v: 1, ts: Date.now(), sessionId: 'a', skill: 'used', via: 'tool' }])
    onSessionCreated(sessionAt(home))
    await flush()
    const before = readFileSync(reportFile(home, key), 'utf8')
    // New load after publication: ledger mtime advances past the watermark.
    seedLedger(home, home, [
      { v: 1, ts: Date.now(), sessionId: 'a', skill: 'used', via: 'tool' },
      { v: 1, ts: Date.now(), sessionId: 'b', skill: 'second', via: 'tool' },
    ])
    onSessionCreated(sessionAt(home))
    await flush()
    const after = readFileSync(reportFile(home, key), 'utf8')
    expect(after).toContain('- second: 1 / 1 loads')
    expect(after).not.toBe(before)
  })

  it('staleness: report ENOENT ⇒ recompute', async () => {
    const { onSessionCreated, home } = rig()
    const key = projectKeyOf(home)
    onSessionCreated(sessionAt(home))
    await flush()
    expect(existsSync(reportFile(home, key))).toBe(true)
    rmSync(reportFile(home, key))
    onSessionCreated(sessionAt(home))
    await flush()
    expect(existsSync(reportFile(home, key))).toBe(true)
  })

  it('staleness: ledger advanced DURING the scan ⇒ published report is immediately stale; next trigger recomputes', async () => {
    const { onSessionCreated, home } = rig()
    const key = projectKeyOf(home)
    scanState.advanceLedgerDuringScan = true
    onSessionCreated(sessionAt(home))
    await flush()
    // The published watermark predates the ledger's post-scan mtime.
    const published = readFileSync(reportFile(home, key), 'utf8')
    const wm = Number(published.match(/Input watermark: ([0-9.]+)\./)![1])
    const { statSync } = await import('node:fs')
    expect(statSync(join(usageDir(home), `loads-${key}.jsonl`)).mtimeMs).toBeGreaterThan(wm)
    // The late row was appended after readJsonl returned, so it is NOT in
    // the published report; the NEXT trigger must pick it up.
    onSessionCreated(sessionAt(home))
    await flush()
    expect(readFileSync(reportFile(home, key), 'utf8')).toContain('- late-skill: 1 / 1 loads')
  })

  it('enabled=false at trigger: marker deleted, no report written, existing reports untouched', async () => {
    const { onSessionCreated, home } = rig()
    const key = projectKeyOf(home)
    mkdirSync(usageDir(home), { recursive: true })
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ 'cc-skill-usage': { enabled: false } }))
    writeFileSync(join(usageDir(home), `observing-since-${key}`), String(Date.now() - 40 * DAY))
    const existingReport = join(usageDir(home), 'utility-other.md')
    writeFileSync(existingReport, 'KEEP ME')
    onSessionCreated(sessionAt(home))
    await flush()
    expect(existsSync(join(usageDir(home), `observing-since-${key}`))).toBe(false)
    expect(existsSync(reportFile(home, key))).toBe(false)
    expect(readFileSync(existingReport, 'utf8')).toBe('KEEP ME')
  })

  it('churn event: every utility-*.md deleted (across keys), markers and ledgers untouched', () => {
    const { onLearnedChanged, home } = rig()
    mkdirSync(usageDir(home), { recursive: true })
    writeFileSync(join(usageDir(home), 'utility-a.md'), 'A')
    writeFileSync(join(usageDir(home), 'utility-b.md'), 'B')
    writeFileSync(join(usageDir(home), 'observing-since-a'), '1')
    writeFileSync(join(usageDir(home), 'loads-a.jsonl'), '{}\n')
    writeFileSync(join(usageDir(home), 'unrelated.md'), 'KEEP')
    onLearnedChanged()
    expect(existsSync(join(usageDir(home), 'utility-a.md'))).toBe(false)
    expect(existsSync(join(usageDir(home), 'utility-b.md'))).toBe(false)
    expect(existsSync(join(usageDir(home), 'observing-since-a'))).toBe(true)
    expect(existsSync(join(usageDir(home), 'loads-a.jsonl'))).toBe(true)
    expect(readFileSync(join(usageDir(home), 'unrelated.md'), 'utf8')).toBe('KEEP')
  })

  it('shadowed learned skill: annotated, excluded from demote candidates', async () => {
    const { onSessionCreated, home, setCatalog } = rig()
    const key = projectKeyOf(home)
    seedLearned(home, 'dup', 40)
    seedMarker(home, key, 40)
    setCatalog([
      { name: 'dup', source: 'learned' },
      { name: 'dup', source: 'project' },
      { name: 'other', source: 'learned' },
    ])
    onSessionCreated(sessionAt(home))
    await flush()
    const text = readFileSync(reportFile(home, key), 'utf8')
    expect(text).toContain('## Shadowed learned skills (attribution uncertain)')
    expect(text).toContain('- dup: shadowed — attribution uncertain')
    const demote = text.slice(text.indexOf('## Demote candidates'), text.indexOf('## Insufficient'))
    expect(demote).not.toContain('dup')
    // Non-shadowed learned skill still classified from the catalog.
    const shadow = text.slice(text.indexOf('## Shadowed'))
    expect(shadow).not.toContain('- other:')
  })

  it('catalog unavailable (providerless): report still written, learned skills unshadowed', async () => {
    const { onSessionCreated, home, setCatalog } = rig()
    setCatalog(undefined)
    seedLearned(home, 'lonely', 40)
    onSessionCreated(sessionAt(home))
    await flush()
    const text = readFileSync(reportFile(home, projectKeyOf(home)), 'utf8')
    expect(text).toContain('# Skill utility report')
    expect(text).not.toContain('shadowed — attribution uncertain')
  })

  it('temp+rename: no .tmp- leftovers after repeated recomputes', async () => {
    const { onSessionCreated, home } = rig()
    for (let i = 0; i < 3; i += 1) {
      onSessionCreated(sessionAt(home))
      await flush()
      rmSync(reportFile(home, projectKeyOf(home))) // force ENOENT recompute
    }
    await flush()
    expect(readdirSync(usageDir(home)).filter((f) => f.includes('.tmp-'))).toEqual([])
  })
})
