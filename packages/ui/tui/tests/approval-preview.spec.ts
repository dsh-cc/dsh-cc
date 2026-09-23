import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allowRuleOf, createDriver, payloadOf } from '@dsh-cc/tui/harness/driver.ts'
import { PERMISSION_SETTINGS_NAMESPACE, canonicalizeHostname, contentMatches, parseRuleString, ruleString } from '@dsh-cc/permission-rules'

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
  it('never derives a persisted rule for EnterWorktree (the outside-path ask always fires)', () => {
    expect(allowRuleOf('EnterWorktree', { kind: 'args', json: '{"path":"/tmp/x"}' })).toEqual({ kind: 'never-persist' })
    expect(allowRuleOf('EnterWorktree', undefined)).toEqual({ kind: 'never-persist' })
  })

  it('writes a trailing-space first-word prefix rule for shell commands', () => {
    expect(allowRuleOf('Bash', { kind: 'command', command: 'npm install foo' })).toEqual({ kind: 'rule', rule: 'Bash(npm )' })
  })

  it('round-trips the Bash rule through the real parser and matches the approved command', () => {
    const derived = allowRuleOf('Bash', { kind: 'command', command: 'npm install foo' })
    expect(derived).toEqual({ kind: 'rule', rule: 'Bash(npm )' })
    const parsed = parseRuleString(derived.kind === 'rule' ? derived.rule : '')
    expect(parsed.matcher).toEqual({ kind: 'prefix', prefix: 'npm ' })
    expect(contentMatches(parsed.matcher!, 'npm install foo')).toBe(true)
    // The trailing space keeps sibling prefixes out: `npmx …` never matches.
    expect(contentMatches(parsed.matcher!, 'npmx install foo')).toBe(false)
  })

  it('escapes and round-trips a first word that opens a subshell', () => {
    const command = '(cd /tmp && ls)'
    const derived = allowRuleOf('Bash', { kind: 'command', command })
    const parsed = parseRuleString(derived.kind === 'rule' ? derived.rule : '')
    expect(parsed.matcher).toEqual({ kind: 'prefix', prefix: '(cd ' })
    expect(contentMatches(parsed.matcher!, command)).toBe(true)
  })

  it('writes a domain rule on the exact WebFetch host', () => {
    expect(allowRuleOf('WebFetch', { kind: 'args', json: '{"url":"https://docs.example.com/a"}' }))
      .toEqual({ kind: 'rule', rule: 'WebFetch(domain:docs.example.com)' })
    // Harness spelling gets the same treatment; lowercased, port dropped.
    expect(allowRuleOf('web_fetch', { kind: 'args', json: '{"url":"https://Example.COM.:8443/x"}' }))
      .toEqual({ kind: 'rule', rule: 'WebFetch(domain:example.com)' })
  })

  it('derives the WebFetch host from the untruncated restored args', () => {
    // A truncated display preview still yields the host when the restored
    // args carry the URL.
    const truncated = { kind: 'args' as const, json: '{"url":"https://docs.example.com/x","blob":"' + 'y'.repeat(600) }
    expect(allowRuleOf('WebFetch', truncated, { url: 'https://docs.example.com/deep', blob: 'x'.repeat(5000) }))
      .toEqual({ kind: 'rule', rule: 'WebFetch(domain:docs.example.com)' })
  })

  it('is underivable — never whole-tool — when the WebFetch URL is missing or unparseable', () => {
    expect(allowRuleOf('WebFetch', { kind: 'args', json: 'not-json{' })).toEqual({ kind: 'underivable' })
    expect(allowRuleOf('WebFetch', { kind: 'args', json: '{"url":"not a url"}' })).toEqual({ kind: 'underivable' })
    expect(allowRuleOf('WebFetch', { kind: 'args', json: '{}' })).toEqual({ kind: 'underivable' })
    expect(allowRuleOf('WebFetch', undefined)).toEqual({ kind: 'underivable' })
  })

  it('writes a whole-tool rule for non-shell tools', () => {
    expect(allowRuleOf('Write', { kind: 'diff', diffs: [] })).toEqual({ kind: 'rule', rule: 'Write' })
    expect(allowRuleOf('Read', undefined)).toEqual({ kind: 'rule', rule: 'Read' })
    expect(allowRuleOf('Read', { kind: 'none' })).toEqual({ kind: 'rule', rule: 'Read' })
    const parsed = parseRuleString(allowRuleOf('Write', { kind: 'diff', diffs: [] })!.kind === 'rule'
      ? (allowRuleOf('Write', { kind: 'diff', diffs: [] }) as { kind: 'rule'; rule: string }).rule
      : '')
    expect(parsed.toolName).toBe('Write')
    expect(parsed.content).toBeUndefined()
  })

  it('is underivable for a blank command or tool name (once-only fallback)', () => {
    expect(allowRuleOf('Bash', { kind: 'command', command: '   ' })).toEqual({ kind: 'underivable' })
    expect(allowRuleOf('  ', undefined)).toEqual({ kind: 'underivable' })
  })

  it('keeps ruleString escaping symmetric for a plain prefix', () => {
    expect(ruleString('Bash', 'npm ')).toBe('Bash(npm )')
  })

  it('falls back to a raw-prefix rule when the stripped first word cannot match the raw command', () => {
    // FOO=bar npm install → the raw prefix covers the producing call.
    expect(allowRuleOf('Bash', { kind: 'command', command: 'FOO=bar npm install' }))
      .toEqual({ kind: 'rule', rule: 'Bash(FOO=bar npm )' })
    expect(allowRuleOf('Bash', { kind: 'command', command: 'FOO=bar BAZ=qux npm install' }))
      .toEqual({ kind: 'rule', rule: 'Bash(FOO=bar BAZ=qux npm )' })
    expect(allowRuleOf('Bash', { kind: 'command', command: 'sudo npm install' }))
      .toEqual({ kind: 'rule', rule: 'Bash(sudo npm )' })
    expect(allowRuleOf('Bash', { kind: 'command', command: 'npx npm install' }))
      .toEqual({ kind: 'rule', rule: 'Bash(npx npm )' })
    // The plan example: raw prefix through the end of the stripped first word.
    expect(allowRuleOf('Bash', { kind: 'command', command: 'sudo FOO=bar npm x' }))
      .toEqual({ kind: 'rule', rule: 'Bash(sudo FOO=bar npm )' })
  })

  it('handles compound commands by deriving from the first segment (raw prefix when prefixed)', () => {
    expect(allowRuleOf('Bash', { kind: 'command', command: 'git add . && git commit' }))
      .toEqual({ kind: 'rule', rule: 'Bash(git )' })
    expect(allowRuleOf('Bash', { kind: 'command', command: 'FOO=bar git add . && git commit' }))
      .toEqual({ kind: 'rule', rule: 'Bash(FOO=bar git )' })
  })

  it('every derived rule matches its producing call (invariant corpus)', () => {
    const subjectOf = (toolName: string, args: Record<string, unknown>): string | undefined => {
      if (typeof args.command === 'string') return args.command
      if (typeof args.url === 'string') return canonicalizeHostname(args.url)
      if (typeof args.file_path === 'string') return args.file_path
      return undefined
    }
    const corpus: [string, Record<string, unknown>][] = [
      ['Bash', { command: 'npm install foo' }],
      ['Bash', { command: 'FOO=bar npm install' }],
      ['Bash', { command: 'FOO=bar BAZ=qux npm run build' }],
      ['Bash', { command: 'sudo npm install' }],
      ['Bash', { command: 'npx npm install' }],
      ['Bash', { command: 'yarn build' }],
      ['Bash', { command: 'sudo FOO=bar npm x' }],
      ['Bash', { command: 'git add . && git commit -m x' }],
      ['Bash', { command: 'FOO=bar git add . && git commit' }],
      ['Bash', { command: 'ls -la' }],
      ['Bash', { command: '(cd /tmp && ls)' }],
      ['WebFetch', { url: 'https://docs.example.com/a' }],
      ['WebFetch', { url: 'https://Example.COM.:8443/x' }],
      ['Write', { file_path: '/tmp/new.ts', content: 'export {}\n' }],
      ['Edit', { file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' }],
      ['Read', { file_path: '/tmp/a.ts' }],
    ]
    for (const [toolName, args] of corpus) {
      const preview = payloadOf(previewReq(toolName, 'c', [callEvent('c', args)]))
      const derived = allowRuleOf(toolName, preview, args)
      expect(derived.kind, `${toolName} ${JSON.stringify(args)}`).toBe('rule')
      if (derived.kind !== 'rule') continue
      const parsed = parseRuleString(derived.rule)
      expect(parsed.toolName, derived.rule).toBe(toolName)
      if (parsed.content === undefined) continue
      // Whole-tool rules match trivially; content rules must match the
      // producing call's subject (subjectOf semantics).
      const subject = subjectOf(toolName, args)
      expect(contentMatches(parsed.matcher!, subject!), `${derived.rule} vs ${subject}`).toBe(true)
    }
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

interface EditCall {
  ns: unknown
}

/**
 * Fake settings provider standing in for the cascade's `editUserSection` seam:
 * the edit callback runs against the raw user section (as the real seam does),
 * `undefined` results are no-ops. `editUserSection` failure can be armed.
 */
function makeSettingsProvider(user: Record<string, unknown> = {}): {
  writable: boolean
  editCalls: EditCall[]
  currentUser: Record<string, unknown>
  failOnce: boolean
  editUserSection(
    ns: unknown,
    edit: (rawSection: Record<string, unknown>) => Record<string, unknown> | undefined,
  ): Promise<void>
} {
  const provider = {
    writable: true,
    editCalls: [] as EditCall[],
    currentUser: structuredClone(user),
    failOnce: false,
    async editUserSection(
      ns: unknown,
      edit: (rawSection: Record<string, unknown>) => Record<string, unknown> | undefined,
    ) {
      provider.editCalls.push({ ns })
      if (provider.failOnce) {
        provider.failOnce = false
        throw new Error('disk on fire')
      }
      const next = edit(structuredClone(provider.currentUser))
      if (next === undefined) return
      provider.currentUser = next
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

  it('always resolves allowed-once and merges the first-word rule into the raw user allow list', async () => {
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
    // The write edits the RAW user section through the editUserSection seam;
    // passthrough fields survive untouched.
    expect(settings.currentUser).toEqual({
      allow: ['Read', 'Bash(npm )'],
      deny: ['Bash(rm)'],
      ask: ['Write'],
      defaultMode: 'plan',
      protectedFiles: ['.env'],
    })
    // The rule text is echoed back to the user.
    expect(driver.state.notice).toContain('Bash(npm )')
  })

  it('skips the write and notifies when an existing rule already covers the new one', async () => {
    const settings = makeSettingsProvider({ allow: ['Bash(npm )'] })
    const { ctx, agent, request } = makeApprovalCtx(
      [callEvent('c1', { command: 'npm install foo' })],
      settings,
    )
    const driver = await createDriver(ctx as never, {})
    const pending = request({ agent, toolName: 'Bash', callId: 'c1' })
    driver.answerApproval('always')
    await pending
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settings.currentUser).toEqual({ allow: ['Bash(npm )'] })
    expect(driver.state.notice).toContain('Already covered by Bash(npm )')
  })

  it('drops narrower allow rules the new rule subsumes and reports the replacement', async () => {
    const settings = makeSettingsProvider({ allow: ['Bash(npm install foo )', 'Bash(npm install )', 'Read'] })
    const { ctx, agent, request } = makeApprovalCtx(
      [callEvent('c1', { command: 'npm install foo' })],
      settings,
    )
    const driver = await createDriver(ctx as never, {})
    const pending = request({ agent, toolName: 'Bash', callId: 'c1' })
    driver.answerApproval('always')
    await pending
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settings.currentUser).toEqual({ allow: ['Read', 'Bash(npm )'] })
    expect(driver.state.notice).toContain('Always allow: Bash(npm )')
    expect(driver.state.notice).toContain('replaced 2 narrower rules')
  })

  it('notifies once-only when the rule is underivable', async () => {
    const settings = makeSettingsProvider()
    const { ctx, agent, request } = makeApprovalCtx(
      [callEvent('c1', { command: '   ' })],
      settings,
    )
    const driver = await createDriver(ctx as never, {})
    const pending = request({ agent, toolName: 'Bash', callId: 'c1' })
    driver.answerApproval('always')
    await pending
    expect(settings.editCalls).toHaveLength(0)
    expect(driver.state.notice).toContain('Could not derive a safe persistent rule')
  })

  it('stays silent for a never-persist tool (EnterWorktree)', async () => {
    const settings = makeSettingsProvider()
    const { ctx, agent, request } = makeApprovalCtx(
      [callEvent('c1', { path: '/tmp/wt' })],
      settings,
    )
    const driver = await createDriver(ctx as never, {})
    const pending = request({ agent, toolName: 'EnterWorktree', callId: 'c1' })
    driver.answerApproval('always')
    await pending
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settings.editCalls).toHaveLength(0)
    expect(driver.state.notice).toBeUndefined()
  })

  it('surfaces a seam write failure as an allowed-once notice', async () => {
    const settings = makeSettingsProvider({ allow: [] })
    settings.failOnce = true
    const { ctx, agent, request } = makeApprovalCtx(
      [callEvent('c1', { command: 'npm install foo' })],
      settings,
    )
    const driver = await createDriver(ctx as never, {})
    const pending = request({ agent, toolName: 'Bash', callId: 'c1' })
    driver.answerApproval('always')
    await pending
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(driver.state.notice).toContain('Allowed once only')
    expect(driver.state.notice).toContain('disk on fire')
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

  it('notifies without writing when the settings provider lacks the editUserSection seam', async () => {
    const settings = makeSettingsProvider()
    const seamless = { writable: true, describe: () => [] }
    const { ctx, agent, request } = makeApprovalCtx(
      [callEvent('c1', { command: 'npm install foo' })],
      seamless,
    )
    void settings
    const driver = await createDriver(ctx as never, {})
    const pending = request({ agent, toolName: 'Bash', callId: 'c1' })
    driver.answerApproval('always')
    await pending
    expect(settings.editCalls).toHaveLength(0)
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
    expect(settings.editCalls).toHaveLength(0)
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
    expect(settings.editCalls).toHaveLength(0)
  })
})
