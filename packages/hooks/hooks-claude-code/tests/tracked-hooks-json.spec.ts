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
