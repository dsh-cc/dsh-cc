import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseClaudeCodeConfig } from '@dsh-cc/hooks-claude-code/src/config.ts'
import type { MatcherGroup } from '@dsh-cc/hook-protocol'

/**
 * Tracked-hooks.json guard: the bridge logs-and-skips unsupported entries at
 * load time, so without this spec an invalid edit silently disables a hook
 * with zero user-visible signal. It watches both hook config files this repo
 * ships: the repo-root hooks.json (dogfooding config the preset loads by
 * launch cwd — watchdog/nudge scripts only since PR-B) and the dsh-cc-agents
 * plugin's hooks/hooks.json (the portable serena pair since PR-A). The
 * sandbox contract behind the 2026-09 incident fix is pinned on the plugin
 * side: serena's `~/.serena` default sits outside the session sandbox's
 * writable surface, so the gate wrappers pin SERENA_HOME into the project.
 */

const REPO_ROOT = join(import.meta.dirname, '../../../..')

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

  it('carries NO serena-hooks command (single-channel rule: they live in the dsh-cc-agents plugin)', () => {
    // Regression lock for the PR-A → PR-B handover: plugin hook groups append
    // after launch-cwd groups and both fire, so a repo-side serena entry
    // double-counts the plugin's shared burst counter.
    const all = commandsOf(Object.values(parsed.config).flat())
    expect(all.filter(c => c.includes('serena-hooks'))).toEqual([])
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
