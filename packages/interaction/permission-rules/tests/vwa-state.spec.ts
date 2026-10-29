import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolExecution } from '@dsh-cc/tools'
import { decideCallVerbose } from '../src/decide.ts'
import type { DecideDeps } from '../src/decide.ts'
import { parseRule } from '../src/parser.ts'
import { EMPTY_RULE_SET, type PermissionRuleSet } from '../src/types.ts'
import { isVwaStateWrite } from '../src/vwa-state.ts'

function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vwa-state-')))
  mkdirSync(join(root, '.dsh/vwa/prj_1'), { recursive: true })
  mkdirSync(join(root, '.dsh/vwa/batches/b1'), { recursive: true })
  writeFileSync(join(root, '.dsh/vwa/current-project.json'), '{}')
  writeFileSync(join(root, '.dsh/vwa/prj_1/adjudications.json'), '{}')
  return root
}

function fakeExec(name: string, args: unknown, cwd: string): ToolExecution {
  return {
    signal: new AbortController().signal,
    callId: 'c1',
    name,
    arguments: args,
    agent: { id: 'a1', session: { seq: 0, snapshotEvents: () => [], header: { cwd } } },
  } as unknown as ToolExecution
}

function deps(overrides: Partial<DecideDeps> = {}): DecideDeps {
  return {
    classifierEnabled: true,
    exemptSandboxedBashFromToolAsk: false,
    bashToolName: 'Bash',
    fileEditTools: new Set(['edit', 'write', 'notebook_edit']),
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

describe('§3.7 authoritative VWA state default-ask', () => {
  it('flags state files (current-project.json included) and exempts only .dsh/vwa/batches/**', () => {
    const root = workspace()
    expect(isVwaStateWrite(join(root, '.dsh/vwa/prj_1/adjudications.json'), root)).toBe(true)
    expect(isVwaStateWrite(join(root, '.dsh/vwa/current-project.json'), root)).toBe(true)
    expect(isVwaStateWrite(join(root, '.dsh/vwa/batches/b1/state.json'), root)).toBe(false)
    expect(isVwaStateWrite(join(root, 'docs/a.md'), root)).toBe(false)
    expect(isVwaStateWrite(join(root, '.dsh/vwa-other/x.json'), root)).toBe(false)
  })

  it('accepts a root-relative target too', () => {
    const root = workspace()
    expect(isVwaStateWrite('.dsh/vwa/prj_1/signatures.json', root)).toBe(true)
    expect(isVwaStateWrite('.dsh/vwa/batches/b1/x.json', root)).toBe(false)
  })

  it('B1: a write through a symlinked parent into VWA state still asks', () => {
    const root = workspace()
    mkdirSync(join(root, 'docs'), { recursive: true })
    symlinkSync(join(root, '.dsh/vwa'), join(root, 'docs/link'))
    const target = join(root, 'docs/link/adjudications.json')
    expect(isVwaStateWrite(target, root)).toBe(true)
    expect(decideCallVerbose(deps(), fakeExec('write', { file_path: target }, root)).decision.kind).toBe('ask')
  })

  it('an Edit/Write of VWA state asks (not denies), batches excluded', () => {
    const root = workspace()
    const readEdit = decideCallVerbose(deps(), fakeExec('write', { file_path: join(root, '.dsh/vwa/prj_1/signatures.json') }, root))
    expect(readEdit.decision.kind).toBe('ask')
    const batches = decideCallVerbose(deps(), fakeExec('write', { file_path: join(root, '.dsh/vwa/batches/b1/x.json') }, root))
    expect(batches.decision.kind).not.toBe('ask')
    expect(isVwaStateWrite(join(root, '.dsh/vwa/batches/b1/x.json'), root)).toBe(false)
  })

  it('P2c: the guard scopes to the session-cwd fold, not the stale header cwd', () => {
    const root = workspace()
    const stale = realpathSync(mkdtempSync(join(tmpdir(), 'vwa-stale-')))
    const exec = fakeExec('write', { file_path: join(root, '.dsh/vwa/prj_1/x.json') }, stale)
    // Header cwd is `stale`; the current-cwd fold says `root`, so the ask fires.
    expect(decideCallVerbose(deps({ workspaceOf: () => root }), exec).decision.kind).toBe('ask')
    expect(decideCallVerbose(deps({ workspaceOf: () => stale }), exec).decision.kind).not.toBe('ask')
  })

  it('a deny rule still wins, and bypassPermissions keeps its no-prompt contract', () => {
    const root = workspace()
    const target = { file_path: join(root, '.dsh/vwa/prj_1/adjudications.json') }
    const denied = decideCallVerbose(
      deps({ rules: (): PermissionRuleSet => ({ ...EMPTY_RULE_SET, deny: [parseRule('write', 'deny', 'userSettings')] }) }),
      fakeExec('write', target, root),
    )
    expect(denied.decision.kind).toBe('deny')
    const bypass = decideCallVerbose(deps({ defaultMode: () => 'bypassPermissions' }), fakeExec('write', target, root))
    expect(bypass.decision.kind).toBe('allow')
  })

  it('read-only tools and non-path calls are untouched', () => {
    const root = workspace()
    expect(decideCallVerbose(deps(), fakeExec('read', { file_path: join(root, '.dsh/vwa/prj_1/adjudications.json') }, root)).decision.kind)
      .not.toBe('ask')
    expect(decideCallVerbose(deps(), fakeExec('Bash', { command: 'ls' }, root)).decision.kind).toBe('passthrough')
  })
})
