/**
 * Observer-level tests (plan §Verification): role/kind-aware system accounting,
 * per-message composition, aux-call attribution, unknown-purpose passthrough,
 * scope-key caching, section caps, subagent gating, and the fail-soft contract
 * (any exception → zero rows plus a debug log, never a throw into the
 * waterfall).
 *
 * The listeners are driven directly through the observer set — no cordis rig
 * needed for the observation semantics; the registration/refcount side lives in
 * `mount.spec.ts`.
 */

import { describe, expect, it, vi } from 'vitest'
import { projectKeyOf, shortHash } from '@dsh-cc/sidecar-io'
import type { AssembleRow, InputLedgerSettings, LedgerRow, RequestRow } from '../src/index.ts'
import { createObservers, DEFAULT_INPUT_LEDGER_SETTINGS } from '../src/index.ts'

const CWD = '/repo/root'
const PROJECT_KEY = projectKeyOf(CWD)

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

interface Emitted {
  row: LedgerRow
  projectKey: string
  settings: InputLedgerSettings
}

interface RigOptions {
  settings?: Partial<InputLedgerSettings>
  gen?: string
  emitThrows?: boolean
  settingsThrow?: boolean
}

function rig(options: RigOptions = {}) {
  const emitted: Emitted[] = []
  const debug = vi.fn()
  const settings: InputLedgerSettings = { ...DEFAULT_INPUT_LEDGER_SETTINGS, ...options.settings }
  const observers = createObservers({
    readSettings: () => {
      if (options.settingsThrow === true) throw new Error('settings read failed')
      return settings
    },
    emit: (row, projectKey, effective) => {
      if (options.emitThrows === true) throw new Error('emit failed')
      emitted.push({ row, projectKey, settings: effective })
    },
    debug,
    gen: options.gen ?? 'gen-test',
  })
  return { emitted, debug, observers, settings }
}

interface AgentOptions {
  id?: string
  sessionId?: string
  cwd?: string | null
  delegationDepth?: number
  subagentDepth?: number
}

function agent(options: AgentOptions = {}) {
  const sessionId = options.sessionId ?? 'sess-1'
  const cwd = options.cwd === undefined ? CWD : options.cwd
  return {
    id: options.id ?? sessionId,
    session: {
      id: sessionId,
      header: {
        ...(cwd === null ? {} : { cwd }),
        ...(options.delegationDepth === undefined ? {} : { delegationDepth: options.delegationDepth }),
      },
    },
    ...(options.subagentDepth === undefined ? {} : { options: { subagentDepth: options.subagentDepth } }),
  }
}

function text(value: string) {
  return { type: 'text', text: value }
}

function message(role: string, content: unknown[], sourceKind?: string) {
  return { role, content, ...(sourceKind === undefined ? {} : { source: { kind: sourceKind } }) }
}

type Observers = ReturnType<typeof rig>['observers']

async function recordStep(
  observers: Observers,
  options: { agent?: unknown; turn?: unknown; step?: unknown } = {},
): Promise<void> {
  await observers.preStep(
    {
      agent: options.agent ?? agent(),
      messages: [],
      turn: options.turn ?? 1,
      step: options.step ?? 2,
      signal: new AbortController().signal,
      modelSelection: {},
    },
    async () => ({ decision: 'keep' }),
  )
}

async function request(observers: Observers, options: Record<string, unknown>): Promise<void> {
  observers.request(options, () => ({}))
}

function requestRow(emitted: Emitted[]): RequestRow {
  const entry = emitted.find(item => item.row.type === 'request')
  expect(entry).toBeDefined()
  return entry!.row as RequestRow
}

function assembleRow(emitted: Emitted[]): AssembleRow {
  const entry = emitted.find(item => item.row.type === 'assemble')
  expect(entry).toBeDefined()
  return entry!.row as AssembleRow
}

async function fireAssemble(observers: Observers, sections: Array<{ name: string; text: string }>, scope?: unknown) {
  return observers.assemble(undefined, scope === undefined ? {} : { scope }, async () => ({ sections }))
}

function assembleFlags(emitted: Emitted[]): boolean[] {
  return emitted.map(item => (item.row as AssembleRow).renderedFromCache)
}

