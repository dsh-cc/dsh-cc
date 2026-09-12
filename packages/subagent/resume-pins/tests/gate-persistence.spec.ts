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
    // `complete: false` skips the step-5 availability preflight; this spec is
    // about step 0 (session existence), not model routing.
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

async function mount(pin: ResumePin, persistence: Record<string, unknown>): Promise<PreExecute> {
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
    exec: { name: 'send_message', token: 't1', arguments: { agent_id: childId }, agent: undefined },
    next: async () => ({ kind: 'accept' as const, content: [{ type: 'text' as const, text: 'delivered' }] }),
  }
}

describe('resume gate — session existence via the 0.1.5 persistence face (stat)', () => {
  it('stat returning a snapshot ⇒ the session EXISTS ⇒ gate passes and delivery proceeds (RED: current code sees it as orphaned)', async () => {
    const workspace = makeWorkspace()
    const preExecute = await mount(makePin('child-1', workspace), stubPersistenceFace({ sessionId: 'child-1' }))
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
})
