/**
 * Focused delegation-discipline tests for the plugin's `tools/post-execute`
 * handler: the send_message advisory fires only in the DELEGATOR direction
 * (child→parent result reports are never annotated), and list_agents
 * annotations for pinned children carry the delegation-discipline line.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/plugin.ts'
import { PinStore } from '../src/store.ts'
import type { ResumePin } from '../src/pin.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

type PostExecute = (exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>

function makePin(childId: string): ResumePin {
  return {
    version: 1,
    childId,
    parentSessionId: 'parent',
    label: 'research',
    mode: 'continuable-background',
    createdAt: '2026-09-04T00:00:00.000Z',
    definition: { kind: 'plain' },
    modelSelector: { raw: 'inherit', via: 'inherit' },
    effective: { provider: 'mock', model: 'mock', reasoningEffort: null, maxTokens: null, complete: true },
    toolFilter: { allow: [], deny: [] },
    workspace: { cwd: '/ws', gitDir: '.git', gitCommonDir: '.git', branch: 'main' },
    resume: { state: 'ok' },
  }
}

/** Mount the plugin and capture its post-execute listener directly. */
async function mount(
  store?: PinStore,
  configure?: (ctx: Context) => void,
): Promise<{ postExecute: PostExecute; pinsRoot: string }> {
  const pinsRoot = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-dd-'))
  const ctx = new Context()
  const captured: Record<string, unknown[]> = {}
  const origOn = (ctx as { on: (event: string, listener: unknown) => unknown }).on.bind(ctx)
  ;(ctx as { on: (event: string, listener: unknown) => unknown }).on = (event: string, listener: unknown) => {
    ;(captured[event] ??= []).push(listener)
    return origOn(event, listener)
  }
  apply(ctx, store === undefined ? { pinsRoot } : { pinsRoot, store })
  // Post-mount shaping: the listener resolves its services at CALL time, so a
  // realm-guard rig is installed after apply() registers the handlers.
  configure?.(ctx)
  const postExecute = (captured['tools/post-execute'] as PostExecute[]).at(-1)!
  expect(typeof postExecute).toBe('function')
  return { postExecute, pinsRoot }
}

/** The production failure shape: the property read throws, the method form works. */
function realmGuarded(service: unknown) {
  return (ctx: Context): void => {
    const origGet = (ctx as unknown as { get: (name: string) => unknown }).get.bind(ctx)
    ;(ctx as unknown as Record<string, unknown>).get = (name: string) => name === 'subagents' ? service : origGet(name)
    Object.defineProperty(ctx, 'subagents', {
      configurable: true,
      get() { throw new Error('cannot get property "subagents" without inject') },
    })
  }
}

/** No resolver reachable: the property throws and the method form yields nothing. */
function unreachableResolver() {
  return (ctx: Context): void => {
    ;(ctx as unknown as Record<string, unknown>).get = () => undefined
    Object.defineProperty(ctx, 'subagents', {
      configurable: true,
      get() { throw new Error('cannot get property "subagents" without inject') },
    })
  }
}

function textBlocks(content: readonly ContentBlock[] | undefined): string[] {
  return (content ?? []).flatMap(block => block.type === 'text' ? [block.text] : [])
}

describe('delegation discipline — send_message advisory', () => {
  it('appends the advisory as the LAST content block in the delegator direction', async () => {
    const { postExecute } = await mount()
    const out = await postExecute(
      { name: 'send_message', token: 't1', arguments: { agent: 'child-1' }, agent: undefined },
      { content: [] },
      async () => ({ kind: 'accept', content: [{ type: 'text', text: 'sent' }] }),
    )
    const blocks = (out as { content: ContentBlock[] }).content
    expect(blocks.at(-1)!.type).toBe('text')
    expect((blocks.at(-1) as { text: string }).text).toContain('Delegation discipline')
    expect((blocks.at(-1) as { text: string }).text).toContain('subagent_fork')
    expect(blocks[0]).toEqual({ type: 'text', text: 'sent' })
  })

  it('does NOT annotate a child→parent result report (matching parentSession)', async () => {
    const { postExecute } = await mount()
    const out = await postExecute(
      {
        name: 'send_message',
        token: 't2',
        arguments: { agent: 'child-1' },
        agent: { id: 'agent-x', session: { header: { parentSession: 'child-1' } } },
      },
      { content: [] },
      async () => ({ kind: 'accept', content: [{ type: 'text', text: 'my result' }] }),
    )
    expect(JSON.stringify(out)).not.toContain('Delegation discipline')
    expect((out as { content: ContentBlock[] }).content).toEqual([{ type: 'text', text: 'my result' }])
  })
})