describe('request observer — system accounting', () => {
  it('sums the leading system-role message and the one-shot options.system field', async () => {
    const { emitted, observers } = rig()
    await recordStep(observers)
    await request(observers, {
      provider: 'deepseek', model: 'x', system: 'ONE SHOT', sessionId: 'sess-1',
      messages: [
        message('system', [text('SYSTEM PROMPT')], 'system-prompt'),
        message('user', [text('hello')], 'user'),
      ],
    })

    const row = requestRow(emitted)
    expect(row.systemBytes).toBe(byteLength('ONE SHOT') + byteLength('SYSTEM PROMPT'))
    expect(row.systemHash8).toBe(shortHash('ONE SHOT\nSYSTEM PROMPT', 8))
    expect(row.systemHash8).toHaveLength(8)
  })

  it('counts a later message whose producer declared source.kind === system-prompt', async () => {
    const { emitted, observers } = rig()
    await recordStep(observers)
    await request(observers, {
      provider: 'deepseek', model: 'x', sessionId: 'sess-1',
      messages: [
        message('user', [text('hello')], 'user'),
        message('assistant', [text('hi')], 'model'),
        message('user', [text('INJECTED')], 'system-prompt'),
      ],
    })

    const row = requestRow(emitted)
    expect(row.systemBytes).toBe(byteLength('INJECTED'))
    expect(row.systemHash8).toBe(shortHash('INJECTED', 8))
  })

  it('ignores a mid-conversation system-role message without the system-prompt source', async () => {
    const { emitted, observers } = rig()
    await recordStep(observers)
    await request(observers, {
      provider: 'deepseek', model: 'x', sessionId: 'sess-1',
      messages: [
        message('user', [text('hello')], 'user'),
        message('system', [text('LATE SYSTEM')], 'other'),
      ],
    })

    const row = requestRow(emitted)
    expect(row.systemBytes).toBe(0)
    expect(row.systemHash8).toBe('')
  })

  it('hashes nothing when the request carries no system text', async () => {
    const { emitted, observers } = rig()
    await recordStep(observers)
    await request(observers, {
      provider: 'deepseek', model: 'x', sessionId: 'sess-1',
      messages: [message('user', [text('hello')], 'user')],
    })
    expect(requestRow(emitted).systemHash8).toBe('')
  })
})

describe('request observer — message composition', () => {
  it('records counts, text bytes, non-text blocks, source kinds, tool results and assistant bytes', async () => {
    const { emitted, observers } = rig()
    await recordStep(observers)
    await request(observers, {
      provider: 'deepseek', model: 'x', sessionId: 'sess-1',
      messages: [
        message('system', [text('SYS')], 'system-prompt'),
        message('user', [text('hello')], 'user'),
        message('assistant', [text('reply'), { type: 'tool-call', id: 'c1', name: 'n', arguments: '{}' }], 'model'),
        message('tool', [text('{"ok":true}')], 'tool'),
        { role: 'user', content: [text('no source'), { type: 'image', attachment: {} }] },
      ],
    })

    const { messages } = requestRow(emitted)
    expect(messages.count).toBe(5)
    expect(messages.bytesTotal).toBe(
      byteLength('SYS') + byteLength('hello') + byteLength('reply')
      + byteLength('{"ok":true}') + byteLength('no source'),
    )
    expect(messages.nonTextBlocks).toBe(2)
    expect(messages.assistantBytes).toBe(byteLength('reply'))
    expect(messages.toolResults).toEqual({ count: 1, bytes: byteLength('{"ok":true}') })
    expect(messages.bySourceKind['system-prompt']).toEqual({ count: 1, bytes: byteLength('SYS') })
    expect(messages.bySourceKind.user).toEqual({
      count: 2,
      bytes: byteLength('hello') + byteLength('no source'),
    })
    expect(messages.bySourceKind.model).toEqual({ count: 1, bytes: byteLength('reply') })
    expect(messages.bySourceKind.tool).toEqual({ count: 1, bytes: byteLength('{"ok":true}') })
  })

  it('measures tool declarations by count and serialized bytes', async () => {
    const { emitted, observers } = rig()
    await recordStep(observers)
    const tools = [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }]
    await request(observers, { provider: 'deepseek', model: 'x', tools, messages: [], sessionId: 'sess-1' })

    const row = requestRow(emitted)
    expect(row.toolsCount).toBe(1)
    expect(row.toolsBytes).toBe(byteLength(JSON.stringify(tools[0])))
  })
})

