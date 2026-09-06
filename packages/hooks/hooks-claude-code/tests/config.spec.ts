import { describe, expect, it } from 'vitest'
import { parseClaudeCodeConfig, substituteCommand, SUPPORTED_CLAUDE_EVENTS } from '@dsh-cc/hooks-claude-code/src/config.ts'

describe('substituteCommand', () => {
  it('replaces CLAUDE_PLUGIN_ROOT and CLAUDE_PROJECT_DIR (all occurrences)', () => {
    expect(substituteCommand('${CLAUDE_PLUGIN_ROOT}/x.sh', { pluginRoot: '/p' })).toBe('/p/x.sh')
    expect(substituteCommand('${CLAUDE_PROJECT_DIR}/a ${CLAUDE_PROJECT_DIR}/b', { projectDir: '/proj' })).toBe('/proj/a /proj/b')
    expect(substituteCommand('${CLAUDE_PLUGIN_ROOT}-${CLAUDE_PROJECT_DIR}', { pluginRoot: '/p', projectDir: '/d' })).toBe('/p-/d')
  })
  it('leaves the command untouched when no vars are supplied', () => {
    expect(substituteCommand('${CLAUDE_PLUGIN_ROOT}/x', {})).toBe('${CLAUDE_PLUGIN_ROOT}/x')
  })
})

describe('parseClaudeCodeConfig', () => {
  it('parses a bare event map and a settings-style { hooks: … } wrapper identically', () => {
    const groups = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x.sh' }] }] }
    const bare = parseClaudeCodeConfig(groups)
    const wrapped = parseClaudeCodeConfig({ hooks: groups })
    expect(bare.config).toEqual(wrapped.config)
    expect(bare.config.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ command: 'x.sh' }] }])
  })

  it('carries timeout → timeoutSec and substitutes the command', () => {
    const { config } = parseClaudeCodeConfig(
      { Stop: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/s.sh', timeout: 30 }] }] },
      { pluginRoot: '/p' },
    )
    expect(config.Stop).toEqual([{ hooks: [{ command: '/p/s.sh', timeoutSec: 30 }] }])
  })

  it('parses command, prompt, http, and agent hooks in the same group, keeping wire fields', () => {
    const { config, skipped } = parseClaudeCodeConfig({
      PreToolUse: [{ hooks: [
        { type: 'prompt', prompt: 'is this ok?', model: 'claude-sonnet', timeout: 7 },
        { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/ok.sh' },
        { type: 'http', url: 'http://x', headers: { Authorization: 'Bearer $T' }, allowedEnvVars: ['T'], timeout: 3 },
        { type: 'agent', prompt: 'verify the build', model: 'claude-haiku' },
      ] }],
    }, { pluginRoot: '/p' })
    expect(config.PreToolUse).toEqual([{ hooks: [
      { type: 'prompt', prompt: 'is this ok?', model: 'claude-sonnet', timeoutSec: 7 },
      { command: '/p/ok.sh' },
      { type: 'http', url: 'http://x', headers: { Authorization: 'Bearer $T' }, allowedEnvVars: ['T'], timeoutSec: 3 },
      { type: 'agent', prompt: 'verify the build', model: 'claude-haiku' },
    ] }])
    expect(skipped).toEqual([])
  })

  it('skips hooks of an unknown executor type (recorded) and keeps the known ones', () => {
    const { config, skipped } = parseClaudeCodeConfig({
      PreToolUse: [{ hooks: [
        { type: 'mcp_tool', name: 'x' }, // unknown type → skipped
        { type: 'command', command: 'ok.sh' },
        { type: 'http', url: 'http://x' },
      ] }],
    })
    expect(config.PreToolUse![0]!.hooks.map(h => h.type)).toEqual([undefined, 'http'])
    expect(skipped).toEqual([{ event: 'PreToolUse', type: 'mcp_tool', reason: 'unknown hook type' }])
  })

  it('drops a malformed http hook without a url string', () => {
    const { config, skipped } = parseClaudeCodeConfig({ PreToolUse: [{ hooks: [{ type: 'http', url: 5 }] }] })
    expect(config.PreToolUse).toBeUndefined()
    expect(skipped).toEqual([{ event: 'PreToolUse', type: 'http', reason: 'malformed http' }])
  })

  it('treats a hook with no `type` as a command (CC default)', () => {
    const { config } = parseClaudeCodeConfig({ Stop: [{ hooks: [{ command: 'd.sh' }] }] })
    expect(config.Stop).toEqual([{ hooks: [{ command: 'd.sh' }] }])
  })

  it('drops malformed entries without throwing: non-array groups, non-object group/hook, missing command, empty groups', () => {
    expect(parseClaudeCodeConfig({ PreToolUse: 'nope' }).config).toEqual({})
    expect(parseClaudeCodeConfig({ PreToolUse: [42, { hooks: 'no' }, { hooks: [7, { type: 'command' }] }] }).config).toEqual({})
    // a group whose only hook lacks a command string drops the whole (empty) group
    expect(parseClaudeCodeConfig({ Stop: [{ hooks: [{ type: 'command', command: 5 }] }] }).config).toEqual({})
  })

  it('records a skipped row for every malformed hook, with the matching reason', () => {
    expect(parseClaudeCodeConfig({ PreToolUse: [{ hooks: [7] }] }).skipped)
      .toEqual([{ event: 'PreToolUse', type: 'command', reason: 'malformed hook' }])
    expect(parseClaudeCodeConfig({ PreToolUse: [{ hooks: [{ type: 'command' }] }] }).skipped)
      .toEqual([{ event: 'PreToolUse', type: 'command', reason: 'malformed command' }])
    expect(parseClaudeCodeConfig({ Stop: [{ hooks: [{ type: 'command', command: 5 }] }] }).skipped)
      .toEqual([{ event: 'Stop', type: 'command', reason: 'malformed command' }])
    expect(parseClaudeCodeConfig({ PreToolUse: [{ hooks: [{ type: 'http', url: 5 }] }] }).skipped)
      .toEqual([{ event: 'PreToolUse', type: 'http', reason: 'malformed http' }])
    expect(parseClaudeCodeConfig({ PreToolUse: [{ hooks: [{ type: 'mcp_tool' }] }] }).skipped)
      .toEqual([{ event: 'PreToolUse', type: 'mcp_tool', reason: 'unknown hook type' }])
  })

  it('returns empty for a non-object / null / array top level', () => {
    expect(parseClaudeCodeConfig(null).config).toEqual({})
    expect(parseClaudeCodeConfig(42).config).toEqual({})
    expect(parseClaudeCodeConfig([1, 2]).config).toEqual({})
  })

  it('omits the matcher key when the group has none (match-all)', () => {
    const { config } = parseClaudeCodeConfig({ Stop: [{ hooks: [{ type: 'command', command: 's.sh' }] }] })
    expect('matcher' in config.Stop![0]!).toBe(false)
  })

  it('rejects an invalid regex matcher with its event name', () => {
    expect(() => parseClaudeCodeConfig({
      PreToolUse: [{ matcher: '(', hooks: [{ type: 'command', command: 'x.sh' }] }],
    })).toThrow('invalid claude-code regex matcher "(" on event "PreToolUse"')
  })

  it('discards matcher fields on events without matcher subjects before validation', () => {
    const { config } = parseClaudeCodeConfig({
      UserPromptSubmit: [{ matcher: '[', hooks: [{ type: 'command', command: 'prompt.sh' }] }],
      Stop: [{ matcher: '(', hooks: [{ type: 'command', command: 'stop.sh' }] }],
    })

    expect(config).toEqual({
      UserPromptSubmit: [{ hooks: [{ command: 'prompt.sh' }] }],
      Stop: [{ hooks: [{ command: 'stop.sh' }] }],
    })
  })

  it('ignores invalid matchers on unsupported events without dropping supported hooks', () => {
    const { config } = parseClaudeCodeConfig({
      PreCompact: [{ matcher: '(', hooks: [{ type: 'command', command: 'ignored.sh' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'kept.sh' }] }],
    })

    expect(config).toEqual({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'kept.sh' }] }],
    })
  })
})

