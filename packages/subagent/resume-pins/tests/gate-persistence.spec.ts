/**
 * RED spec (plan §5.3): the plugin's `gateEnv` must probe child-session
 * existence through the 0.1.5 session-persistence service face
 * (`stat(id) → snapshot | undefined`), mounted as a REAL cordis service on a
 * real `Context` — `evaluateGate` is never fed directly, the gate entry
 * (`tools/pre-execute` on `send_message`) drives the whole path.
 *
 * The stub face is 0.1.5-shaped: it has NO `readStoredRevision` key at all,
 * so the current optional-chained probe can never see the session.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/plugin.ts'
import { PinStore } from '../src/store.ts'
import type { ResumePin } from '../src/pin.ts'

type PreExecute = (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>

function makePin(childId: string, workspaceCwd: string): ResumePin {
  return {
    version: 1,
    childId,
    parentSessionId: 'parent',
    label: 'research',
    mode: 'continuable-background',
    createdAt: '2026-09-04T00:00:00.000Z',
    definition: { kind: 'plain' },
    modelSelector: { raw: 'inherit', via: 'inherit' },
    // `complete: false` makes this a DEGRADED pin: the gate still runs the
    // step-5 availability preflight (`resolvePinned`) for it, just without
    // tuple-drift enforcement — so a minimal llm service stub whose
    // `resolveCallConfig` echoes the pinned route is required for a pass.
    // This spec is about step 0 (session existence), not model routing.
    effective: { provider: 'mock', model: 'mock', reasoningEffort: null, maxTokens: null, complete: false },
    toolFilter: { allow: [], deny: [] },
    // A bare temp dir has no git repo → the probe returns the 'unknown'
    // sentinels; pinning the sentinels keeps step 2 drift-free.
    workspace: { cwd: workspaceCwd, gitDir: 'unknown', gitCommonDir: 'unknown', branch: 'unknown' },
    resume: { state: 'ok' },
  }
}

/** 0.1.5 session-persistence face: stat is the ONLY existence probe. */
function stubPersistenceFace(snapshot: { sessionId: string } | undefined) {
  return {
    stat: async (id: string) => (snapshot === undefined ? undefined : { ...snapshot, sessionId: id }),
    create: async () => { throw new Error('stub face: create must not be called') },
    open: async () => { throw new Error('stub face: open must not be called') },
    flush: async () => { throw new Error('stub face: flush must not be called') },
    list: async () => { throw new Error('stub face: list must not be called') },
  } as Record<string, unknown>
}

// rc.5 name seam, faked down to the documented fallback: a bare token that
// matches no catalog name resolves to Session-id semantics, and a slash path
// that names no tree member throws (harness resolveName).
const bareIdResolution = {
  resolveName: async (_caller: unknown, agent: string) => {
    if (agent.includes('/')) throw new Error(`agent name ${JSON.stringify(agent)} was not found (AGENT_NAME_NOT_FOUND)`)
    return agent
  },
}

async function mount(
  pin: ResumePin,
  persistence: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  configure?: (ctx: Context) => void,
): Promise<PreExecute> {
  const pinsRoot = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-gate-persist-'))
  const store = new PinStore(pinsRoot)
  store.write(pin)
  const ctx = new Context()
  const captured: Record<string, unknown[]> = {}
  const origOn = (ctx as { on: (event: string, listener: unknown) => unknown }).on.bind(ctx)
  ;(ctx as { on: (event: string, listener: unknown) => unknown }).on = (event: string, listener: unknown) => {
    ;(captured[event] ??= []).push(listener)
    return origOn(event, listener)
  }
  apply(ctx, { pinsRoot, store })
  // Mount the persistence face as a real cordis Context member (the plugin
  // reads it lazily off `ctx` at gate time), and a no-agents registry so the
  // "same-epoch live Activation" check passes through.
  ;(ctx as unknown as Record<string, unknown>).sessionPersistence = persistence
  ;(ctx as unknown as Record<string, unknown>).agents = { get: () => undefined }
  Object.entries(extra).forEach(([key, value]) => {
    // `llm` must be a real cordis service (the plugin reads it via `ctx.get('llm')`);
    // plain members like `sessionPersistence` are read directly off `ctx`.
    if (key === 'llm') (ctx as unknown as { provide: (key: string, value: unknown) => void }).provide('llm', value)
    else (ctx as unknown as Record<string, unknown>)[key] = value
  })
  // Unless overridden, these id-addressed sends resolve through the bare-id
  // name-fallback seam (`{ subagents: undefined }` models a composition with
  // no resolver at all — the documented pass-through).
  if (!('subagents' in extra)) {
    (ctx as unknown as Record<string, unknown>).subagents = bareIdResolution
  }
  // Post-mount shaping for realm-guard rigs: the gate resolves its services at
  // CALL time, so accessors installed here govern the listener's reads.
  configure?.(ctx)
  const preExecute = (captured['tools/pre-execute'] as PreExecute[]).at(-1)!
  expect(typeof preExecute).toBe('function')
  return preExecute
}

const workspaces: string[] = []
afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-ws-'))
  workspaces.push(dir)
  return dir
}

