import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allowRuleOf, createDriver, payloadOf } from '@dsh-cc/tui/harness/driver.ts'
import { PERMISSION_SETTINGS_NAMESPACE, contentMatches, parseRuleString, ruleString } from '@dsh-cc/permission-rules'

/**
 * Approval-as-preview + always-allow contract: the approval prompt carries a
 * structured payload preview recovered from the paired tool/call event, and
 * the "always" answer persists a permission rule derived from that preview
 * through the settings provider's `permissions` namespace.
 */

/** Structural stand-in for an ApprovalRequest (only the fields payloadOf reads). */
function previewReq(
  toolName: string,
  callId: string | undefined,
  events: unknown[] = [],
): Parameters<typeof payloadOf>[0] {
  return {
    agent: { session: { events, snapshotEvents() { return this.events } } },
    toolName,
    ...(callId === undefined ? {} : { callId }),
  } as Parameters<typeof payloadOf>[0]
}

const callEvent = (callId: string, args: unknown): unknown => ({
  type: 'tool/call',
  data: { callId, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
})

describe('payloadOf dispatch', () => {
  it('maps shell-style arguments to the command kind', () => {
    const preview = payloadOf(previewReq('Bash', 'c1', [callEvent('c1', { command: 'git push --force' })]))
    expect(preview).toEqual({ kind: 'command', command: 'git push --force' })
  })

  it('maps Edit arguments to a single-hunk diff preview', () => {
    const preview = payloadOf(previewReq('Edit', 'c2', [
      callEvent('c2', { file_path: '/tmp/a.ts', old_string: 'const a = 1\n', new_string: 'const a = 2\n' }),
    ]))
    expect(preview).toEqual({
      kind: 'diff',
      diffs: [{ path: '/tmp/a.ts', oldText: 'const a = 1\n', newText: 'const a = 2\n' }],
    })
  })

  it('maps Write arguments to a wholesale diff (oldText null)', () => {
    const preview = payloadOf(previewReq('Write', 'c3', [
      callEvent('c3', { file_path: '/tmp/new.ts', content: 'export {}\n' }),
    ]))
    expect(preview).toEqual({
      kind: 'diff',
      diffs: [{ path: '/tmp/new.ts', oldText: null, newText: 'export {}\n' }],
    })
  })

  it('maps MultiEdit arguments to one diff per edit on the same path', () => {
    const preview = payloadOf(previewReq('MultiEdit', 'c4', [
      callEvent('c4', {
        file_path: '/tmp/b.ts',
        edits: [
          { old_string: 'one', new_string: '1' },
          { old_string: 'two', new_string: '2' },
        ],
      }),
    ]))
    expect(preview).toEqual({
      kind: 'diff',
      diffs: [
        { path: '/tmp/b.ts', oldText: 'one', newText: '1' },
        { path: '/tmp/b.ts', oldText: 'two', newText: '2' },
      ],
    })
  })

  it('maps any other tool to a pretty-printed args preview', () => {
    const preview = payloadOf(previewReq('WebFetch', 'c5', [
      callEvent('c5', { url: 'https://example.com', prompt: 'summarize' }),
    ]))
    expect(preview).toEqual({
      kind: 'args',
      json: JSON.stringify({ url: 'https://example.com', prompt: 'summarize' }, null, 2),
    })
  })

  it('truncates a huge args preview to the character cap', () => {
    const preview = payloadOf(previewReq('WebFetch', 'c6', [
      callEvent('c6', { blob: 'x'.repeat(5000) }),
    ]))
    expect(preview.kind).toBe('args')
    expect((preview as { json: string }).json.length).toBeLessThanOrEqual(500)
  })

  it('degrades to none when the callId is missing', () => {
    expect(payloadOf(previewReq('Bash', undefined))).toEqual({ kind: 'none' })
  })

  it('degrades to none when no tool/call carries the callId', () => {
    const preview = payloadOf(previewReq('Bash', 'missing', [callEvent('other', { command: 'ls' })]))
    expect(preview).toEqual({ kind: 'none' })
  })

  it('falls back to the raw text when the stored arguments are not JSON', () => {
    const preview = payloadOf(previewReq('Bash', 'c7', [
      { type: 'tool/call', data: { callId: 'c7', arguments: 'not-json{' } },
    ]))
    expect(preview).toEqual({ kind: 'args', json: 'not-json{' })
  })

  it('degrades to none when the paired arguments are not a string', () => {
    const preview = payloadOf(previewReq('Bash', 'c8', [
      { type: 'tool/call', data: { callId: 'c8', arguments: 42 } },
    ]))
    expect(preview).toEqual({ kind: 'none' })
  })
})

describe('allowRuleOf rule generation', () => {
  it('writes a trailing-space first-word prefix rule for shell commands', () => {
    expect(allowRuleOf('Bash', { kind: 'command', command: 'npm install foo' })).toBe('Bash(npm )')
  })

  it('round-trips the Bash rule through the real parser and matches the approved command', () => {
    const rule = allowRuleOf('Bash', { kind: 'command', command: 'npm install foo' })!
    expect(rule).toBe('Bash(npm )')
    const parsed = parseRuleString(rule)
    expect(parsed.matcher).toEqual({ kind: 'prefix', prefix: 'npm ' })
    expect(contentMatches(parsed.matcher!, 'npm install foo')).toBe(true)
    // The trailing space keeps sibling prefixes out: `npmx …` never matches.
    expect(contentMatches(parsed.matcher!, 'npmx install foo')).toBe(false)
  })

  it('escapes and round-trips a first word that opens a subshell', () => {
    const command = '(cd /tmp && ls)'
    const rule = allowRuleOf('Bash', { kind: 'command', command })!
    const parsed = parseRuleString(rule)
    expect(parsed.matcher).toEqual({ kind: 'prefix', prefix: '(cd ' })
    expect(contentMatches(parsed.matcher!, command)).toBe(true)
  })

  it('writes a domain rule on the exact WebFetch host', () => {
    expect(allowRuleOf('WebFetch', { kind: 'args', json: '{"url":"https://docs.example.com/a"}' }))
      .toBe('WebFetch(domain:docs.example.com)')
    // Harness spelling gets the same treatment; lowercased, port dropped.
    expect(allowRuleOf('web_fetch', { kind: 'args', json: '{"url":"https://Example.COM.:8443/x"}' }))
      .toBe('WebFetch(domain:example.com)')
  })

  it('keeps the whole-tool WebFetch rule when the args carry no parsable URL', () => {
    expect(allowRuleOf('WebFetch', { kind: 'args', json: 'not-json{' })).toBe('WebFetch')
    expect(allowRuleOf('WebFetch', { kind: 'args', json: '{"url":"not a url"}' })).toBe('WebFetch')
    expect(allowRuleOf('WebFetch', { kind: 'args', json: '{}' })).toBe('WebFetch')
  })

  it('writes a whole-tool rule for non-shell tools', () => {    expect(allowRuleOf('Write', { kind: 'diff', diffs: [] })).toBe('Write')
    expect(allowRuleOf('WebFetch', { kind: 'args', json: '{}' })).toBe('WebFetch')
    expect(allowRuleOf('Read', undefined)).toBe('Read')
    expect(allowRuleOf('Read', { kind: 'none' })).toBe('Read')
    const parsed = parseRuleString(allowRuleOf('Write', { kind: 'diff', diffs: [] })!)
    expect(parsed.toolName).toBe('Write')
    expect(parsed.content).toBeUndefined()
  })

  it('returns undefined for a blank command or tool name (once-only fallback)', () => {
    expect(allowRuleOf('Bash', { kind: 'command', command: '   ' })).toBeUndefined()
    expect(allowRuleOf('  ', undefined)).toBeUndefined()
  })

  it('keeps ruleString escaping symmetric for a plain prefix', () => {
    expect(ruleString('Bash', 'npm ')).toBe('Bash(npm )')
  })

  it('strips environment variable prefixes when deriving rules', () => {
    // FOO=bar npm install → should derive rule for npm, not FOO=bar
    expect(allowRuleOf('Bash', { kind: 'command', command: 'FOO=bar npm install' })).toBe('Bash(npm )')
    expect(allowRuleOf('Bash', { kind: 'command', command: 'FOO=bar BAZ=qux npm install' })).toBe('Bash(npm )')
    // With sudo
    expect(allowRuleOf('Bash', { kind: 'command', command: 'sudo npm install' })).toBe('Bash(npm )')
    // With npx
    expect(allowRuleOf('Bash', { kind: 'command', command: 'npx npm install' })).toBe('Bash(npm )')
  })

  it('handles compound commands by deriving from the first segment', () => {
    // git add . && git commit → should derive from git add
    expect(allowRuleOf('Bash', { kind: 'command', command: 'git add . && git commit' })).toBe('Bash(git )')
    // With env prefix in first segment
    expect(allowRuleOf('Bash', { kind: 'command', command: 'FOO=bar git add . && git commit' })).toBe('Bash(git )')
  })
})

/** Minimal approval request the driver's approval/request handler accepts. */
interface FakeApprovalRequest {
  agent: { id: string; session: { id: string; events: unknown[] } }
  toolName: string
  callId?: string
  reason?: string
  signal?: AbortSignal
}

interface ReplaceCall {
  ns: unknown
  section: Record<string, unknown>
  revision?: number
}

/** Fake settings provider capturing replace() payloads; can conflict once. */
function makeSettingsProvider(user: Record<string, unknown> = {}): {
  writable: boolean
  describe(): { ns: unknown; revision: number; user: Record<string, unknown> }[]
  replace(ns: unknown, section: object, expectedRevision?: number): Promise<void>
  replaceCalls: ReplaceCall[]
  conflictOnce: boolean
} {
  const provider = {
    writable: true,
    replaceCalls: [] as ReplaceCall[],
    conflictOnce: false,
    revision: 0,
    currentUser: structuredClone(user),
    describe() {
      return [{
        ns: PERMISSION_SETTINGS_NAMESPACE,
        revision: provider.revision,
        user: structuredClone(provider.currentUser),
      }]
    },
    async replace(ns: unknown, section: object, expectedRevision?: number) {
      provider.replaceCalls.push({ ns, section, revision: expectedRevision })
      if (provider.conflictOnce) {
        provider.conflictOnce = false
        provider.revision += 1
        const conflict = new Error('conflict')
        conflict.name = 'SettingsConflictError'
        ;(conflict as { code?: string }).code = 'SETTINGS_CONFLICT'
        throw conflict
      }
      provider.currentUser = structuredClone(section)
      provider.revision += 1
    },
  }
  return provider
}

function makeApprovalCtx(
  events: unknown[],
  settings: Record<string, unknown> | undefined,
): {
  ctx: Record<string, unknown>
  agent: { id: string; session: { id: string; events: unknown[] } }
  request(req: FakeApprovalRequest): Promise<string>
} {
  const handlers = new Set<(req: FakeApprovalRequest, next: () => unknown) => unknown>()
  const agent = {
    id: 'a-appr',
    session: { id: 's-appr', header: {}, events, snapshotEvents() { return this.events } },
    options: {},
    status: 'idle',
  }
  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      if (key === 'settings') return settings
      return undefined
    },
    on(event: string, handler: (req: FakeApprovalRequest, next: () => unknown) => unknown) {
      if (event === 'approval/request') {
        handlers.add(handler)
        return () => { handlers.delete(handler) }
      }
      return () => {}
    },
    agents: {
      create: async () => ({ agent, dispose: async () => {} }),
    },
  }
  return {
    ctx,
    agent,
    request(req) {
      let result: unknown
      for (const handler of handlers) result = handler(req, () => undefined)
      return Promise.resolve(result as Promise<string>)
    },
  }
}