describe('SUPPORTED_CLAUDE_EVENTS', () => {
  it('exposes the supported event list (readonly strings, matching the parsed keys)', () => {
    expect(SUPPORTED_CLAUDE_EVENTS).toContain('PreToolUse')
    expect(SUPPORTED_CLAUDE_EVENTS).toContain('Stop')
    expect(SUPPORTED_CLAUDE_EVENTS).not.toContain('UserPromptCancel')
    // Every supported key parses; an unsupported key warns instead.
    const config = Object.fromEntries(SUPPORTED_CLAUDE_EVENTS.map(e => [e, [{ hooks: [{ command: 'x.sh' }] }]]))
    expect(parseClaudeCodeConfig(config).config && Object.keys(parseClaudeCodeConfig(config).config).sort())
      .toEqual([...SUPPORTED_CLAUDE_EVENTS].sort())
  })
})

describe('parseClaudeCodeConfig — F6 warnings', () => {
  it('returns an empty warnings array for a fully-supported config', () => {
    const { warnings } = parseClaudeCodeConfig({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x.sh', timeout: 5 }] }],
      Stop: [{ hooks: [{ type: 'prompt', prompt: 'ok', model: 'm' }] }],
    })
    expect(warnings).toEqual([])
  })

  it('warns per handler with keys outside the per-type allowlist', () => {
    const { warnings } = parseClaudeCodeConfig({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x.sh', async: true, once: true }] }],
      Stop: [{ hooks: [{ type: 'agent', prompt: 'v', model: 'm', temperature: 0.5 }] }],
    })
    expect(warnings).toEqual([
      { event: 'PreToolUse', matcher: 'Bash', hookType: 'command', keys: ['async', 'once'] },
      { event: 'Stop', hookType: 'agent', keys: ['temperature'] },
    ])
  })

  it('warns for each executor kind with its own allowlist (prompt/http/agent)', () => {
    const { warnings } = parseClaudeCodeConfig({
      PreToolUse: [{ hooks: [
        { type: 'prompt', prompt: 'p', extra: 1 },
        { type: 'http', url: 'http://x', headers: {}, allowedEnvVars: [], unknownFlag: true },
        { type: 'agent', prompt: 'a', model: 'm', foobar: 2 },
        { type: 'command', command: 'c', widget: 3 },
      ] }],
    })
    expect(warnings.map(w => [w.hookType, w.keys])).toEqual([
      ['prompt', ['extra']],
      ['http', ['unknownFlag']],
      ['agent', ['foobar']],
      ['command', ['widget']],
    ])
    expect(warnings.every(w => w.event === 'PreToolUse' && w.matcher === undefined)).toBe(true)
  })

  it('warns once per unknown event key in the hooks map', () => {
    const { config, warnings } = parseClaudeCodeConfig({
      PreToolUse: [{ hooks: [{ command: 'x.sh' }] }],
      PreCompact: [{ hooks: [{ command: 'nope.sh' }] }],
      UsrPromptSubmit: [{ hooks: [{ command: 'typo.sh' }] }],
    })
    expect(Object.keys(config)).toEqual(['PreToolUse'])
    expect(warnings).toEqual([
      { event: 'PreCompact', hookType: 'event', keys: [] },
      { event: 'UsrPromptSubmit', hookType: 'event', keys: [] },
    ])
  })

  it('warns per matcher-group with unknown group-level keys (only matcher/hooks are known)', () => {
    const { config, warnings } = parseClaudeCodeConfig({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'x.sh' }], background: true }],
      Stop: [{ hooks: [{ command: 's.sh' }], priority: 1, mode: 'x' }],
    })
    expect(config.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ command: 'x.sh' }] }])
    expect(warnings).toEqual([
      { event: 'PreToolUse', matcher: 'Bash', hookType: 'group', keys: ['background'] },
      { event: 'Stop', hookType: 'group', keys: ['priority', 'mode'] },
    ])
  })

  it('a command hook missing a string command lands in skipped (with its unknown-key warning)', () => {
    const { config, skipped, warnings } = parseClaudeCodeConfig({
      PreToolUse: [{ hooks: [{ type: 'command', note: 'missing command' }] }],
    })
    expect(config.PreToolUse).toBeUndefined()
    expect(skipped).toEqual([{ event: 'PreToolUse', type: 'command', reason: 'malformed command' }])
    expect(warnings).toEqual([{ event: 'PreToolUse', matcher: undefined, hookType: 'command', keys: ['note'] }])
  })
})