function sendTo(childId: string) {
  return {
    exec: { name: 'send_message', token: 't1', arguments: { agent: childId }, agent: { id: 'parent' } },
    next: async () => ({ kind: 'accept' as const, content: [{ type: 'text' as const, text: 'delivered' }] }),
  }
}

describe('resume gate — session existence via the 0.1.5 persistence face (stat)', () => {
  it('stat returning a snapshot ⇒ the session EXISTS ⇒ gate passes and delivery proceeds (RED: current code sees it as orphaned)', async () => {
    const workspace = makeWorkspace()
    const preExecute = await mount(makePin('child-1', workspace), stubPersistenceFace({ sessionId: 'child-1' }), {
      llm: { resolveCallConfig: async config => ({ provider: config.provider, model: config.model }) },
    })
    const { exec, next } = sendTo('child-1')
    const out = await preExecute(exec, next)
    // A pass never denies; the delivery is admitted untouched.
    expect(out).toEqual({ kind: 'accept', content: [{ type: 'text', text: 'delivered' }] })
  })

  it('stat returning undefined ⇒ the session does NOT exist ⇒ PIN_ORPHANED deny (control)', async () => {
    const workspace = makeWorkspace()
    const preExecute = await mount(makePin('child-2', workspace), stubPersistenceFace(undefined))
    const { exec, next } = sendTo('child-2')
    const out = await preExecute(exec, next)
    expect(out).toMatchObject({ kind: 'deny' })
    expect((out as { reason: string }).reason).toContain('PIN_ORPHANED')
  })

  it('stat throwing ⇒ treated as not-exists ⇒ PIN_ORPHANED deny (defensive carry-over, control)', async () => {
    const workspace = makeWorkspace()
    const face = stubPersistenceFace({ sessionId: 'child-3' })
    face.stat = async () => { throw new Error('stat exploded') }
    const preExecute = await mount(makePin('child-3', workspace), face)
    const { exec, next } = sendTo('child-3')
    const out = await preExecute(exec, next)
    expect(out).toMatchObject({ kind: 'deny' })
    expect((out as { reason: string }).reason).toContain('PIN_ORPHANED')
  })

  // §3.3: with no name resolver in the composition the gate cannot attribute
  // the target to a pin, so it must pass the send through rather than deny —
  // a gate never blocks a message it cannot attribute to a pinned child.
  it('no resolver in the composition ⇒ the gate passes a pinned child through instead of orphaning it', async () => {
    const workspace = makeWorkspace()
    const preExecute = await mount(makePin('child-9', workspace), stubPersistenceFace(undefined), { subagents: undefined })
    const { exec, next } = sendTo('child-9')
    const out = await preExecute(exec, next)
    expect(out).toEqual({ kind: 'accept', content: [{ type: 'text', text: 'delivered' }] })
  })
})

/**
 * The same-epoch liveness read (`ctx.agents.get(...)`, plugin.ts:332) sits on
 * the SAME realm-guarded seam as `subagentsOf`. Once the name resolution is
 * fail-soft, a pinned `send_message` actually reaches this line — so an
 * unguarded property read here would swap one inject error for another on the
 * exact tool path being repaired. Unreadable liveness ⇒ pass through.
 */
describe('resume gate — realm-guarded agents registry', () => {
  function guardAgents(registry: unknown) {
    return (ctx: Context): void => {
      const origGet = (ctx as unknown as { get: (name: string) => unknown }).get.bind(ctx)
      ;(ctx as unknown as Record<string, unknown>).get = (name: string) =>
        name === 'agents' ? registry : origGet(name)
      Object.defineProperty(ctx, 'agents', {
        configurable: true,
        get() { throw new Error('cannot get property "agents" without inject') },
      })
    }
  }

  async function mountGuarded(
    pin: ResumePin,
    registry: unknown,
    configure: (ctx: Context) => void,
  ): Promise<PreExecute> {
    return mount(pin, stubPersistenceFace({ sessionId: pin.childId }), {
      llm: { resolveCallConfig: async (config: { provider: string; model: string }) => ({ provider: config.provider, model: config.model }) },
    }, configure)
  }

  it('passes through when the registry is reachable but its membership call throws', async () => {
    const workspace = makeWorkspace()
    const preExecute = await mountGuarded(
      makePin('child-live', workspace),
      { get() { throw new Error('hostile registry') } },
      guardAgents({ get() { throw new Error('hostile registry') } }),
    )
    const { exec, next } = sendTo('child-live')
    const out = await preExecute(exec, next)
    expect(out).toEqual({ kind: 'accept', content: [{ type: 'text', text: 'delivered' }] })
  })

  it('passes through when no registry form resolves at all', async () => {
    const workspace = makeWorkspace()
    const preExecute = await mountGuarded(makePin('child-noreg', workspace), undefined, guardAgents(undefined))
    const { exec, next } = sendTo('child-noreg')
    const out = await preExecute(exec, next)
    expect(out).toEqual({ kind: 'accept', content: [{ type: 'text', text: 'delivered' }] })
  })
})
