import { describe, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult } from '@dsh-cc/tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  PROBE_EVENT,
  appendSessionProbe,
  createPiProbe,
  foldProbes,
  matchesScanSet,
  probeInputText,
  probeWarningText,
  type PiProbeDeps,
  type ProbeAuditEventData,
  type ProbeFoldDecision,
} from '../src/pi-probe.ts'
import type { PermissionMode } from '../src/types.ts'

function exec(opts: { name?: string; args?: unknown; session?: Session; signal?: AbortSignal } = {}): ToolExecution {
  const signal = opts.signal ?? new AbortController().signal
  const session = opts.session ?? sessionOf('probe')
  const agent = { id: 'a1', session } as unknown as ToolExecution['agent']
  return {
    signal,
    callId: 'c1',
    name: opts.name ?? 'read',
    arguments: opts.args ?? { file_path: '/work/x.ts' },
    ...(agent === undefined ? {} : { agent }),
  } as unknown as ToolExecution
}

function sessionOf(id: string, cwd = '/work'): Session {
  return Session.create(SessionId(id), undefined, { version: 3, isSeeded: false, id: SessionId(id), createdAt: Date.now(), cwd })
}

const text = (t: string): ContentBlock => ({ type: 'text', text: t })

function result(blocks: ContentBlock[]): ToolExecutionResult {
  return { isError: false, content: blocks } as unknown as ToolExecutionResult
}

/** A plain accept decision with no content of its own (the "no downstream fold" shape). */
const plainDownstream: ProbeFoldDecision = { kind: 'accept' }

/** Flatten the text of a sideband context entry (UserMessage content blocks). */
function contextTexts(contexts: readonly { content: ContentBlock[] }[]): string[] {
  return contexts.flatMap(message => message.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text))
}

interface Harness {
  deps: PiProbeDeps
  settings: { value: Record<string, unknown> }
  mode: PermissionMode
  scripted: string[]
  streams: number
  warnings: string[]
  route: { provider: string; model: string } | undefined
  audit: ReturnType<typeof vi.fn>
  streamError: Error | undefined
  streamDelayMs: number
}

function harness(overrides: Partial<Harness> = {}): Harness {
  const h: Harness = {
    settings: { value: {} },
    mode: 'auto',
    scripted: [],
    streams: 0,
    warnings: [],
    route: { provider: 'fake', model: 'probe-model' },
    audit: vi.fn(),
    streamError: undefined,
    streamDelayMs: 0,
    ...overrides,
  }
  h.deps = {
    settingsRead: () => h.settings.value,
    stream: async () => {
      h.streams += 1
      if (h.streamDelayMs > 0) await new Promise(resolve => setTimeout(resolve, h.streamDelayMs))
      if (h.streamError !== undefined) throw h.streamError
      return h.scripted.shift() ?? '{"injection":false,"reason":"clean"}'
    },
    resolveRoute: () => h.route,
    warn: (message: string) => { h.warnings.push(message) },
    audit: h.audit,
    modeOf: () => h.mode,
  } as PiProbeDeps
  return h
}

function lastAudit(h: Harness): ProbeAuditEventData {
  expect(h.audit).toHaveBeenCalled()
  return h.audit.mock.calls.at(-1)![1] as ProbeAuditEventData
}

