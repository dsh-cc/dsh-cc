import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@dsh-cc/tools'
import { apply, HANDOFF_GET_TOOL, HANDOFF_PUT_TOOL, THRESHOLD_NOTE } from '../src/index.ts'
import { applyMaxChars, HandoffToolError, cwdProjectKey } from '../src/tools.ts'
import { projectKeyOf } from '../src/store.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10 }) })

interface Registered {
  execute(args: any, exec: any): Promise<any>
}

/** Mount the plugin on a minimal context with a tools service, an fs seam, and a temp dshHomePath. */
function setup(): { put: Registered; get: Registered; home: string } {
  const ctx = new Context()
  const home = mkdtempSync(join(tmpdir(), 'handoff-home-'))
  dirs.push(home)
  ctx.provide('fs', {} as never)
  const registered: Registered[] = []
  ctx.provide('tools', { register(def: unknown) { registered.push(def as Registered); return () => {} } } as never)
  ;(ctx as any).dshHomePath = (...segments: string[]) => [home, ...segments].join('/')
  apply(ctx)
  expect(registered.map((r) => (r as any).name)).toEqual([HANDOFF_PUT_TOOL, HANDOFF_GET_TOOL])
  const [put, get] = registered
  return { put, get, home }
}

const exec = {
  agent: {
    name: 'critic',
    session: { id: 's1', snapshotEvents: () => [], header: { cwd: '/w' } },
  },
} as never
// getSessionCwd reads the agent's cwd; the testkit agent shape is opaque here, so
// cwdProjectKey is exercised directly for keying assertions.
const PK = projectKeyOf('/w')

describe('handoff tools', () => {
  it('put returns a summary embedding handoff://<id> and get round-trips', async () => {
    const { put, get } = setup()
    const res = await put.execute({ content: 'x'.repeat(50), label: 'review' }, exec)
    expect(res.message).toContain('handoff://')
    expect(res.message).toContain('50 chars')
    const id = (res.message.match(/handoff:\/\/([0-9a-f]{20})/) as RegExpMatchArray)[1]
    const got = await get.execute({ id }, exec)
    expect(got.text).toBe('x'.repeat(50))
    expect(cwdProjectKey((exec as any).agent)).toBe(PK)
  })

  it('maxChars head-truncates with a trailing note; full text stays intact', async () => {
    const { put, get } = setup()
    const res = await put.execute({ content: 'abcdef' }, exec)
    const id = (res.message.match(/handoff:\/\/([0-9a-f]{20})/) as RegExpMatchArray)[1]
    expect(await get.execute({ id, maxChars: 3 }, exec)).toEqual({
      text: 'abc\n\n[dsh-cc handoff truncated at 3 of 6 chars; full text: use handoff_get]',
    })
    expect((await get.execute({ id }, exec)).text).toBe('abcdef')
  })

  it('typed errors on unknown id and out-of-project fetch; put rejects empty content', async () => {
    const { put, get } = setup()
    await expect(get.execute({ id: '0'.repeat(20) }, exec)).rejects.toThrow('unknown_id')
    await expect(get.execute({ id: '../escape' }, exec)).rejects.toThrow()
    await expect(get.execute({ id: 'zzz' }, exec)).rejects.toBeInstanceOf(HandoffToolError)
    await expect(put.execute({ content: '' }, exec)).rejects.toThrow()
  })

  it('maxChars edge cases pass through', () => {
    expect(applyMaxChars('abc', undefined)).toBe('abc')
    expect(applyMaxChars('abc', 0)).toBe('abc')
    expect(applyMaxChars('abc', 5)).toBe('abc')
    expect(applyMaxChars('abc', 2)).toBe('ab\n\n[dsh-cc handoff truncated at 2 of 3 chars; full text: use handoff_get]')
  })

  it('no-op without tools/fs/home seams', () => {
    expect(apply(new Context())).toBeUndefined()
    const ctx = new Context()
    ctx.provide('fs', {} as never)
    expect(apply(ctx)).toBeUndefined()
  })

  it('the tool description carries the advisory-threshold contract', () => {
    const { put } = setup()
    expect(String((put as any).description)).toContain(THRESHOLD_NOTE)
  })
})
