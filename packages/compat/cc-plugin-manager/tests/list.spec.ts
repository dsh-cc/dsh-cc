import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listInstalled } from '../src/list.ts'
import { createCcPluginManager } from '../src/index.ts'
import { canonicalizeExistingPath } from '../src/paths.ts'

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

interface Rig {
  claudeHome: string
  cwd: string
}

/** Build a home + cwd with the given installed entries and per-scope enabledPlugins maps. */
async function rig(opts: {
  installed: Record<string, any[]>
  user?: Record<string, boolean>
  project?: Record<string, boolean>
  local?: Record<string, boolean>
  projectDir?: string
  localDir?: string
}): Promise<Rig> {
  const claudeHome = await tempDir('pm-list-home-')
  const cwd = opts.projectDir ?? await tempDir('pm-list-cwd-')
  await mkdir(join(claudeHome, 'plugins'), { recursive: true })
  await writeFile(
    join(claudeHome, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: opts.installed }, null, 2) + '\n',
    'utf8',
  )
  if (opts.user) {
    await writeFile(join(claudeHome, 'settings.json'), JSON.stringify({ enabledPlugins: opts.user }, null, 2) + '\n', 'utf8')
  }
  if (opts.project) {
    await mkdir(join(cwd, '.claude'), { recursive: true })
    await writeFile(join(cwd, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: opts.project }, null, 2) + '\n', 'utf8')
  }
  if (opts.local) {
    const localRoot = opts.localDir ?? cwd
    await mkdir(join(localRoot, '.claude'), { recursive: true })
    await writeFile(join(localRoot, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: opts.local }, null, 2) + '\n', 'utf8')
  }
  return { claudeHome, cwd: canonicalizeExistingPath(cwd) }
}

function entry(scope: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope,
    installPath: `/p/cache/${scope}/1.0.0`,
    version: '1.0.0',
    installedAt: '2026-09-05T08:10:00.000Z',
    lastUpdated: '2026-09-05T08:10:00.000Z',
    ...extra,
  }
}

describe('effective enablement (C9)', () => {
  it('local > project > user precedence', async () => {
    const r = await rig({
      installed: { 'a@x': [entry('user')], 'b@x': [entry('user')], 'c@x': [entry('user')], 'd@x': [entry('user')], 'e@x': [entry('user')] },
      user: { 'a@x': true, 'b@x': true, 'c@x': true, 'e@x': true },
      project: { 'a@x': false, 'b@x': true, 'e@x': false },
      local: { 'a@x': true },
    })
    const rows = await listInstalled(r)
    const effective = Object.fromEntries(rows.map(row => [row.id, row.effectiveEnabled]))
    expect(effective).toEqual({ 'a@x': true, 'b@x': true, 'c@x': true, 'd@x': false, 'e@x': false })
  })

  it('absent everywhere ⇒ disabled; enabledByScope exposes defined values only', async () => {
    const r = await rig({
      installed: { 'a@x': [entry('user')], 'b@x': [entry('user')] },
      user: { 'a@x': true },
      project: { 'b@x': false },
    })
    const rows = await listInstalled(r)
    const a = rows.find(row => row.id === 'a@x')!
    expect(a.effectiveEnabled).toBe(true)
    expect(a.enabledByScope).toEqual({ user: true })
    expect(a.overrideNote).toBeUndefined()
    const b = rows.find(row => row.id === 'b@x')!
    expect(b.effectiveEnabled).toBe(false)
    expect(b.enabledByScope).toEqual({ project: false })
  })

  it('override note present iff defined scopes disagree', async () => {
    const r = await rig({
      installed: { 'a@x': [entry('user')], 'b@x': [entry('user')], 'c@x': [entry('user')] },
      user: { 'a@x': false, 'c@x': true },
      project: { 'a@x': true, 'b@x': true },
    })
    const rows = await listInstalled(r)
    expect(rows.find(row => row.id === 'a@x')!.overrideNote).toBe('user=false, project=true')
    expect(rows.find(row => row.id === 'b@x')!.overrideNote).toBeUndefined()
    expect(rows.find(row => row.id === 'c@x')!.overrideNote).toBeUndefined()
  })
})

describe('cwd visibility filtering', () => {
  it('project/local entries only when projectPath realpaths to cwd; /tmp symlink case', async () => {
    const realCwd = await tempDir('pm-vis-')
    // /tmp-style non-canonical alias of the same directory (macOS /tmp → /private/tmp)
    const alias = realCwd.startsWith('/private/') ? realCwd.replace('/private', '') : null
    const r = await rig({
      installed: {
        'proj@x': [entry('project', { projectPath: realCwd })],
        'other@x': [entry('project', { projectPath: '/definitely/not/this/dir' })],
        'plain@x': [entry('user')],
      },
    })
    const rows = await listInstalled({ claudeHome: r.claudeHome, cwd: alias ?? realCwd })
    const ids = rows.map(row => row.id).sort()
    expect(ids).toEqual(['plain@x', 'proj@x'])
  })

  it('entries missing projectPath are treated user-scope (always visible)', async () => {
    const realCwd = await tempDir('pm-vis2-')
    const r = await rig({
      installed: { 'localish@x': [entry('local')] },
    })
    const rows = await listInstalled({ claudeHome: r.claudeHome, cwd: realCwd })
    expect(rows.map(row => row.id)).toEqual(['localish@x'])
    expect(rows[0]!.scope).toBe('local')
    expect(rows[0]!.effectiveEnabled).toBe(false)
  })
})

describe('row shape', () => {
  it('carves id/version/scope/paths/timestamps from the install entry', async () => {
    const realCwd = await tempDir('pm-shape-')
    const r = await rig({
      projectDir: realCwd,
      installed: {
        'a@x': [entry('user', { version: '2.3.4', installPath: '/p/cache/x/a/2.3.4' })],
        'b@x': [entry('project', { projectPath: realCwd })],
      },
      user: { 'a@x': true },
    })
    const rows = await listInstalled(r)
    const a = rows.find(row => row.id === 'a@x')!
    expect(a).toMatchObject({
      id: 'a@x',
      version: '2.3.4',
      scope: 'user',
      installPath: '/p/cache/x/a/2.3.4',
      installedAt: '2026-09-05T08:10:00.000Z',
      lastUpdated: '2026-09-05T08:10:00.000Z',
      effectiveEnabled: true,
      enabledByScope: { user: true },
    })
    expect(a.projectPath).toBeUndefined()
    const b = rows.find(row => row.id === 'b@x')!
    expect(b.projectPath).toBe(realCwd)
    expect(b.effectiveEnabled).toBe(false)
  })
})

describe('--enabled/--disabled filters via the factory API', () => {
  it('filters on effectiveEnabled', async () => {
    const r = await rig({
      installed: { 'a@x': [entry('user')], 'b@x': [entry('user')], 'c@x': [entry('user')] },
      user: { 'a@x': true, 'c@x': true },
      project: { 'a@x': false },
    })
    const manager = createCcPluginManager({ claudeHome: r.claudeHome, cwd: r.cwd })
    const all = await manager.list()
    expect(all.map(row => row.id).sort()).toEqual(['a@x', 'b@x', 'c@x'])
    expect((await manager.list({ enabled: true })).map(row => row.id)).toEqual(['c@x'])
    expect((await manager.list({ disabled: true })).map(row => row.id).sort()).toEqual(['a@x', 'b@x'])
    expect((await manager.list({ enabled: false })).map(row => row.id).sort()).toEqual(['a@x', 'b@x'])
  })
})