describe('request observer — attribution', () => {
  it('takes turn/step from the pre-step payload on main-loop requests', async () => {
    const { emitted, observers } = rig()
    await recordStep(observers, { turn: 3, step: 7 })
    await request(observers, { provider: 'p', model: 'm', messages: [], sessionId: 'sess-1' })

    const row = requestRow(emitted)
    expect(row.turn).toBe(3)
    expect(row.step).toBe(7)
    expect(row.mainLoop).toBe(true)
    expect(row.purpose).toBeUndefined()
  })

  it('leaves turn/step undefined explicitly for auxiliary calls (purpose set)', async () => {
    const { emitted, observers } = rig()
    await recordStep(observers, { turn: 3, step: 7 })
    await request(observers, { provider: 'p', model: 'm', messages: [], sessionId: 'sess-1', purpose: 'compaction' })

    const row = requestRow(emitted)
    expect(row.turn).toBeUndefined()
    expect(row.step).toBeUndefined()
    expect(row.purpose).toBe('compaction')
    expect(row.mainLoop).toBe(false)
  })

  it('records an unknown purpose verbatim (the purpose map is open)', async () => {
    const { emitted, observers } = rig()
    await recordStep(observers)
    await request(observers, { provider: 'p', model: 'm', messages: [], sessionId: 'sess-1', purpose: 'future-producer' })

    const row = requestRow(emitted)
    expect(row.purpose).toBe('future-producer')
    expect(row.turn).toBeUndefined()
  })

  it('skips requests whose session has no recorded attribution yet', async () => {
    const { emitted, observers } = rig()
    await request(observers, { provider: 'p', model: 'm', messages: [], sessionId: 'unknown' })
    expect(emitted).toHaveLength(0)
  })

  it('skips requests without a sessionId', async () => {
    const { emitted, observers } = rig()
    await recordStep(observers)
    await request(observers, { provider: 'p', model: 'm', messages: [] })
    expect(emitted).toHaveLength(0)
  })

  it('increments seqPerGen monotonically per (sessionId, gen)', async () => {
    const { emitted, observers } = rig()
    await recordStep(observers)
    for (let index = 0; index < 3; index += 1) {
      await request(observers, { provider: 'p', model: 'm', messages: [], sessionId: 'sess-1' })
    }
    const seqs = emitted
      .filter(item => item.row.type === 'request')
      .map(item => (item.row as RequestRow).seqPerGen)
    expect(seqs).toEqual([1, 2, 3])
    expect(emitted.every(item => item.row.gen === 'gen-test')).toBe(true)
  })

  it('files rows under the project key of the session cwd', async () => {
    const { emitted, observers } = rig()
    await recordStep(observers)
    await request(observers, { provider: 'p', model: 'm', messages: [], sessionId: 'sess-1' })
    expect(emitted[0]?.projectKey).toBe(PROJECT_KEY)
  })
})

describe('assemble observer', () => {
  it('records section names, byte sizes, fingerprints and the total', async () => {
    const { emitted, observers } = rig()
    const presentation = await fireAssemble(observers, [
      { name: 'core', text: 'CORE' },
      { name: 'memory', text: 'MEMORY TEXT' },
    ], agent())

    expect(presentation.sections).toHaveLength(2)
    const row = assembleRow(emitted)
    expect(row.isSubagent).toBe(false)
    expect(row.totalBytes).toBe(byteLength('CORE') + byteLength('MEMORY TEXT'))
    expect(row.sections).toEqual([
      { name: 'core', bytes: byteLength('CORE'), hash8: shortHash('CORE', 8) },
      { name: 'memory', bytes: byteLength('MEMORY TEXT'), hash8: shortHash('MEMORY TEXT', 8) },
    ])
    expect(row.renderedFromCache).toBe(false)
  })

  it('reports renderedFromCache only for an identical re-assembly of the same scope', async () => {
    const { emitted, observers } = rig()
    const scope = agent()
    await fireAssemble(observers, [{ name: 'core', text: 'A' }], scope)
    await fireAssemble(observers, [{ name: 'core', text: 'A' }], scope)
    await fireAssemble(observers, [{ name: 'core', text: 'B' }], scope)
    expect(assembleFlags(emitted)).toEqual([false, true, false])
  })

  it('keys the cache by (sessionId, scopeKey): a second scope starts cold', async () => {
    const { emitted, observers } = rig()
    const sections = [{ name: 'core', text: 'A' }]
    await fireAssemble(observers, sections, agent({ id: 'root', sessionId: 'sess-1' }))
    await fireAssemble(observers, sections, agent({ id: 'root', sessionId: 'sess-1' }))
    await fireAssemble(observers, sections, agent({ id: 'child', sessionId: 'sess-1' }))
    expect(assembleFlags(emitted)).toEqual([false, true, false])
  })

  it('skips scope-less assemblies', async () => {
    const { emitted, observers } = rig()
    await fireAssemble(observers, [{ name: 'core', text: 'A' }])
    await fireAssemble(observers, [{ name: 'core', text: 'A' }], {})
    expect(emitted).toHaveLength(0)
  })

  it('skips assemblies whose agent has no cwd (no project bucket)', async () => {
    const { emitted, observers } = rig()
    await fireAssemble(observers, [{ name: 'core', text: 'A' }], agent({ cwd: null }))
    expect(emitted).toHaveLength(0)
  })

  it('caps the section list at max-sections-per-row while totalBytes covers every section', async () => {
    const { emitted, observers } = rig({ settings: { 'max-sections-per-row': 8 } })
    const sections = Array.from({ length: 10 }, (_, index) => ({ name: `s${index}`, text: `T${index}` }))
    await fireAssemble(observers, sections, agent())

    const row = assembleRow(emitted)
    expect(row.sections).toHaveLength(8)
    expect(row.totalBytes).toBe(sections.reduce((sum, section) => sum + byteLength(section.text), 0))
  })

  it('carries turn/step recorded by the pre-step observer', async () => {
    const { emitted, observers } = rig()
    await recordStep(observers, { turn: 4, step: 9 })
    await fireAssemble(observers, [{ name: 'core', text: 'A' }], agent())

    const row = assembleRow(emitted)
    expect(row.turn).toBe(4)
    expect(row.step).toBe(9)
  })
})