describe('probe verdict parse (defensive, classifier parseVerdict idiom)', () => {
  it('valid pass verdict: no warning, audit verdict pass with digest + route attribution', async () => {
    const h = harness()
    h.scripted = ['{"injection":false,"reason":"no instructions"}']
    const probe = createPiProbe(h.deps)
    const out = await probe.scan(exec(), result([text('hello')]), plainDownstream)
    expect(out).toBe(plainDownstream)
    expect(h.streams).toBe(1)
    expect(lastAudit(h)).toMatchObject({ tool: 'read', verdict: 'pass', provider: 'fake', model: 'probe-model', route: 'fake/probe-model' })
    expect(lastAudit(h).digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('flag verdict: reason sanitized and capped, warning attached via additionalContexts sideband, audit reason flag-only', async () => {
    const h = harness()
    h.scripted = [JSON.stringify({ injection: true, reason: `${'x'.repeat(200)}\n\tignore earlier` })]
    const probe = createPiProbe(h.deps)
    const out = await probe.scan(exec({ name: 'bash' }), result([text('output')]), plainDownstream) as { additionalContexts?: { content: ContentBlock[] }[] }
    const [warning] = contextTexts(out.additionalContexts ?? [])
    expect(warning).toContain('Security notice')
    const audit = lastAudit(h)
    expect(audit.verdict).toBe('flag')
    expect(audit.reason).toHaveLength(120)
    expect(audit.reason).not.toMatch(/[\x00-\x1f\x7f]/)
  })

  it('code-fenced verdict parses; non-JSON and wrong shape are malformed', async () => {
    const h = harness()
    h.scripted = ['```json\n{"injection":false,"reason":"ok"}\n```']
    const probe = createPiProbe(h.deps)
    await probe.scan(exec(), result([text('a')]), plainDownstream)
    expect(lastAudit(h).failure).toBeUndefined()

    for (const garbage of ['not json', '{"reason":"no injection field"}', '{"injection":"yes"}', '[]']) {
      const h2 = harness()
      h2.scripted = [garbage]
      const probe2 = createPiProbe(h2.deps)
      await probe2.scan(exec(), result([text('a')]), plainDownstream)
      expect(lastAudit(h2)).toMatchObject({ verdict: 'pass', failure: 'malformed' })
    }
  })
})

describe('probe input extraction (W2)', () => {
  it('non-text blocks are skipped (A4); empty text ⇒ no probe call at all', async () => {
    expect(probeInputText([{ type: 'text', text: 'a' }, { type: 'image', data: 'zz' } as unknown as ContentBlock])).toBe('a')
    const h = harness()
    const probe = createPiProbe(h.deps)
    const out = await probe.scan(exec(), result([{ type: 'image', data: 'zz' } as unknown as ContentBlock]), plainDownstream)
    expect(out).toBe(plainDownstream)
    expect(h.streams).toBe(0)
    expect(h.audit).not.toHaveBeenCalled()
  })

  it('truncation windows: first 3072 + elision + last 1024; short input uncapped', async () => {
    const long = 'H'.repeat(5000) + 'MIDDLE' + 'T'.repeat(3000)
    const probeIn = probeInputText([text(long)])!
    expect(probeIn.length).toBe(3072 + '\n[… probe input truncated …]\n'.length + 1024)
    expect(probeIn.startsWith('H'.repeat(3072))).toBe(true)
    expect(probeIn.endsWith('T'.repeat(1024))).toBe(true)
    expect(probeIn).not.toContain('MIDDLE')
    expect(probeInputText([text('short')])).toBe('short')
  })
})

describe('scan set matching (D8/A11)', () => {
  it('defaults: read/read_image/bash/web_fetch/web_search match (incl. CC spellings via ccToolAliases) + mcp__*; others do not', () => {
    for (const name of ['read', 'read_image', 'bash', 'web_fetch', 'web_search', 'Read', 'Bash', 'mcp__github.list_issues']) {
      expect(matchesScanSet(name)).toBe(true)
    }
    for (const name of ['edit', 'todo_write', 'context_retrieve', 'ExitPlanMode']) {
      expect(matchesScanSet(name)).toBe(false)
    }
  })

  it('toolPatterns REPLACE the default set entirely: exact names and trailing-* prefixes', () => {
    expect(matchesScanSet('read', ['grep'])).toBe(false)
    expect(matchesScanSet('grep', ['grep'])).toBe(true)
    expect(matchesScanSet('grep_file', ['grep*'])).toBe(true)
    expect(matchesScanSet('edit', ['edit*'])).toBe(true)
  })
})

describe('mode gating (W4: probe NEVER runs outside auto; A8 folded per call)', () => {
  for (const mode of ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const) {
    it(`mode ${mode}: probe never runs`, async () => {
      const h = harness({ mode })
      const probe = createPiProbe(h.deps)
      const out = await probe.scan(exec(), result([text('x')]), plainDownstream)
      expect(out).toBe(plainDownstream)
      expect(h.streams).toBe(0)
      expect(h.audit).not.toHaveBeenCalled()
    })
  }

  it('stale-mode: leaving auto mid-flight ⇒ pass-through with a stale-mode audit (never breaker-counted)', async () => {
    const h = harness()
    let mode: PermissionMode = 'auto'
    h.deps.modeOf = () => mode
    h.scripted = ['{"injection":true,"reason":"bad"}']
    const probe = createPiProbe(h.deps)
    const pending = probe.scan(exec(), result([text('x')]), plainDownstream)
    mode = 'default'
    const out = await pending
    expect(out).toBe(plainDownstream)
    expect(lastAudit(h)).toMatchObject({ verdict: 'pass', failure: 'stale-mode' })
    // And the breaker did NOT count the discarded outcome: two more failures
    // still leave the route usable.
    mode = 'auto'
    h.scripted = ['garbage', 'garbage']
    await probe.scan(exec(), result([text('x')]), plainDownstream)
    await probe.scan(exec(), result([text('x')]), plainDownstream)
    expect(h.streams).toBe(3)
  })
})

describe('fail-open paths (W4 table)', () => {
  it('timeout: stream resolves after the timer ⇒ pass + failure timeout + breaker accounting', async () => {
    const h = harness({ streamDelayMs: 30 })
    h.settings.value = { autoMode: { probe: { timeoutMs: 5 } } }
    h.scripted = ['{"injection":true,"reason":"late"}']
    const probe = createPiProbe(h.deps)
    const out = await probe.scan(exec(), result([text('x')]), plainDownstream)
    expect(out).toBe(plainDownstream)
    expect(lastAudit(h)).toMatchObject({ verdict: 'pass', failure: 'timeout' })
  })

  it('error: stream rejects ⇒ pass + failure error', async () => {
    const h = harness()
    h.streamError = new Error('lane down')
    const probe = createPiProbe(h.deps)
    await probe.scan(exec(), result([text('x')]), plainDownstream)
    expect(lastAudit(h)).toMatchObject({ verdict: 'pass', failure: 'error' })
  })

  it('cancelled: caller abort mid-flight ⇒ failure cancelled, never breaker-counted', async () => {
    const controller = new AbortController()
    const h = harness()
    h.deps.stream = async () => {
      controller.abort()
      return '{"injection":false,"reason":"ok"}'
    }
    const probe = createPiProbe(h.deps)
    await probe.scan(exec({ signal: controller.signal }), result([text('x')]), plainDownstream)
    expect(lastAudit(h)).toMatchObject({ verdict: 'pass', failure: 'cancelled' })
    expect(h.warnings).toHaveLength(0)
  })

  it('unarmed (no stream): pass + warn-once per process + unarmed audit per call', async () => {
    const h = harness()
    h.deps.stream = undefined
    const probe = createPiProbe(h.deps)
    const s = sessionOf('unarmed')
    await probe.scan(exec({ session: s }), result([text('x')]), plainDownstream)
    await probe.scan(exec({ session: s }), result([text('x')]), plainDownstream)
    expect(h.warnings).toHaveLength(1)
    const records = h.audit.mock.calls.map(call => call[1] as ProbeAuditEventData)
    expect(records).toHaveLength(2)
    expect(records.every(record => record.failure === 'unarmed')).toBe(true)
  })

  it('breaker: 3 consecutive failures open the route (pass + one breaker audit + warn-once); settings change resets', async () => {
    const h = harness()
    h.scripted = ['garbage', 'garbage', 'garbage', 'garbage']
    const s = sessionOf('breaker')
    const probe = createPiProbe(h.deps)
    for (let i = 0; i < 4; i += 1) {
      await probe.scan(exec({ name: 'bash', session: s }), result([text(`x${i}`)]), plainDownstream)
    }
    expect(h.streams).toBe(3) // 4th call is breaker-blocked
    const records = h.audit.mock.calls.map(call => call[1] as ProbeAuditEventData)
    expect(records.filter(record => record.failure === 'malformed')).toHaveLength(3)
    expect(records.filter(record => record.failure === 'breaker')).toHaveLength(1)
    expect(h.warnings.filter(w => w.includes('breaker open'))).toHaveLength(1)
    // A clean verdict (impossible while open) resets; a settings change does.
    probe.rebuild()
    h.scripted = ['{"injection":false,"reason":"ok"}']
    await probe.scan(exec({ name: 'bash', session: s }), result([text('ok')]), plainDownstream)
    expect(h.streams).toBe(4)
   })
})

describe('breaker seeding from the session log (W1 shared fold)', () => {
  function appendProbe(session: Session, data: ProbeAuditEventData): void {
    appendSessionProbe(session, data)
  }

  it('a fabricated log with 3 attributed malformed probe events opens the breaker at seed time', async () => {
    const s = sessionOf('seeded')
    for (let i = 0; i < 3; i += 1) {
      appendProbe(s, { tool: 'bash', digest: 'd', verdict: 'pass', failure: 'malformed', route: 'fake/probe-model', provider: 'fake', model: 'probe-model', latencyMs: 1 })
    }
    const h = harness()
    const probe = createPiProbe(h.deps)
    await probe.scan(exec({ name: 'bash', session: s }), result([text('x')]), plainDownstream)
    expect(h.streams).toBe(0) // seeded-open: the stream is never touched
    const records = h.audit.mock.calls.map(call => call[1] as ProbeAuditEventData)
    expect(records.at(-1)).toMatchObject({ failure: 'breaker', verdict: 'pass' })
    expect(h.warnings.some(w => w.includes('restored with 3 consecutive failures'))).toBe(true)
  })

  it('a log already carrying a breaker event does not re-audit on replay', async () => {
    const s = sessionOf('seeded-once')
    for (let i = 0; i < 3; i += 1) {
      appendProbe(s, { tool: 'bash', digest: 'd', verdict: 'pass', failure: 'malformed', route: 'fake/probe-model', provider: 'fake', model: 'probe-model', latencyMs: 1 })
    }
    appendProbe(s, { tool: 'bash', verdict: 'pass', failure: 'breaker', route: 'fake/probe-model', provider: 'fake', model: 'probe-model', latencyMs: 0 })
    const h = harness()
    const probe = createPiProbe(h.deps)
    await probe.scan(exec({ name: 'bash', session: s }), result([text('x')]), plainDownstream)
    expect(foldProbes(s.snapshotEvents() as unknown as SessionEvent[]).filter(record => record.failure === 'breaker')).toHaveLength(1)
  })

  it('seed-once: the log is folded only on the first breaker-eligible call', async () => {
    const s = sessionOf('seed-once')
    const snapshot = vi.spyOn(s, 'snapshotEvents')
    const h = harness()
    const probe = createPiProbe(h.deps)
    await probe.scan(exec({ name: 'bash', session: s }), result([text('x')]), plainDownstream)
    const afterFirst = snapshot.mock.calls.length
    await probe.scan(exec({ name: 'bash', session: s }), result([text('y')]), plainDownstream)
    expect(snapshot.mock.calls.length).toBe(afterFirst)
  })
})

describe('sideband delivery (A1: additionalContexts, never content; frozen-input safety)', () => {
  const original = [text('FIRST'), text('SECOND')]

  it('flag ⇒ warning block rides the downstream decision via additionalContexts; content untouched', async () => {
    const h = harness()
    h.scripted = ['{"injection":true,"reason":"override attempt"}']
    const probe = createPiProbe(h.deps)
    const downstream: ProbeFoldDecision = { kind: 'accept', content: [text('CCR-REWRITTEN')] }
    const out = await probe.scan(exec({ name: 'bash' }), result(original), downstream) as { content?: ContentBlock[]; additionalContexts?: { content: ContentBlock[] }[] }
    expect(out.additionalContexts).toHaveLength(1)
    expect(contextTexts(out.additionalContexts!)).toEqual([probeWarningText('bash', 'override attempt')])
    // The downstream content passes through untouched (sideband, not content edit).
    expect(out.content).toEqual([text('CCR-REWRITTEN')])
    expect(downstream.content).toHaveLength(1)
  })

  it('plain downstream (no content, no contexts) ⇒ warning via additionalContexts; frozen result untouched', async () => {
    const h = harness()
    h.scripted = ['{"injection":true,"reason":"override attempt"}']
    const probe = createPiProbe(h.deps)
    const out = await probe.scan(exec({ name: 'bash' }), result(original), plainDownstream) as { additionalContexts?: { content: ContentBlock[] }[] }
    expect(out.additionalContexts).toHaveLength(1)
    expect(contextTexts(out.additionalContexts!)[0]).toContain('Security notice')
  })

  it('existing downstream additionalContexts are PRESERVED (warning appended after them)', async () => {
    const h = harness()
    h.scripted = ['{"injection":true,"reason":"bad"}']
    const probe = createPiProbe(h.deps)
    const existing = { content: [text('pre-existing hint')] } as UserMessage
    const downstream = { kind: 'accept', additionalContexts: [existing] } as unknown as ProbeFoldDecision
    const out = await probe.scan(exec({ name: 'bash' }), result(original), downstream) as { additionalContexts?: { content: ContentBlock[] }[] }
    expect(out.additionalContexts).toHaveLength(2)
    expect(contextTexts(out.additionalContexts!)).toEqual(['pre-existing hint', probeWarningText('bash', 'bad')])
    expect(out.additionalContexts![0]).toBe(existing) // existing entry preserved, downstream never mutated
    expect(downstream.additionalContexts).toHaveLength(1)
  })

  it('frozen result + frozen downstream: no mutation, no throw, warning on a NEW array', async () => {
    const h = harness()
    h.scripted = ['{"injection":true,"reason":"bad"}']
    const frozenResult = Object.freeze({ ...result(original), content: Object.freeze([...original.map(block => Object.freeze({ ...block }))]) })
    const downstream = Object.freeze({ kind: 'accept', additionalContexts: Object.freeze([{ content: [text('hint')] }]) } as unknown as ProbeFoldDecision)
    const probe = createPiProbe(h.deps)
    const out = await probe.scan(exec({ name: 'bash' }), frozenResult, downstream) as { content?: ContentBlock[]; additionalContexts?: ContentBlock[] }
    expect(out.additionalContexts).toHaveLength(2)
    expect(frozenResult.content).toHaveLength(2) // untouched — sideband never touches the result
    expect(out.content).toBeUndefined()
  })

  it('value-replacing accept decisions carry the warning too (runtime-results.ts merges additionalContexts onto replaced results)', async () => {
    const h = harness()
    h.scripted = ['{"injection":true,"reason":"bad"}']
    const probe = createPiProbe(h.deps)
    const downstream = { kind: 'accept', value: { replaced: true } } as unknown as ProbeFoldDecision
    const out = await probe.scan(exec({ name: 'bash' }), result(original), downstream) as { additionalContexts?: { content: ContentBlock[] }[] }
    expect(out.additionalContexts).toHaveLength(1)
    expect(contextTexts(out.additionalContexts!)[0]).toContain('Security notice')
  })
})

describe('warning text (prose contract)', () => {
  it('names the probe, treats content as untrusted data, re-anchors on the user request', () => {
    const t = probeWarningText('read', '')
    expect(t).toContain('prompt-injection probe')
    expect(t).toContain('untrusted data')
    expect(t).toContain('re-anchor')
    expect(t).toContain('"read"')
  })
})

describe('S5 full-text audit (probe events honor classifier.auditFullText)', () => {
  it('default (flag off): probe audit events stay digest-only — no `input` key', async () => {
    const h = harness()
    const probe = createPiProbe(h.deps)
    await probe.scan(exec(), result([text('hello world')]), plainDownstream)
    expect('input' in lastAudit(h)).toBe(false)
    expect(lastAudit(h).digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('flag on: the probe audit event gains the windowed probe input', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { auditFullText: true } } }
    const probe = createPiProbe(h.deps)
    await probe.scan(exec(), result([text('hello world')]), plainDownstream)
    expect(lastAudit(h).input).toBe('hello world')
  })
})
