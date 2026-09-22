import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseClaudeCodeConfig } from '@dsh-cc/hooks-claude-code/src/config.ts'
import type { MatcherGroup } from '@dsh-cc/hook-protocol'

/**
 * Tracked-hooks.json guard: the repo-root hooks.json is the dogfooding config
 * the preset loads by launch cwd. The bridge logs-and-skips unsupported
 * entries at load time, so without this spec an invalid edit silently disables
 * a hook with zero user-visible signal. The serena pin half locks the sandbox
 * contract behind the 2026-09 incident fix: serena's remind counter persists
 * under SERENA_HOME, whose default (`~/.serena`) sits outside the session
 * sandbox's writable surface — serena swallows that failure, so the hook
 * no-ops forever unless every serena-hooks invocation pins SERENA_HOME into
 * the project.
 */

const REPO_ROOT = join(import.meta.dirname, '../../../..')
const SERENA_HOME_PIN = 'SERENA_HOME="${CLAUDE_PROJECT_DIR}/.serena"'

function commandsOf(groups: MatcherGroup[]): string[] {
  return groups.flatMap(group =>
    group.hooks.flatMap(hook => ('command' in hook && typeof hook.command === 'string' ? [hook.command] : [])),
  )
}

describe('tracked repo-root hooks.json', () => {
  const raw: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'hooks.json'), 'utf8'))
  const parsed = parseClaudeCodeConfig(raw)

  it('parses with zero skipped entries and zero warnings', () => {
    expect(parsed.skipped).toEqual([])
    expect(parsed.warnings).toEqual([])
  })

  it('pins SERENA_HOME into the project on every serena-hooks command', () => {
    const serena = commandsOf(Object.values(parsed.config).flat()).filter(c => c.includes('serena-hooks'))
    expect(serena.length).toBeGreaterThan(0)
    for (const command of serena) expect(command).toContain(SERENA_HOME_PIN)
  })

  it('runs serena cleanup on SessionEnd so per-session hook state does not accumulate', () => {
    const commands = commandsOf(parsed.config.SessionEnd ?? [])
    expect(commands.some(c => c.includes(`${SERENA_HOME_PIN} serena-hooks cleanup`))).toBe(true)
  })
})

/**
 * The dsh-cc-agents plugin ships the portable form of the same hooks (design:
 * docs/plans/2026-09-22-serena-hooks-agents-plugin.md). Its commands route
 * through plugin-shipped gate wrappers referenced via `${CLAUDE_PLUGIN_ROOT}`,
 * so the parse must pass pluginRoot — otherwise the substituted-command
 * assertions would test the template, not the shipped string. The SERENA_HOME
 * pin lives inside the wrappers (spawn env), which the last test checks by
 * reading the gate module source.
 */
describe('dsh-cc-agents plugin hooks.json', () => {
  const PLUGIN_ROOT = join(REPO_ROOT, 'packages/plugin/dsh-cc-agents')
  const raw: unknown = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks/hooks.json'), 'utf8'))
  const parsed = parseClaudeCodeConfig(raw, { pluginRoot: PLUGIN_ROOT })

  it('parses with zero skipped entries and zero warnings', () => {
    expect(parsed.skipped).toEqual([])
    expect(parsed.warnings).toEqual([])
  })

  it('routes remind/cleanup through the gate wrappers with explicit timeouts', () => {
    const pre = parsed.config.PreToolUse ?? []
    expect(pre.some(g => g.matcher === '^(read|grep)$|^mcp__serena__')).toBe(true)
    const preCommands = commandsOf(pre)
    expect(preCommands.some(c => c.endsWith('hooks/serena-remind.mjs"') && c.startsWith('node "'))).toBe(true)
    const sessionEndCommands = commandsOf(parsed.config.SessionEnd ?? [])
    expect(sessionEndCommands.some(c => c.endsWith('hooks/serena-session-cleanup.mjs"'))).toBe(true)
    for (const group of [...pre, ...(parsed.config.SessionEnd ?? [])]) {
      for (const hook of group.hooks) {
        expect('timeoutSec' in hook ? hook.timeoutSec : undefined).toBe(10)
      }
    }
  })

  it('the gate wrappers carry the SERENA_HOME project pin', () => {
    const gate = readFileSync(join(PLUGIN_ROOT, 'hooks/serena-gate.mjs'), 'utf8')
    expect(gate).toContain('SERENA_HOME')
    expect(gate).toContain("join(projectRoot, '.serena')")
  })
})