describe('subagent gating', () => {
  it('records delegated-agent rows when include-subagents is true', async () => {
    const { emitted, observers } = rig()
    const child = agent({ id: 'child', sessionId: 'sess-child', delegationDepth: 1 })
    await recordStep(observers, { agent: child })
    await request(observers, { provider: 'p', model: 'm', messages: [], sessionId: 'sess-child' })
    await fireAssemble(observers, [{ name: 'core', text: 'A' }], child)

    expect(emitted.filter(item => item.row.type === 'request')).toHaveLength(1)
    expect(assembleRow(emitted).isSubagent).toBe(true)
  })

  it('skips delegated-agent rows when include-subagents is false', async () => {
    const { emitted, observers } = rig({ settings: { 'include-subagents': false } })
    const child = agent({ id: 'child', sessionId: 'sess-child', subagentDepth: 2 })
    await recordStep(observers, { agent: child })
    await request(observers, { provider: 'p', model: 'm', messages: [], sessionId: 'sess-child' })
    await fireAssemble(observers, [{ name: 'core', text: 'A' }], child)
    expect(emitted).toHaveLength(0)

    await recordStep(observers)
    await request(observers, { provider: 'p', model: 'm', messages: [], sessionId: 'sess-1' })
    expect(emitted).toHaveLength(1)
  })
})

describe('pre-step observer', () => {
  it('returns next() unchanged and emits no row of its own', async () => {
    const { emitted, observers } = rig()
    const decision = { decision: 'keep' }
    const returned = await observers.preStep(
      { agent: agent(), messages: [], turn: 1, step: 1, signal: new AbortController().signal, modelSelection: {} },
      async () => decision,
    )
    expect(returned).toBe(decision)
    expect(emitted).toHaveLength(0)
  })
})

describe('failure semantics', () => {
  it('emits nothing when enabled is false', async () => {
    const { emitted, observers } = rig({ settings: { enabled: false } })
    await recordStep(observers)
    await request(observers, { provider: 'p', model: 'm', messages: [], sessionId: 'sess-1' })
    await fireAssemble(observers, [{ name: 'core', text: 'A' }], agent())
    expect(emitted).toHaveLength(0)
  })

  it('swallows a throwing emit and logs it, on all three listeners', async () => {
    const { emitted, debug, observers } = rig({ emitThrows: true })
    await recordStep(observers)
    const next = { ok: true }
    expect(observers.request({ provider: 'p', model: 'm', messages: [], sessionId: 'sess-1' }, () => next)).toBe(next)
    const decision = { decision: 'keep' }
    const returned = await observers.preStep(
      { agent: agent(), messages: [], turn: 1, step: 1, signal: new AbortController().signal, modelSelection: {} },
      async () => decision,
    )
    expect(returned).toBe(decision)
    const presentation = await fireAssemble(observers, [{ name: 'core', text: 'A' }], agent())
    expect(presentation.sections).toHaveLength(1)

    expect(emitted).toHaveLength(0)
    expect(debug).toHaveBeenCalledTimes(2)
    expect(String(debug.mock.calls[0]?.[0])).toContain('input-ledger:')
  })

  it('emits nothing when the hot settings read throws', async () => {
    const { emitted, debug, observers } = rig({ settingsThrow: true })
    await recordStep(observers)
    await request(observers, { provider: 'p', model: 'm', messages: [], sessionId: 'sess-1' })
    await fireAssemble(observers, [{ name: 'core', text: 'A' }], agent())
    expect(emitted).toHaveLength(0)
    expect(debug).toHaveBeenCalledTimes(2)
  })

  it('tolerates malformed payload shapes without throwing', async () => {
    const { observers } = rig()
    await expect(
      observers.preStep({ agent: null, turn: 'x', step: null } as never, async () => ({})),
    ).resolves.toEqual({})
    const next = { ok: true }
    expect(observers.request({ messages: 'not-an-array', sessionId: 42 } as never, () => next)).toBe(next)
    await expect(observers.assemble(undefined, undefined, async () => ({ sections: 'nope' }))).resolves.toEqual({
      sections: 'nope',
    })
  })
})