describe('delegation discipline — list_agents annotation', () => {
  it('carries the delegation-discipline line for a pinned child', async () => {
    const pinsRoot = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-dd-la-'))
    const store = new PinStore(pinsRoot)
    store.write(makePin('child-1'))
    const { postExecute } = await mount(store)
    const out = await postExecute(
      { name: 'list_agents', token: 't3', arguments: {}, agent: undefined },
      { content: [{ type: 'text', text: 'agents: child-1 (ready)' }] },
      async () => ({ kind: 'accept', content: [{ type: 'text', text: 'agents: child-1 (ready)' }] }),
    )
    const text = textBlocks((out as { content: ContentBlock[] }).content).join('\n')
    expect(text).toContain('[resume-pin] child-1')
    expect(text).toContain('Delegation discipline: an idle/ready child')
    expect(text).toContain('subagent_fork')
  })
})

describe('fail-soft service reads — the realm guard cannot replace a tool result', () => {
  /** Rows render the slash path only: the durable id never appears in the text. */
  const NAME_RENDERED_ROW = 'lead/researcher [running]'

  function storeWithPin(childId: string): PinStore {
    const store = new PinStore(mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-dd-pin-')))
    store.write(makePin(childId))
    return store
  }

  it('rescues the pin annotation through ctx.get when the property read is realm-guarded', async () => {
    const childId = 'child-77'
    const service = {
      rootOf: () => ({ id: 'root' }),
      listDescendants: async () => [{ id: childId, path: 'lead/researcher' }],
    }
    const { postExecute } = await mount(storeWithPin(childId), realmGuarded(service))
    const out = await postExecute(
      { name: 'list_agents', token: 't-recover', arguments: {}, agent: { id: 'parent' } },
      { content: [{ type: 'text', text: NAME_RENDERED_ROW }] },
      async () => ({ kind: 'accept', content: [{ type: 'text', text: NAME_RENDERED_ROW }] }),
    )
    const text = textBlocks((out as { content: ContentBlock[] }).content).join('\n')
    // Only the id→path mapping can find this child: the durable id is absent
    // from the rows, so the id-only degradation path cannot produce the pin.
    expect(text).toContain(`[resume-pin] ${childId}`)
  })

  it('degrades to id-only matching without throwing when no resolver is reachable', async () => {
    const childId = 'child-77'
    const { postExecute } = await mount(storeWithPin(childId), unreachableResolver())
    const out = await postExecute(
      { name: 'list_agents', token: 't-degrade', arguments: {}, agent: { id: 'parent' } },
      { content: [{ type: 'text', text: NAME_RENDERED_ROW }] },
      async () => ({ kind: 'accept', content: [{ type: 'text', text: NAME_RENDERED_ROW }] }),
    )
    const text = textBlocks((out as { content: ContentBlock[] }).content).join('\n')
    expect(text).not.toContain('[resume-pin]')
    expect(text).toContain(NAME_RENDERED_ROW)
  })

  it('completes the send_message advisory path under the realm guard', async () => {
    const { postExecute } = await mount(undefined, unreachableResolver())
    const out = await postExecute(
      { name: 'send_message', token: 't-advisory', arguments: { agent: 'child-1' }, agent: undefined },
      { content: [] },
      async () => ({ kind: 'accept', content: [{ type: 'text', text: 'sent' }] }),
    )
    const text = textBlocks((out as { content: ContentBlock[] }).content).join('\n')
    expect(text).toContain('Delegation discipline')
  })
})
