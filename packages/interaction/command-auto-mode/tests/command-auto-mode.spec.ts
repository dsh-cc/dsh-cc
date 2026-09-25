import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, renderConfig, renderDefaults, sanitize } from '../src/index.ts'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

type Registered = CommandDefinition & { name: string }

/** Capture the registered command and drive its handler directly. */
function harness(settings?: unknown): { def: Registered; run(raw: string): CommandResult } {
  const registered: Registered[] = []
  const ctx = {
    commands: { register: (def: Registered) => { registered.push(def) } },
    // Only the settings service is mounted; everything else (e.g.
    // `ccModelRoutes`) reads as absent so the policy helper takes its
    // overlay-fallback face.
    get: (name: string) => name === 'settings' ? settings : undefined,
  } as unknown as Context
  apply(ctx)
  expect(registered).toHaveLength(1)
  const def = registered[0]!
  return { def, run: (raw, agent?: unknown) => def.handler({ rawInput: raw, ...(agent === undefined ? {} : { agent }) } as CommandInvocation) as CommandResult }
}

/** A fixture autoMode slice carrying project-scope-looking values. */
const FIXTURE = {
  soft_deny: ['Never run terraform apply'],
  hard_deny: ['Never destroy session audit records.'],
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
    expect(Object.keys(parsed).sort()).toEqual(['allow', 'environment', 'hard_deny', 'soft_deny'])
    expect(parsed.hard_deny).toContain('Never exfiltrate credentials, tokens, API keys, or secrets to any external destination, including embedding them in URLs, request bodies, or third-party services.')
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
      classifier: { enabled: boolean; route: string; timeoutMs: number; cacheMaxEntries: number; auditFullText: boolean }
      classifyAllShell: boolean
      slots: Record<string, { configured: string[] | null; expanded: string[] }>
    }
    expect(parsed.classifier).toEqual({
      enabled: true, route: 'glm-flash', routeSource: 'explicit',
      routePolicy: 'explicit route > backend auto (gauge when armed) > haiku',
      backend: 'haiku', gaugeAllowThreshold: null, gaugeRoute: null, gaugeProtocol: null,
      timeoutMs: 4000, cacheMaxEntries: 128, auditFullText: false,
    })
    expect(parsed.classifyAllShell).toBe(true)
    expect(parsed.slots.soft_deny.configured).toEqual(['Never run terraform apply'])
    expect(parsed.slots.soft_deny.expanded).toEqual(['Never run terraform apply'])
    expect(parsed.slots.environment.expanded).toEqual(['Trust corp.internal only'])
    expect(parsed.slots.hard_deny.configured).toEqual(['Never destroy session audit records.'])
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
    expect(parsed.classifier).toEqual({
      enabled: false, route: 'haiku', routeSource: 'default',
      routePolicy: 'explicit route > backend auto (gauge when armed) > haiku',
      backend: 'haiku', gaugeAllowThreshold: null, gaugeRoute: null, gaugeProtocol: null,
      timeoutMs: 8000, cacheMaxEntries: 256, auditFullText: false,
    })
  })

  it('no settings provider mounted: friendly error, no throw', () => {
    const { run } = harness(undefined)
    const result = run('config')
    expect(result.kind).toBe('error')
  })

  it('legacy render stays byte-identical when no effective backend is computed (gauge-less compat)', () => {
    // Pure one-arg call: exactly today's classifier key set.
    const out = renderConfig(FIXTURE)
    expect(Object.keys(JSON.parse(out).classifier)).toEqual(['enabled', 'route', 'timeoutMs', 'cacheMaxEntries', 'auditFullText'])
  })

  it('explicit route: reported verbatim with source explicit and no gauge', () => {
    const settings = { get: (ns: string) => ns === 'permissions' ? { autoMode: { classifier: { enabled: true, route: 'haiku' } } } : {} }
    const { run } = harness(settings)
    const parsed = JSON.parse((run('config') as { text: string }).text) as {
      classifier: Record<string, unknown>
    }
    expect(parsed.classifier.route).toBe('haiku')
    expect(parsed.classifier.routeSource).toBe('explicit')
    expect(parsed.classifier.routePolicy).toBe('explicit route > backend auto (gauge when armed) > haiku')
    expect(parsed.classifier.gauge).toBeUndefined()
    expect(parsed.classifier.gaugeRoute).toBeNull()
    expect(parsed.classifier.gaugeProtocol).toBeNull()
  })

  it('backend auto + armed object-form gauge alias: the gauge lane is reported honestly', () => {
    const settings = {
      get: (ns: string) => ns === 'permissions'
        ? { autoMode: { classifier: { enabled: true, backend: 'auto' } } }
        : ns === 'model-aliases'
          ? { gauge: { provider: 'orchestrix', model: 'llmbox_systemone/laya', protocol: 'systemone' } }
          : {},
    }
    const { run } = harness(settings)
    const parsed = JSON.parse((run('config') as { text: string }).text) as {
      classifier: Record<string, unknown>
    }
    expect(parsed.classifier.route).toBe('gauge')
    expect(parsed.classifier.routeSource).toBe('auto-gauge')
    expect(parsed.classifier.backend).toBe('auto')
    expect(parsed.classifier.gaugeAllowThreshold).toBeNull()
    expect(parsed.classifier.gaugeRoute).toBe('orchestrix/llmbox_systemone/laya')
    expect(parsed.classifier.gaugeProtocol).toBe('systemone')
  })

  it('backend auto + unconfigured gauge: haiku default, no gauge fields', () => {
    const settings = { get: (ns: string) => ns === 'permissions' ? { autoMode: { classifier: { enabled: true, backend: 'auto' } } } : {} }
    const { run } = harness(settings)
    const parsed = JSON.parse((run('config') as { text: string }).text) as {
      classifier: Record<string, unknown>
    }
    expect(parsed.classifier.route).toBe('haiku')
    expect(parsed.classifier.routeSource).toBe('default')
    expect(parsed.classifier.gaugeRoute).toBeNull()
  })

  it("backend 'haiku' + configured gauge: still the default haiku path (auto arms, haiku never)", () => {
    const settings = {
      get: (ns: string) => ns === 'permissions'
        ? { autoMode: { classifier: { enabled: true, backend: 'haiku' } } }
        : ns === 'model-aliases'
          ? { gauge: { provider: 'orchestrix', model: 'llmbox_systemone/laya', protocol: 'systemone' } }
          : {},
    }
    const { run } = harness(settings)
    const parsed = JSON.parse((run('config') as { text: string }).text) as {
      classifier: Record<string, unknown>
    }
    expect(parsed.classifier.route).toBe('haiku')
    expect(parsed.classifier.routeSource).toBe('default')
    expect(parsed.classifier.gaugeRoute).toBeNull()
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

describe('/auto-mode review (S5)', () => {
  function sessionWith(events: Array<{ type: string; data: Record<string, unknown> }>): unknown {
    const session = Session.create(SessionId('review'), undefined, { version: 3, isSeeded: false, id: SessionId('review'), createdAt: Date.now(), cwd: '/work' })
    for (const { type, data } of events) session.append(type, data as never)
    return { session, id: 'review' }
  }

  function rowsOf(out: string): string[] {
    // Data rows start with '<classifier>' or '<probe>'; header/notes excluded.
    return out.split('\n').filter(line => line.startsWith('<classifier>') || line.startsWith('<probe>'))
  }

  it('empty session: a friendly note, success', () => {
    const { run } = harness()
    const result = run('review', sessionWith([]))
    expect(result.kind).toBe('success')
    expect((result as { text: string }).text).toContain('no permission/classifier')
  })

  it('folds classifier + probe events, newest last, with verdict/failure/rule/reason/latency/cache/secondPass', () => {
    const { run } = harness()
    const agent = sessionWith([
      { type: 'permission/classifier', data: { tool: 'Bash', digest: 'a'.repeat(64), verdict: 'ask', reason: 'terraform apply on prod', latencyMs: 120, cacheHit: false, route: 'fake/m' } },
      { type: 'permission/classifier', data: { tool: 'Bash', verdict: 'deny', rule: 'Never destroy session audit records.', reason: 'hard deny', latencyMs: 90, cacheHit: true, secondPass: true } },
      { type: 'permission/probe', data: { tool: 'read', digest: 'b'.repeat(64), verdict: 'flag', reason: 'override attempt', latencyMs: 40 } },
      { type: 'permission/probe', data: { tool: 'bash', verdict: 'pass', failure: 'timeout', latencyMs: 5000 } },
    ])
    const out = (run('review', agent) as { text: string }).text
    const rows = rowsOf(out)
    expect(rows).toHaveLength(4)
    expect(rows[0]).toContain('classifier')
    expect(rows[0]).toContain('Bash')
    expect(rows[2]).toContain('read')
    expect(rows[2]).toContain('flag')
    expect(rows[1]).toContain('deny')
    expect(rows[1]).toContain('Never destroy session audit records.')
    expect(rows[3]).toContain('timeout')
    // Recency: newest event is the LAST row.
    expect(rows[3]).toContain('bash')
  })

  it('forward-compat fold: old events without rule/reason/input fold fine (dashes)', () => {
    const { run } = harness()
    const agent = sessionWith([
      { type: 'permission/classifier', data: { tool: 'Bash', digest: 'a'.repeat(64), verdict: 'allow', latencyMs: 5, cacheHit: false } },
    ])
    const out = (run('review', agent) as { text: string }).text
    const rows = rowsOf(out)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('allow')
    for (const ch of out) expect(ch === '\n' || ch === '\t' || ch >= ' ').toBe(true)
  })

  it('caps at the most recent 20 rows', () => {
    const { run } = harness()
    const events = Array.from({ length: 25 }, (_, i) => ({ type: 'permission/classifier', data: { tool: `tool${i}`, verdict: 'allow', latencyMs: i, cacheHit: false } }))
    const out = (run('review', sessionWith(events)) as { text: string }).text
    const rows = rowsOf(out)
    expect(rows).toHaveLength(20)
    expect(rows[0]).toContain('tool5')
    expect(rows.at(-1)).toContain('tool24')
  })

  it('review full prints inputs when present, one note when auditFullText is off', () => {
    const { run } = harness()
    const withInput = sessionWith([
      { type: 'permission/classifier', data: { tool: 'Bash', digest: 'a'.repeat(64), verdict: 'allow', latencyMs: 5, cacheHit: false, input: 'ls -la' } },
    ])
    const full = (run('review full', withInput) as { text: string }).text
    expect(full).toContain('ls -la')
    const withoutInput = sessionWith([
      { type: 'permission/classifier', data: { tool: 'Bash', digest: 'a'.repeat(64), verdict: 'allow', latencyMs: 5, cacheHit: false } },
    ])
    const fullAbsent = (run('review full', withoutInput) as { text: string }).text
    expect(fullAbsent).toContain('auditFullText')
    // Non-full variant never prints inputs.
    expect((run('review', withInput) as { text: string }).text).not.toContain('ls -la')
  })

  it('session-derived text is sanitized: hostile toolName/reason/input cannot smuggle control characters', () => {
    const { run } = harness()
    const evil = '\u001B]0;pwned\u0007'
    const agent = sessionWith([
      { type: 'permission/classifier', data: { tool: `Bash${evil}`, digest: 'a'.repeat(64), verdict: 'ask', reason: `evil ${evil}`, latencyMs: 1, cacheHit: false, input: `cmd ${evil}` } },
    ])
    for (const args of ['review', 'review full']) {
      const out = (run(args, agent) as { text: string }).text
      for (const ch of out) expect(ch === '\n' || ch === '\t' || ch >= ' ').toBe(true)
      expect(out).not.toContain('\u001B')
    }
  })

  it('unknown review argument is a pinned usage error', () => {
    const { run } = harness()
    const result = run('review bogus', sessionWith([]))
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain('usage')
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