describe('always-allow write path', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-approval-preview-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('always resolves allowed-once and merges the first-word rule into permissions.allow', async () => {
    const settings = makeSettingsProvider({
      allow: ['Read'],
      deny: ['Bash(rm)'],
      ask: ['Write'],
      defaultMode: 'plan',
      protectedFiles: ['.env'],
    })
    const { ctx, agent, request } = makeApprovalCtx(
      [callEvent('c1', { command: 'npm install foo' })],
      settings,
    )
    const driver = await createDriver(ctx as never, {})

    const pending = request({
      agent,
      toolName: 'Bash',
      callId: 'c1',
      signal: new AbortController().signal,
    })
    driver.answerApproval('always')

    await expect(pending).resolves.toBe('allowed-once')
    // The rule write settles asynchronously; flush before asserting it.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settings.replaceCalls).toHaveLength(1)
    // The write re-attaches every passthrough field around the merged allow
    // list — replace() overwrites the whole user section.
    expect(settings.replaceCalls[0]!.section).toEqual({
      allow: ['Read', 'Bash(npm )'],
      deny: ['Bash(rm)'],
      ask: ['Write'],
      defaultMode: 'plan',
      protectedFiles: ['.env'],
    })
    expect(settings.replaceCalls[0]!.revision).toBe(0)
    // The rule text is echoed back to the user.
    expect(driver.state.notice).toContain('Bash(npm )')
  })

  it('does not duplicate a rule that is already present', async () => {
    const settings = makeSettingsProvider({ allow: ['Bash(npm )'] })
    const { ctx, agent, request } = makeApprovalCtx(
      [callEvent('c1', { command: 'npm install foo' })],
      settings,
    )
    const driver = await createDriver(ctx as never, {})
    const pending = request({ agent, toolName: 'Bash', callId: 'c1' })
    driver.answerApproval('always')
    await pending
    expect(settings.replaceCalls[0]!.section).toEqual({ allow: ['Bash(npm )'] })
  })

  it('retries once on a settings revision conflict and succeeds with the fresh snapshot', async () => {
    const settings = makeSettingsProvider({ allow: ['Read'], deny: ['Bash(rm)'] })
    settings.conflictOnce = true
    const { ctx, agent, request } = makeApprovalCtx(
      [callEvent('c1', { command: 'npm install foo' })],
      settings,
    )
    const driver = await createDriver(ctx as never, {})
    const pending = request({ agent, toolName: 'Bash', callId: 'c1' })
    driver.answerApproval('always')
    await pending
    // The write path settles asynchronously (conflict retry re-describes and
    // re-replaces); flush the microtask queue before asserting the outcome.
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(settings.replaceCalls).toHaveLength(2)
    // Second attempt merges against the moved revision and carries it forward.
    expect(settings.replaceCalls[1]!.revision).toBe(1)
    expect(settings.replaceCalls[1]!.section).toEqual({ allow: ['Read', 'Bash(npm )'], deny: ['Bash(rm)'] })
    expect(driver.state.notice).toContain('Bash(npm )')
  })

  it('still allows once (with an explanatory notice) when no settings provider is mounted', async () => {
    const { ctx, agent, request } = makeApprovalCtx(
      [callEvent('c1', { command: 'npm install foo' })],
      undefined,
    )
    const driver = await createDriver(ctx as never, {})
    const pending = request({ agent, toolName: 'Bash', callId: 'c1' })
    driver.answerApproval('always')
    await expect(pending).resolves.toBe('allowed-once')
    expect(driver.state.notice).toContain('once')
  })

  it('notifies without writing when the permissions namespace is not registered', async () => {
    const settings = makeSettingsProvider()
    settings.describe = () => []
    const { ctx, agent, request } = makeApprovalCtx(
      [callEvent('c1', { command: 'npm install foo' })],
      settings,
    )
    const driver = await createDriver(ctx as never, {})
    const pending = request({ agent, toolName: 'Bash', callId: 'c1' })
    driver.answerApproval('always')
    await pending
    expect(settings.replaceCalls).toHaveLength(0)
    expect(driver.state.notice).toContain('once')
  })

  it('does not touch settings on a once answer', async () => {
    const settings = makeSettingsProvider()
    const { ctx, agent, request } = makeApprovalCtx(
      [callEvent('c1', { command: 'npm install foo' })],
      settings,
    )
    const driver = await createDriver(ctx as never, {})
    const pending = request({ agent, toolName: 'Bash', callId: 'c1' })
    driver.answerApproval('once')
    await expect(pending).resolves.toBe('allowed-once')
    expect(settings.replaceCalls).toHaveLength(0)
  })

  it('does not touch settings on a reject answer', async () => {
    const settings = makeSettingsProvider()
    const { ctx, agent, request } = makeApprovalCtx(
      [callEvent('c1', { command: 'npm install foo' })],
      settings,
    )
    const driver = await createDriver(ctx as never, {})
    const pending = request({ agent, toolName: 'Bash', callId: 'c1' })
    driver.answerApproval('reject')
    await expect(pending).resolves.toBe('rejected')
    expect(settings.replaceCalls).toHaveLength(0)
  })
})
