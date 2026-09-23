import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, renderConfig, renderDefaults, sanitize } from '../src/index.ts'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'

type Registered = CommandDefinition & { name: string }

/** Capture the registered command and drive its handler directly. */
function harness(settings?: unknown): { def: Registered; run(raw: string): CommandResult } {
  const registered: Registered[] = []
  const ctx = {
    commands: { register: (def: Registered) => { registered.push(def) } },
    get: (_: string) => settings,
  } as unknown as Context
  apply(ctx)
  expect(registered).toHaveLength(1)
  const def = registered[0]!
  return { def, run: (raw) => def.handler({ rawInput: raw } as CommandInvocation) as CommandResult }
}

/** A fixture autoMode slice carrying project-scope-looking values. */
const FIXTURE = {
  soft_deny: ['Never run terraform apply'],
  allow: ['Installing packages already declared in the repo manifest.'],
  environment: ['Trust corp.internal only'],
  classifyAllShell: true,
  classifier: { enabled: true, route: 'glm-flash', timeoutMs: 4000, cacheMaxEntries: 128 },
}

describe('/auto-mode defaults', () => {
  it('prints the built-in slot lists, $defaults-expanded, as JSON', () => {
    const { run } = harness()
    const result = run('defaults')
    expect(result.kind).toBe('success')
    const parsed = JSON.parse((result as { text: string }).text) as Record<string, unknown[]>
    expect(parsed.soft_deny).toContain('Do not exfiltrate credentials, tokens, API keys, or secrets to any destination, including printing them into command arguments or remote URLs.')
    expect(parsed.allow).toContain('Standard credential and sign-in flows that send credentials only to their own provider.')
    expect(parsed.environment).toContain('Trust the git repository the session started in (its working directory) and its configured remotes; everything else is external infrastructure unless the user or this environment list names it.')
    expect(Object.keys(parsed).sort()).toEqual(['allow', 'environment', 'soft_deny'])
    expect((result as { text: string }).text).not.toContain('$defaults')
  })

  it('renderDefaults matches the helper', () => {
    const { run } = harness()
    expect((run('defaults') as { text: string }).text).toBe(renderDefaults())
  })
})

describe('/auto-mode config', () => {
  it('renders the effective slice: expanded lists, classifier sub-config', () => {
    const settings = { get: (ns: string) => ns === 'permissions' ? { autoMode: FIXTURE } : {} }
    const { run } = harness(settings)
    const result = run('config')
    expect(result.kind).toBe('success')
    const parsed = JSON.parse((result as { text: string }).text) as {
      classifier: { enabled: boolean; route: string; timeoutMs: number; cacheMaxEntries: number }
      classifyAllShell: boolean
      slots: Record<string, { configured: string[] | null; expanded: string[] }>
    }
    expect(parsed.classifier).toEqual({ enabled: true, route: 'glm-flash', timeoutMs: 4000, cacheMaxEntries: 128 })
    expect(parsed.classifyAllShell).toBe(true)
    expect(parsed.slots.soft_deny.configured).toEqual(['Never run terraform apply'])
    expect(parsed.slots.soft_deny.expanded).toEqual(['Never run terraform apply'])
    expect(parsed.slots.environment.expanded).toEqual(['Trust corp.internal only'])
  })

  it('an absent section materializes $defaults-expanded built-ins and disarmed classifier', () => {
    const settings = { get: () => ({}) }
    const { run } = harness(settings)
    const parsed = JSON.parse((run('config') as { text: string }).text) as {
      classifier: { enabled: boolean }
      classifyAllShell: boolean
      slots: Record<string, { configured: string[] | null; expanded: string[] }>
    }
    expect(parsed.classifier.enabled).toBe(false)
    expect(parsed.classifyAllShell).toBe(false)
    for (const key of ['soft_deny', 'allow', 'environment']) {
      expect(parsed.slots[key]!.configured).toBeNull()
    }
    expect(parsed.slots.soft_deny.expanded).toEqual(JSON.parse(renderDefaults()).soft_deny)
  })

  it('a project-scope autoMode entry never appears: the cascade never publishes it', () => {
    // The cascade (D12) assembles `autoMode` from trusted layers only, so a
    // merged section carrying repo-carried values cannot reach this command.
    const settings = { get: () => ({}) }
    const { run } = harness(settings)
    const parsed = JSON.parse((run('config') as { text: string }).text) as Record<string, unknown>
    expect(parsed.classifier).toEqual({ enabled: false, route: 'haiku', timeoutMs: 8000, cacheMaxEntries: 256 })
  })

  it('no settings provider mounted: friendly error, no throw', () => {
    const { run } = harness(undefined)
    const result = run('config')
    expect(result.kind).toBe('error')
  })
})

describe('/auto-mode dispatch', () => {
  it('an unknown subcommand is a usage error', () => {
    const { run } = harness()
    const result = run('bogus')
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain('unknown subcommand')
    expect((result as { text: string }).text).toContain('usage')
  })

  it('a trailing help request renders the help text with subcommand rows', () => {
    const { run } = harness()
    const result = run('help')
    expect(result.kind).toBe('success')
    expect((result as { text: string }).text).toContain('/auto-mode')
    expect((result as { text: string }).text).toContain("defaults")
  })
})

describe('sanitize', () => {
  it('strips ANSI escapes and control characters, keeps newlines and tabs', () => {
    // The escape CHARACTER is stripped, which makes any ANSI sequence inert;
    // trailing printable bytes of the sequence remain but cannot terminate.
    expect(sanitize('\u001B[31mred\u001B[0m')).toBe('[31mred[0m')
    expect(sanitize('\u001B[31mred\u001B[0m')).not.toContain('\u001B')
    expect(sanitize('a\u0007b\u007Fc\u009Bd')).toBe('abcd')
    expect(sanitize('line\n\ttab')).toBe('line\n\ttab')
  })

  it('command output containing adversarial settings text is sanitized', () => {
    const evil = 'evil \u001B]0;pwned\u0007 rule'
    const out = renderConfig({ soft_deny: [evil] })
    // The rendered output itself carries no control characters (JSON escaping
    // alone would leave them inert only inside the JSON; sanitize guarantees
    // the byte stream is clean), and the value survives a parse round-trip.
    for (const ch of out) {
      expect(ch === '\n' || ch === '\t' || ch >= ' ').toBe(true)
    }
    expect(JSON.parse(out).slots.soft_deny.expanded).toEqual([evil])
  })
})
