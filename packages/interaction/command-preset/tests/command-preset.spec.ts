import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import {
  DEFAULT_ONLY_TEXT,
  SWITCHED_TEXT,
  apply,
  renderPresetList,
} from '../src/index.ts'
import { VWA_PRESET_NAMESPACE } from '../src/settings.ts'

type Registered = { name: string; handler: (invocation: CommandInvocation) => Promise<CommandResult> }

const ROSTER = [
  { id: 'cc', name: 'CC mode', order: 5, description: 'Claude Code surface' },
  { id: 'vwa', name: 'VWA mode', order: 6, description: 'verifiable deliverables' },
]

/** Duck-typed harness: mounts a registry and an updating settings provider. */
function harness(opts?: {
  locked?: boolean
  otherSelectError?: Error
  updateError?: Error
  noSettings?: boolean
}): {
  run(raw: string): Promise<CommandResult>
  selected: string[]
  written: Array<{ ns: string; patch: Record<string, unknown> }>
  injected: Array<{ kind: string; text: string }>
} {
  const selected: string[] = []
  const written: Array<{ ns: string; patch: Record<string, unknown> }> = []
  const injected: Array<{ kind: string; text: string }> = []
  const agent = {
    inject: (message: { source: { kind: string }; content: ReadonlyArray<{ type: string; text: string }> }) => {
      injected.push({
        kind: message.source.kind,
        text: message.content.map((block) => (block as { text: string }).text).join(''),
      })
    },
  } as unknown as Agent
  const registered: Registered[] = []
  const presets = {
    defaultId: 'cc',
    list: async () => ROSTER,
    select: async (_agent: Agent, id: string) => {
      if (opts?.otherSelectError !== undefined) throw opts.otherSelectError
      if (opts?.locked === true) {
        throw Object.assign(new Error('This session has already started'), { code: 'agent-preset/locked' })
      }
      selected.push(id)
      return id
    },
  }
  const ctx = {
    commands: { register: (def: Registered) => { registered.push(def) } },
    get(name: string) {
      if (name === 'agentPresets') return presets
      if (name === 'settings') {
        return opts?.noSettings === true ? undefined : {
          get: () => undefined,
          // registerNamespaceSafe self-healing needs a registrable provider.
          register: () => ({ get: () => undefined }),
          update: async (ns: string, patch: Record<string, unknown>) => {
            if (opts?.updateError !== undefined) throw opts.updateError
            written.push({ ns, patch })
          },
        }
      }
      return undefined
    },
  } as unknown as Context
  apply(ctx)
  expect(registered).toHaveLength(1)
  return {
    run: (raw) => registered[0]!.handler({ rawInput: raw, agent } as unknown as CommandInvocation),
    selected,
    written,
    injected,
  }
}

describe('plugin definition', () => {
  it('declares cordis inject for the commands service (no agentPresets — re-composition trap)', async () => {
    // Repo lesson (advisor-watchdog): hand-built test contexts mask a missing
    // inject declaration, so the plugin definition itself is pinned. The
    // registry is read with a loud apply-time ctx.get instead: declaring it
    // here would re-compose the registry inside the preset scope.
    const mod = await import('../src/index.ts')
    expect(mod.inject).toContain('commands')
    expect(mod.inject).not.toContain('agentPresets')
    expect(mod.inject).toHaveLength(1)
  })
})

describe('/preset bare invocation', () => {
  it('lists id, name, order, description, and the current default — and writes nothing', async () => {
    const { run, selected, written } = harness()
    const result = await run('')
    expect(result.kind).toBe('success')
    const text = (result as { text: string }).text
    expect(text).toContain('current default: "cc"')
    expect(text).toContain('* cc — CC mode (order 5) — Claude Code surface')
    expect(text).toContain('vwa — VWA mode (order 6) — verifiable deliverables')
    expect(selected).toEqual([])
    expect(written).toEqual([])
  })

  it('renderPresetList marks the default and lists valid ids', () => {
    const text = renderPresetList(ROSTER, 'vwa')
    expect(text).toContain('* vwa')
    expect(text).not.toContain('* cc')
  })
})

describe('/preset <id>', () => {
  it('full success: validates, selects, writes vwa-preset.selectedDefault, injects the T1 announcement', async () => {
    const h = harness()
    const result = await h.run('vwa')
    expect(result.kind).toBe('success')
    expect(h.selected).toEqual(['vwa'])
    expect(h.written).toEqual([{ ns: VWA_PRESET_NAMESPACE, patch: { selectedDefault: 'vwa' } }])
    expect(h.injected).toHaveLength(1)
    expect(h.injected[0]!.kind).toBe('command-preset')
    expect(h.injected[0]!.text).toBe(SWITCHED_TEXT('vwa'))
    expect((result as { text: string }).text).toContain('new sessions will also start')
  })

  it('unknown id: error listing the valid ids, no select, no write, no announcement', async () => {
    const h = harness()
    const result = await h.run('bogus')
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain('valid ids: cc, vwa')
    expect(h.selected).toEqual([])
    expect(h.written).toEqual([])
    expect(h.injected).toEqual([])
  })

  it('locked downgrade (T2): no error, default written, "applies to new sessions" announcement', async () => {
    const h = harness({ locked: true })
    const result = await h.run('vwa')
    expect(result.kind).toBe('success')
    expect(h.written).toEqual([{ ns: VWA_PRESET_NAMESPACE, patch: { selectedDefault: 'vwa' } }])
    expect(h.injected).toHaveLength(1)
    expect(h.injected[0]!.text).toBe(DEFAULT_ONLY_TEXT('vwa'))
    expect((result as { text: string }).text).toContain('keeps its current preset')
  })

  it('settings write failure after a hot switch (T3a): success with manual-fallback guidance, no default claim', async () => {
    const h = harness({ updateError: new Error('settings namespace "vwa-preset" is not registered') })
    const result = await h.run('vwa')
    expect(result.kind).toBe('success')
    expect((result as { text: string }).text).toContain('hot activation is NOT achieved')
    expect((result as { text: string }).text).toContain('settings namespace "vwa-preset" is not registered')
    expect(h.injected).toHaveLength(1)
    expect(h.injected[0]!.text).toContain('NOT achieved')
    expect(h.injected[0]!.text).not.toContain('new sessions will also start')
  })

  it('settings write failure with a locked session (T3b): error, nothing changed', async () => {
    const h = harness({ locked: true, updateError: new Error('read-only') })
    const result = await h.run('vwa')
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain('Nothing was changed')
    expect(h.injected).toEqual([])
  })

  it('no settings provider at all (T3a): hot switch only, manual-fallback guidance', async () => {
    const h = harness({ noSettings: true })
    const result = await h.run('vwa')
    expect(result.kind).toBe('success')
    expect((result as { text: string }).text).toContain('no settings provider is mounted')
    expect(h.injected[0]!.text).toContain('NOT achieved')
  })

  it('a non-locked select failure aborts before the settings write', async () => {
    const h = harness({ otherSelectError: Object.assign(new Error('composition failed'), { code: 'agent-preset/invalid' }) })
    const result = await h.run('vwa')
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain('agent-preset/invalid')
    expect(h.written).toEqual([])
    expect(h.injected).toEqual([])
  })
})