describe('parseClaudeCodeConfig — non-command field fallthrough arms', () => {
  it('defaults a non-string prompt/model and drops non-string http header values + allowedEnvVars', () => {
    const { config, skipped } = parseClaudeCodeConfig({
      PreToolUse: [{ hooks: [
        { type: 'prompt', prompt: 5, model: 7 },
        { type: 'http', url: 'http://x', headers: { A: 5 }, allowedEnvVars: [5] },
        { type: 'agent', prompt: 9 },
      ] }],
    })
    const hooks = config.PreToolUse![0]!.hooks
    // prompt with a non-string prompt → prompts to ''; non-string model ignored.
    expect(hooks[0]).toEqual({ type: 'prompt', prompt: '' })
    // http with only non-string header values → headers absent; non-string allowedEnvVars → absent.
    expect(hooks[1]).toEqual({ type: 'http', url: 'http://x' })
    // agent with a non-string prompt → prompt to ''.
    expect(hooks[2]).toEqual({ type: 'agent', prompt: '' })
    expect(skipped).toEqual([])
  })

  it('carries an agent timeoutSec when set (the set-path arm)', () => {
    const { config } = parseClaudeCodeConfig({
      Stop: [{ hooks: [{ type: 'agent', prompt: 'verify', timeout: 45 }] }],
    })
    expect(config.Stop![0]!.hooks[0]).toEqual({ type: 'agent', prompt: 'verify', timeoutSec: 45 })
  })

  it('drops a negative/zero/fractional timeout (invalid timeoutSec)', () => {
    const { config } = parseClaudeCodeConfig({
      PreToolUse: [{ hooks: [
        { type: 'command', command: 'c.sh', timeout: -1 },
        { type: 'http', url: 'http://x', timeout: 0 },
      ] }],
    })
    expect(config.PreToolUse![0]!.hooks).toEqual([{ command: 'c.sh' }, { type: 'http', url: 'http://x' }])
  })
})
