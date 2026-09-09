/**
 * Install round-trip for the official dsh-cc marketplace and the
 * dsh-cc-agents plugin (docs/plans/2026-09-07-official-agents-plugin.md §5.6):
 *
 * The marketplace "clone" is materialized from GIT-TRACKED files only
 * (`git ls-files`), mirroring what a user's `/plugin marketplace add
 * dsh-cc/dsh-cc` clone would contain — a forgotten `git add` of a shipped
 * file (agent, skill, nested manifest) fails here, not in some user's
 * session. Then: installPlugin → cache copy → `mountCcPlugin` on the CACHED
 * copy must register both scoped agent providers (and the skill) from the
 * cache dir, not the repo working tree.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { GitRunner } from '../src/git.ts'
import { installPlugin } from '../src/install.ts'
import { cleanupTemps, tempDir } from './helpers.ts'

afterEach(cleanupTemps)

const NOW = () => new Date('2026-09-07T10:00:00.000Z')
const REPO_ROOT = resolve(import.meta.dirname, '../../../..')
const REAL_PLUGIN_DIR = 'packages/plugin/dsh-cc-agents'

/** Copy ONLY the git-tracked files of the real plugin into a fixture dir. */
function materializeGitClone(dest: string): void {
  const tracked = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', REAL_PLUGIN_DIR], { encoding: 'utf8' })
  const files = tracked.split('\n').map(line => line.trim()).filter(Boolean)
  expect(files.length, 'git tracks the plugin files').toBeGreaterThan(0)
  for (const rel of files) {
    const target = join(dest, rel)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(REPO_ROOT, rel), target)
  }
}

function fakeGit(): GitRunner {
  return async () => ({ code: 0, stdout: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\n', stderr: '' })
}

describe('dsh-cc-agents install round-trip (marketplace → cache → mount)', () => {
  it('installs from the git-tracked marketplace copy and mounts both scoped providers from the cache', async () => {
    const claudeHome = await tempDir('pm-dsh-cc-home-')
    const cwd = await tempDir('pm-dsh-cc-cwd-')
    const marketplacesDir = join(claudeHome, 'plugins', 'marketplaces')
    const cacheDir = join(claudeHome, 'plugins', 'cache')
    const marketplaceDir = join(marketplacesDir, 'dsh-cc')

    // 1. The marketplace clone: only git-tracked plugin files survive.
    materializeGitClone(marketplaceDir)
    mkdirSync(join(marketplaceDir, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'dsh-cc',
        plugins: [{ name: 'dsh-cc-agents', source: `./${REAL_PLUGIN_DIR}` }],
      }),
      'utf8',
    )

    // 2. Known-marketplace registration (directory source at the clone).
    writeFileSync(
      join(claudeHome, 'plugins', 'known_marketplaces.json'),
      JSON.stringify({
        'dsh-cc': {
          source: { source: 'directory', path: marketplaceDir },
          installLocation: marketplaceDir,
          lastUpdated: '2026-09-07T09:00:00.000Z',
        },
      }),
      'utf8',
    )

    // 3. Install → cache copy.
    const result = await installPlugin({
      claudeHome,
      cwd,
      now: NOW,
      runGit: fakeGit(),
    }, 'dsh-cc-agents@dsh-cc')
    expect(result.id).toBe('dsh-cc-agents@dsh-cc')
    // The marketplace copy IS the git-tracked manifest, so the installed
    // version must follow it — never hardcoded (a release bump would
    // otherwise break this spec every time).
    const shippedVersion = JSON.parse(
      readFileSync(join(REPO_ROOT, REAL_PLUGIN_DIR, '.claude-plugin', 'plugin.json'), 'utf8'),
    ).version as string
    expect(result.version).toBe(shippedVersion)
    const cachePath = join(cacheDir, 'dsh-cc', 'dsh-cc-agents', shippedVersion)
    expect(result.installPath).toBe(cachePath)
    // Every shipped component made it through the cache copy.
    expect(existsSync(join(cachePath, '.claude-plugin', 'plugin.json'))).toBe(true)
    expect(existsSync(join(cachePath, 'agents', 'critic.md'))).toBe(true)
    expect(existsSync(join(cachePath, 'agents', 'executor.md'))).toBe(true)
    expect(existsSync(join(cachePath, 'skills', 'dsh-cc-agents-orchestration', 'SKILL.md'))).toBe(true)

    // 4. Discovery: the installed+enabled entry is discoverable.
    // (State files were written by install; the loader's discovery contract
    // is pinned in cc-plugin-loader's own specs — here we mount the cache.)

    // 5. Mount the CACHED copy: both scoped providers register from the cache.
    const { mountCcPlugin } = await import('@dsh-cc/plugin-loader')
    const { Context } = await import('@deepseek-ai/cordis')
    const ctx = new Context()
    const names: string[] = []
    const skillNames: string[] = []
    const mount = await mountCcPlugin(ctx, {
      root: cachePath,
      nameHint: 'dsh-cc-agents',
      seams: {
        subagents: {
          registerProvider: (p) => { names.push((p as { name: string }).name); return () => {} },
          getProvider: () => undefined,
        },
        skills: {
          register: (skill) => { skillNames.push((skill as { name: string }).name); return () => {} },
        },
      },
    })
    try {
      expect(mount.report.name).toBe('dsh-cc-agents')
      expect(names.sort()).toEqual([
        'dsh-cc-agents:critic',
        'dsh-cc-agents:executor',
      ])
      expect(skillNames).toEqual(['dsh-cc-agents-orchestration'])
      const agents = mount.report.components.find(c => c.kind === 'agents')
      expect(agents?.loaded).toBe(2)
      const skills = mount.report.components.find(c => c.kind === 'skills')
      expect(skills?.loaded).toBe(1)
      expect(skills?.skipped).toBe(0)
    } finally {
      mount.dispose()
    }
  })
})
