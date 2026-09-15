/**
 * S6 end-to-end (plan §6): `/plugin marketplace add` → install → enable →
 * rescan over a cursor-layout fixture marketplace, driven through the
 * cc-shell `CcPluginManagerService` + `CcPluginsService` wiring. Both
 * CLAUDE_CONFIG_DIR and DSH_HOME are seeded to tmp dirs (house rule): the
 * manager writes to the dsh home, the loader's discovery reads the dual-home
 * cascade. The mounted plugin reports flavor 'cursor' and its skills and
 * commands are usable through the host seams.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CcPluginsService } from '../src/ccPlugins.ts'
import { createSessionCcPluginManager } from '../src/ccPluginManager.ts'

const tmpRoots: string[] = []
const previous = { dsh: undefined as string | undefined, claude: undefined as string | undefined }

beforeAll(() => {
  previous.dsh = process.env['DSH_HOME']
  previous.claude = process.env['CLAUDE_CONFIG_DIR']
  process.env['DSH_HOME'] = mkdtempSync(join(tmpdir(), 's6-e2e-dsh-'))
  process.env['CLAUDE_CONFIG_DIR'] = mkdtempSync(join(tmpdir(), 's6-e2e-claude-'))
  tmpRoots.push(process.env['DSH_HOME'], process.env['CLAUDE_CONFIG_DIR'])
})

afterAll(() => {
  if (previous.dsh === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previous.dsh
  if (previous.claude === undefined) delete process.env['CLAUDE_CONFIG_DIR']
  else process.env['CLAUDE_CONFIG_DIR'] = previous.claude
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A cursor-layout marketplace repo: `.cursor-plugin/marketplace.json` +
 * one plugin dir with `.cursor-plugin/plugin.json`, a skill, and a command. */
function writeCursorMarketplace(): { repo: string, id: string } {
  const repo = mkdtempSync(join(tmpdir(), 's6-e2e-mkt-'))
  tmpRoots.push(repo)
  mkdirSync(join(repo, '.cursor-plugin'), { recursive: true })
  writeFileSync(
    join(repo, '.cursor-plugin', 'marketplace.json'),
    JSON.stringify({ name: 'cursor-e2e', plugins: [{ name: 'alpha', source: 'alpha' }] }),
  )
  mkdirSync(join(repo, 'alpha', '.cursor-plugin'), { recursive: true })
  mkdirSync(join(repo, 'alpha', 'skills', 'greet'), { recursive: true })
  mkdirSync(join(repo, 'alpha', 'commands'), { recursive: true })
  writeFileSync(join(repo, 'alpha', '.cursor-plugin', 'plugin.json'), JSON.stringify({ name: 'alpha', version: '1.0.0' }))
  writeFileSync(join(repo, 'alpha', 'skills', 'greet', 'SKILL.md'), '---\nname: greet\ndescription: "says hi"\n---\n\nhello')
  writeFileSync(join(repo, 'alpha', 'commands', 'hello.md'), '---\ndescription: "hello command"\n---\n\nsay hello')
  return { repo, id: 'alpha@cursor-e2e' }
}

describe('S6 cc-shell e2e: cursor marketplace through manager + loader wiring', () => {
  it('marketplace add → install → mount → rescan mounts the cursor plugin with flavor cursor and usable components', async () => {
    const { repo, id } = writeCursorMarketplace()

    // /plugin marketplace add <dir> → install → enable, via the session
    // manager bound to the seeded dual homes.
    const manager = createSessionCcPluginManager()
    expect(await manager.addMarketplace(repo)).toMatchObject({ name: 'cursor-e2e', pluginCount: 1 })
    expect(await manager.install(id)).toMatchObject({ id, version: '1.0.0', scope: 'user' })
    expect(await manager.enable(id)).toMatchObject({ id, enabled: true })

    // The installed tree in the dsh cache keeps its cursor manifest.
    const installRoot = join(process.env['DSH_HOME']!, 'plugins', 'cache', 'cursor-e2e', 'alpha', '1.0.0')
    expect(existsSync(join(installRoot, '.cursor-plugin', 'plugin.json'))).toBe(true)

    // Loader discovery over the dual homes mounts the plugin; the shell
    // summary carries flavor 'cursor'.
    const skills: unknown[] = []
    const commands: string[] = []
    const ctx = new Context()
    ctx.provide('skills', { register: (skill: unknown) => { skills.push(skill); return () => {} } })
    ctx.provide('commands', { register: (definition: { name: string }) => { commands.push(definition.name); return () => { commands.splice(commands.indexOf(definition.name), 1) } } })
    const service = new CcPluginsService(ctx, {
      claudeHome: process.env['CLAUDE_CONFIG_DIR'],
      dshHome: process.env['DSH_HOME'],
      cwd: tmpdir(),
    })
    const errors = await service.mountAll()
    expect(errors).toEqual([])
    const summary = service.list().find(entry => entry.name === 'alpha')
    expect(summary).toBeDefined()
    expect(summary!.flavor).toBe('cursor')
    // Components usable through the host seams.
    expect(skills).toHaveLength(1)
    expect(commands).toContain('hello')

    // rescan over the manager state (disable → rescan drops the mount).
    await manager.disable(id)
    const rescanErrors = await service.rescan()
    expect(rescanErrors).toEqual([])
    expect(service.list().find(entry => entry.name === 'alpha')).toBeUndefined()
    expect(commands).not.toContain('hello')
    await ctx.fiber.dispose()
  })
})
