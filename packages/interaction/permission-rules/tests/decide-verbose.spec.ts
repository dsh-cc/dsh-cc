import { describe, expect, it } from 'vitest'
import { parseRule } from '../src/parser.ts'
import { decideCall, decideCallVerbose } from '../src/decide.ts'
import type { DecideDeps } from '../src/decide.ts'
import { EMPTY_RULE_SET, type PermissionRuleSet } from '../src/types.ts'
import type { ToolExecution } from '@dsh-cc/tools'

function fakeExec(name: string, args: unknown, opts: { cwd?: string } = {}): ToolExecution {
  const agent = opts.cwd === undefined ? undefined : ({
    id: 'a1',
    session: { events: [], header: { cwd: opts.cwd } },
  } as unknown as ToolExecution['agent'])
  return {
    signal: new AbortController().signal,
    callId: 'c1',
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
  } as unknown as ToolExecution
}

function rules(overrides: Partial<PermissionRuleSet> = {}): PermissionRuleSet {
  return { allow: [], deny: [], ask: [], bypassImmune: [], ...overrides }
}

function deps(overrides: Partial<DecideDeps> = {}): DecideDeps {
  return {
    classifierEnabled: true,
    exemptSandboxedBashFromToolAsk: false,
    bashToolName: 'Bash',
    fileEditTools: new Set(['edit']),
    readOnlyTools: new Set(['read']),
    settings: () => ({}),
    defaultMode: () => 'default',
    rules: () => EMPTY_RULE_SET,
    bypassDisabled: () => false,
    sessionAllowMatches: () => false,
    shellMode: () => undefined,
    ...overrides,
  }
}

describe('decideCallVerbose (verbose core split)', () => {
  it('LOW + auto + rule ask: verbose returns the raw ask, decideCall still proxies to allow', () => {
    const d = deps({
      defaultMode: () => 'auto',
      rules: () => rules({ ask: [parseRule('Bash', 'ask', 'config')] }),
    })
    const exec = fakeExec('Bash', { command: 'ls' })
    const verbose = decideCallVerbose(d, exec)
    expect(verbose.decision).toMatchObject({ kind: 'ask' })
    expect(verbose.risk.level).toBe('LOW')
    expect(verbose.mode).toBe('auto')
    expect(decideCall(d, exec)).toEqual({ kind: 'allow' })
  })

  it('LOW + auto + no rules (waterfall passthrough): both return passthrough unchanged', () => {
    const d = deps({ defaultMode: () => 'auto' })
    const exec = fakeExec('Bash', { command: 'ls' })
    const verbose = decideCallVerbose(d, exec)
    expect(verbose.decision.kind).toBe('passthrough')
    expect(decideCall(d, exec)).toEqual(verbose.decision)
  })

  it('LOW + default mode + rule ask: both return the same ask', () => {
    const d = deps({
      rules: () => rules({ ask: [parseRule('Bash', 'ask', 'config')] }),
    })
    const exec = fakeExec('Bash', { command: 'ls' })
    expect(decideCallVerbose(d, exec).decision).toMatchObject({ kind: 'ask' })
    expect(decideCall(d, exec)).toMatchObject({ kind: 'ask' })
  })

  it('HIGH bash command: both deny with the identical reason; risk exposed', () => {
    const d = deps()
    const exec = fakeExec('Bash', { command: 'rm -rf /' })
    const verbose = decideCallVerbose(d, exec)
    expect(verbose.risk.level).toBe('HIGH')
    expect(verbose.decision).toEqual(decideCall(d, exec))
    expect(decideCall(d, exec).kind).toBe('deny')
  })

  it('MEDIUM + auto: ask survives in BOTH functions (never proxied to allow)', () => {
    const d = deps({ defaultMode: () => 'auto' })
    const exec = fakeExec('edit', { file_path: '/outside-cwd/x.ts' }, { cwd: '/work' })
    const verbose = decideCallVerbose(d, exec)
    expect(verbose.risk.level).toBe('MEDIUM')
    expect(verbose.decision.kind).toBe('ask')
    expect(verbose.mode).toBe('auto')
    expect(decideCall(d, exec)).toEqual(verbose.decision)
  })

  it('MEDIUM + bypassPermissions: both allow', () => {
    const d = deps({ defaultMode: () => 'bypassPermissions' })
    const exec = fakeExec('edit', { file_path: '/outside-cwd/x.ts' }, { cwd: '/work' })
    expect(decideCallVerbose(d, exec).decision).toEqual({ kind: 'allow' })
    expect(decideCall(d, exec)).toEqual({ kind: 'allow' })
  })

  it('MEDIUM + session grant: both allow (grant overrides the MEDIUM ask)', () => {
    const d = deps({ sessionAllowMatches: () => true })
    const exec = fakeExec('edit', { file_path: '/outside-cwd/x.ts' }, { cwd: '/work' })
    expect(decideCallVerbose(d, exec).decision).toEqual({ kind: 'allow' })
    expect(decideCall(d, exec)).toEqual({ kind: 'allow' })
  })

  it('whole-tool deny rule: both deny with the same reason in every mode', () => {
    for (const mode of ['default', 'auto', 'bypassPermissions'] as const) {
      const d = deps({
        defaultMode: () => mode,
        rules: () => rules({ deny: [parseRule('Bash', 'deny', 'policySettings')] }),
      })
      const exec = fakeExec('Bash', { command: 'ls' })
      const verbose = decideCallVerbose(d, exec)
      expect(verbose.decision.kind).toBe('deny')
      expect(decideCall(d, exec)).toEqual(verbose.decision)
    }
  })

  it('whole-tool allow rule: both allow in default mode', () => {
    const d = deps({ rules: () => rules({ allow: [parseRule('Bash', 'allow', 'config')] }) })
    const exec = fakeExec('Bash', { command: 'anything' })
    expect(decideCallVerbose(d, exec).decision).toEqual({ kind: 'allow' })
    expect(decideCall(d, exec)).toEqual({ kind: 'allow' })
  })

  it('exposes the effective mode and risk for every call (audit seam)', () => {
    const d = deps({ defaultMode: () => 'auto', classifierEnabled: false })
    const verbose = decideCallVerbose(d, fakeExec('Bash', { command: 'ls' }))
    expect(verbose.mode).toBe('auto')
    expect(verbose.risk.level).toBe('LOW')
    expect(verbose.risk.reasons).toEqual([])
  })

  it('F2: isReadOnly is populated — read-only tools true, mutating tools false', () => {
    const d = deps()
    expect(decideCallVerbose(d, fakeExec('read', { file_path: 'a.ts' })).isReadOnly).toBe(true)
    expect(decideCallVerbose(d, fakeExec('Bash', { command: 'ls' })).isReadOnly).toBe(false)
    expect(decideCallVerbose(d, fakeExec('edit', { file_path: 'a.ts' })).isReadOnly).toBe(false)
  })

  it('F2: isReadOnly rides HIGH and MEDIUM early returns too', () => {
    const d = deps()
    const high = decideCallVerbose(d, fakeExec('Bash', { command: 'rm -rf /' }))
    expect(high.isReadOnly).toBe(false)
    const medium = decideCallVerbose(d, fakeExec('edit', { file_path: '/outside/x.ts' }, { cwd: '/work' }))
    expect(medium.isReadOnly).toBe(false)
    const mediumRead = decideCallVerbose(deps({ readOnlyTools: new Set(['read']) }), fakeExec('read', { file_path: 'a.ts' }))
    expect(mediumRead.isReadOnly).toBe(true)
  })
})
