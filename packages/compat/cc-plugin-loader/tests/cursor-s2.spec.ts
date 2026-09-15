/**
 * Cursor dialect S2: manifest evolution (rules, mcpServers array, metadata
 * warnings, glob policy, `.txt` commands), the §3.5 hooks mapping table, and
 * cursor MCP `${VAR}` semantics.
 *
 * @module
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mountCcPlugin } from '../src/index.ts'
import { parsePluginManifest } from '../src/manifest.ts'
import { makeContext } from './helpers.ts'

const cursorFixtures = join(import.meta.dirname, 'fixtures', 'cursor')

const allSeams = () => ({
  commands: { register: () => () => {} },
  settings: { set: () => () => {} },
  skills: { register: () => () => {} },
  subagents: { registerProvider: () => () => {}, getProvider: () => undefined },
  hooks: { mergePluginHooks: () => () => {} },
  mcp: { registerServer: () => () => {} },
})

const byKind = (report: { components: readonly { kind: string; loaded: number }[] }) =>
  Object.fromEntries(report.components.map(c => [c.kind, c]))

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
}

describe('A1: rules field', () => {
  it('parses stringOrArray rules and retains them', () => {
    const single = parsePluginManifest({ name: 'r', rules: 'rules' }, 'r', { flavor: 'cursor' })
    expect(single.rules).toEqual(['rules'])
    const list = parsePluginManifest({ name: 'r', rules: ['a', 'b'] }, 'r', { flavor: 'cursor' })
    expect(list.rules).toEqual(['a', 'b'])
  })

  it('rejects a rules map with an error naming the plugin', () => {
    expect(() => parsePluginManifest({ name: 'r', rules: { a: 'x' } }, 'r', { flavor: 'cursor' }))
      .toThrow(/plugin r.*"rules"/)
  })
})

describe('A2: mcpServers array form', () => {
  it('flattens an array of paths and inline objects', () => {
    const parsed = parsePluginManifest({
      name: 'm',
      mcpServers: ['./mcp.json', { inline: { type: 'stdio', command: 'echo' } }],
    }, 'm', { flavor: 'cursor' })
    expect(parsed.mcpServersPath).toBe('./mcp.json')
    expect(parsed.mcpServers['inline']).toEqual({ type: 'stdio', command: 'echo' })
  })

  it('mounts servers from an array-form manifest', async () => {
    const root = await tempDir('s2-mcp-array-')
    await mkdir(join(root, '.cursor-plugin'), { recursive: true })
    await writeJson(join(root, '.cursor-plugin', 'plugin.json'), {
      name: 'm',
      mcpServers: [{ inline: { type: 'stdio', command: 'echo' } }],
    })
    const registered: string[] = []
    const ctx = makeContext()
    const mount = await mountCcPlugin(ctx, {
      root,
      seams: { ...allSeams(), mcp: { registerServer: name => { registered.push(name); return () => {} } } },
    })
    try {
      expect(registered).toEqual(['inline'])
      expect(byKind(mount.report)['mcpServers']?.loaded).toBe(1)
    } finally {
      mount.dispose()
    }
  })
})

describe('A3: minClientVersions / variables warnings', () => {
  it('warns on the github-mcp fixture and keeps metadata tolerated', async () => {
    const ctx = makeContext()
    const mount = await mountCcPlugin(ctx, { root: join(cursorFixtures, 'github-mcp'), seams: allSeams() })
    try {
      expect(mount.report.name).toBe('github')
      expect(mount.report.flavor).toBe('cursor')
      expect(mount.report.warnings).toContain('client-version gating is not enforced')
      expect(mount.report.warnings).toContain('plugin variables are not prompted; set values via environment')
    } finally {
      mount.dispose()
    }
  })
})

describe('A4: glob policy', () => {
  it('expands `/**` component paths and skips other globs with a warning', async () => {
    const root = await tempDir('s2-globs-')
    for (const rel of [
      'skills/deep/nested/SKILL.md',
      'commands/sub/one.md',
      'agents/two.md',
    ]) {
      await mkdir(join(root, rel, '..'), { recursive: true })
      await writeFile(join(root, rel), rel.endsWith('SKILL.md')
        ? '---\ndescription: s\n---\nbody'
        : '---\ndescription: c\n---\nbody', 'utf8')
    }
    await mkdir(join(root, '.cursor-plugin'), { recursive: true })
    await writeJson(join(root, '.cursor-plugin', 'plugin.json'), {
      name: 'g',
      skills: 'skills/**',
      commands: 'commands/**',
      agents: 'agents/**',
    })
    const ctx = makeContext()
    const mount = await mountCcPlugin(ctx, { root, seams: allSeams() })
    try {
      const byKindReport = byKind(mount.report)
      expect(byKindReport['skills']?.loaded).toBe(1)
      expect(byKindReport['commands']?.loaded).toBe(1)
      expect(byKindReport['agents']?.loaded).toBe(1)
    } finally {
      mount.dispose()
    }
  })

  it('skips non-recursive globs with a warning naming the pattern', async () => {
    const root = await tempDir('s2-badglob-')
    await mkdir(join(root, '.cursor-plugin'), { recursive: true })
    await writeJson(join(root, '.cursor-plugin', 'plugin.json'), {
      name: 'b',
      commands: 'commands/*.md',
    })
    const ctx = makeContext()
    const mount = await mountCcPlugin(ctx, { root, seams: allSeams() })
    try {
      expect(byKind(mount.report)['commands']?.loaded).toBe(0)
      expect(mount.report.warnings.some(w => w.includes('commands/*.md'))).toBe(true)
    } finally {
      mount.dispose()
    }
  })
})

describe('A5: .txt commands on cursor flavor', () => {
  it('mounts bye.txt as a command for the cursor minimal fixture', async () => {
    const ctx = makeContext()
    const mount = await mountCcPlugin(ctx, { root: join(cursorFixtures, 'minimal'), seams: allSeams() })
    try {
      expect(mount.commands.map(c => c.info.name)).toContain('cursor-minimal:bye')
    } finally {
      mount.dispose()
    }
  })

  it('does not mount .txt commands for an equivalent cc-flavored tree', async () => {
    const root = await tempDir('s2-cc-txt-')
    await mkdir(join(root, 'commands'), { recursive: true })
    await writeFile(join(root, 'commands', 'bye.txt'), 'Say bye to the user.', 'utf8')
    await writeJson(join(root, 'plugin.json'), { name: 'cc-txt' })
    const ctx = makeContext()
    const mount = await mountCcPlugin(ctx, { root, seams: allSeams() })
    try {
      expect(mount.commands.map(c => c.info.name)).not.toContain('cc-txt:bye')
      expect(mount.report.flavor).toBe('cc')
    } finally {
      mount.dispose()
    }
  })
})

describe('B: hooks mapping table', () => {
  it('maps cursor events to CC events and warns on unmapped ones', async () => {
    const merged: { config: Record<string, unknown>; root?: string }[] = []
    const ctx = makeContext()
    const mount = await mountCcPlugin(ctx, {
      root: join(cursorFixtures, 'minimal'),
      seams: {
        ...allSeams(),
        hooks: { mergePluginHooks: (_n, config, root) => { merged.push({ config, root }); return () => {} } },
      },
    })
    try {
      const config = merged[0]?.config as Record<string, unknown>
      expect(Object.keys(config).sort()).toEqual([
        'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PreToolUse',
        'SessionEnd', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit',
      ].sort())
      // Wire shape translated: flat cursor entries become matcher groups.
      const start = config['SessionStart'] as { hooks: { command: string }[] }[]
      expect(start[0]?.hooks?.[0]?.command).toBe('echo start')
      const pre = config['PreToolUse'] as { matcher?: string; hooks: { command: string }[] }[]
      expect(pre[0]?.matcher).toBe('Bash')
      const post = config['PostToolUse'] as { matcher?: string }[]
      expect(post[0]?.matcher).toBeUndefined()
      // Unmapped event is skipped with a warning naming it.
      const hooks = byKind(mount.report)['hooks']
      expect(hooks?.reasons.some(r => r.includes('afterAgentResponse'))).toBe(true)
    } finally {
      mount.dispose()
    }
  })

  it('warns on unsupported cursor entry fields (loop_limit)', async () => {
    const root = await tempDir('s2-loop-limit-')
    await mkdir(join(root, 'hooks'), { recursive: true })
    await writeJson(join(root, 'hooks', 'hooks.json'), {
      version: 1,
      hooks: { sessionStart: [{ command: 'echo hi', loop_limit: 3 }] },
    })
    await writeJson(join(root, '.cursor-plugin', 'plugin.json'), { name: 'll' })
    const ctx = makeContext()
    const mount = await mountCcPlugin(ctx, { root, seams: allSeams() })
    try {
      expect(mount.report.warnings.some(w => w.includes('loop_limit'))).toBe(true)
    } finally {
      mount.dispose()
    }
  })
})

describe('D: cursor MCP ${VAR} semantics', () => {
  it('substitutes ${CURSOR_PLUGIN_ROOT} in server configs', async () => {
    const configs: Record<string, unknown>[] = []
    const ctx = makeContext()
    const mount = await mountCcPlugin(ctx, {
      root: join(cursorFixtures, 'minimal'),
      seams: { ...allSeams(), mcp: { registerServer: (_n, config) => { configs.push(config); return () => {} } } },
    })
    try {
      expect((configs[0] as { args: string[] })['args']).toEqual([`${join(cursorFixtures, 'minimal')}/server.js`])
    } finally {
      mount.dispose()
    }
  })

  it('fails only the offending server with a warning naming the variable', async () => {
    const root = await tempDir('s2-var-')
    await mkdir(join(root, '.cursor-plugin'), { recursive: true })
    await writeJson(join(root, '.cursor-plugin', 'plugin.json'), { name: 'v' })
    await writeJson(join(root, 'mcp.json'), {
      mcpServers: {
        good: { type: 'stdio', command: 'echo' },
        bad: { type: 'http', url: 'https://x/${S2_MISSING_VAR}' },
      },
    })
    const registered: string[] = []
    const ctx = makeContext()
    const mount = await mountCcPlugin(ctx, {
      root,
      seams: { ...allSeams(), mcp: { registerServer: name => { registered.push(name); return () => {} } } },
    })
    try {
      expect(registered).toEqual(['good'])
      const mcp = byKind(mount.report)['mcpServers']
      expect(mcp?.skipped).toBe(1)
      expect(mcp?.reasons.some(r => r.includes('S2_MISSING_VAR'))).toBe(true)
      expect(mount.report.warnings.some(w => w.includes('S2_MISSING_VAR'))).toBe(true)
    } finally {
      mount.dispose()
    }
  })

  it('resolves a present variable and never interpolates empty silently', async () => {
    const root = await tempDir('s2-var-set-')
    await mkdir(join(root, '.cursor-plugin'), { recursive: true })
    await writeJson(join(root, '.cursor-plugin', 'plugin.json'), { name: 'vs' })
    await writeJson(join(root, 'mcp.json'), {
      mcpServers: { s: { type: 'http', url: 'https://x/${S2_SET_VAR}' } },
    })
    const configs: Record<string, unknown>[] = []
    const ctx = makeContext()
    const previous = process.env['S2_SET_VAR']
    process.env['S2_SET_VAR'] = 'token-value'
    try {
      await mountCcPlugin(ctx, {
        root,
        seams: { ...allSeams(), mcp: { registerServer: (_n, config) => { configs.push(config); return () => {} } } },
      })
      expect(configs[0]).toMatchObject({ url: 'https://x/token-value' })
    } finally {
      if (previous === undefined) delete process.env['S2_SET_VAR']
      else process.env['S2_SET_VAR'] = previous
      await rm(root, { recursive: true, force: true })
    }
  })
})
