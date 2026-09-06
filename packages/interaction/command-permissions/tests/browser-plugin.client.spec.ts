/**
 * command-permissions browser half on a real cordis Context with fake command
 * and sessions faces: the plugin hangs the /permissions popup decoration on
 * the host command; options list the five CC rule-engine modes with
 * bypassPermissions carrying the explicit risk gate; a pick submits the
 * /permissions line through Session.command and surfaces
 * rejection/unmatched/unmaterialized as thrown errors; fiber disposal removes
 * the decoration (HMR safety).
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { CommandDecoration } from '@deepseek-ai/dsh-client-ui-commands/client'
import {
  apply, inject,
} from '../src/client/index.ts'
import { PERMISSION_MODE_OPTIONS } from '../src/modes.ts'

type SessionIdLike = string & { readonly __sessionId: unique symbol }

const sid = (k: string): SessionIdLike => k as SessionIdLike

async function bench(): Promise<{
  ctx: Context
  fiber: Awaited<ReturnType<Context['plugin']>>
  commands: string[]
  setResult: (r: { ok: boolean; matched?: boolean }) => void
  decoration: () => CommandDecoration | undefined
}> {
  const ctx = new Context()
  let decoration: CommandDecoration | undefined
  ctx.provide('commandUi', {
    decorate(c: CommandDecoration) {
      decoration = c
      return () => { decoration = undefined }
    },
  } as never)
  const commands: string[] = []
  let commandResult: { ok: boolean; matched?: boolean } = { ok: true, matched: true }
  const materialized = new Set<SessionIdLike>([sid('s1')])
  const sessionFace = {
    command: (line: string) => {
      commands.push(line)
      return Promise.resolve(commandResult.ok
        ? { ok: true as const, value: { matched: commandResult.matched ?? true } }
        : { ok: false as const, error: { code: 'internal', message: 'boom' } })
    },
  }
  ctx.provide('sessions', {
    binding: (id: SessionIdLike) =>
      (materialized.has(id) ? { sessionId: id, session: sessionFace } : undefined),
  } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return {
    ctx, fiber, commands,
    setResult: (r: { ok: boolean; matched?: boolean }) => { commandResult = r },
    decoration: () => decoration,
  }
}

describe('@dsh-cc/command-permissions browser plugin', () => {
  it('hangs the /permissions popup decoration on the host command', async () => {
    const b = await bench()
    const c = b.decoration()!
    expect(c.name).toBe('permissions')
    expect(c.ui.kind).toBe('popupSelect')
    expect(c.available()).toBe(true)
  })

  it('lists the five rule-engine modes; bypassPermissions carries the risk gate', async () => {
    const b = await bench()
    const c = b.decoration()!
    const options = await c.ui.options({ sessionId: sid('s1') }, new AbortController().signal)
    expect(options.map(option => option.id)).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'])
    options.forEach((option, index) => {
      expect(option.label).toBe(PERMISSION_MODE_OPTIONS[index]!.label)
      expect(option.detail).toBe(PERMISSION_MODE_OPTIONS[index]!.detail)
    })
    const bypass = options.find(option => option.id === 'bypassPermissions')
    expect(bypass?.confirmation?.title).toContain('Bypass')
    expect(bypass?.confirmation?.confirmLabel).toBe('Enable Bypass permissions')
    const plain = options.find(option => option.id === 'acceptEdits')
    expect(plain?.confirmation).toBeUndefined()
  })

  it('a pick submits the /permissions line; rejection, unmatched and unmaterialized throw', async () => {
    const b = await bench()
    const c = b.decoration()!
    const proj = { sessionId: sid('s1') }
    await c.ui.onSelect({ id: 'acceptEdits', label: 'acceptEdits' }, proj)
    expect(b.commands).toEqual(['/permissions acceptEdits'])
    b.setResult({ ok: false })
    await expect(c.ui.onSelect({ id: 'plan', label: 'plan' }, proj)).rejects.toThrow(/permission mode switch failed/)
    b.setResult({ ok: true, matched: false })
    await expect(c.ui.onSelect({ id: 'plan', label: 'plan' }, proj)).rejects.toThrow(/no \/permissions command/)
    // An unmaterialized session throws before any submit.
    await expect(c.ui.onSelect({ id: 'plan', label: 'plan' }, { sessionId: sid('ghost') }))
      .rejects.toThrow(/not materialized/)
  })

  it('disposal removes the decoration (HMR safety)', async () => {
    const b = await bench()
    expect(b.decoration()).toBeDefined()
    await b.fiber.dispose()
    expect(b.decoration()).toBeUndefined()
  })
})
