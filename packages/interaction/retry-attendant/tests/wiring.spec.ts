/**
 * M1 guidance wiring tests (design doc §5.2): the `tools/post-execute`
 * boundary with a fake ctx — promoted results, marker failures, dedup per
 * fresh digest, downstream preservation, source kind, and the swallow rule.
 */

import { describe, expect, it } from 'vitest'
import type { ToolExecution } from '@dsh-cc/tools'
import { failureResult, bashExec, contextsOf, enable, promotedResult, rig, successResult, tempHome } from './rig.ts'

const nextAccept = (extra: unknown[] = []) => async (): Promise<unknown> =>
  ({ kind: 'accept', additionalContexts: extra }) as unknown

describe('M1 guidance (tools/post-execute)', () => {
  it('bash promoted result ⇒ guidance present despite isError:false', async () => {
    const home = tempHome()
    enable(home)
    const { post } = rig({ home })
    const decision = await post(bashExec('pnpm build'), promotedResult(), async () => ({ kind: 'accept' }))
    const contexts = contextsOf(decision)
    expect(contexts).toHaveLength(1)
    expect(contexts[0]!.source?.kind).toBe('retry-attendant')
    expect(contexts[0]!.content).toEqual([{ type: 'text', text: expect.stringContaining('[retry-attendant] The command may have partially applied') }])
  })

  it('persistent-bash timeout marker on the FAILURE branch ⇒ additionalContexts (string-valued error)', async () => {
    const home = tempHome()
    enable(home)
    const { post } = rig({ home })
    const decision = await post(bashExec('pnpm build'), failureResult('[Command timed out or OOM]'), async () => ({ kind: 'accept' }))
    expect(contextsOf(decision)).toHaveLength(1)
  })

  it('clean success ⇒ no guidance', async () => {
    const home = tempHome()
    enable(home)
    const { post } = rig({ home })
    const decision = await post(bashExec('pnpm build'), successResult(), async () => ({ kind: 'accept' }))
    expect(contextsOf(decision)).toHaveLength(0)
  })

  it('disabled (flag off) ⇒ passthrough', async () => {
    const home = tempHome()
    enable(home, { enabled: false })
    const { post } = rig({ home })
    const decision = await post(bashExec('pnpm build'), promotedResult(), async () => ({ kind: 'accept' }))
    expect(contextsOf(decision)).toHaveLength(0)
  })

  it('same-digest second ambiguous outcome ⇒ guidance deduped (fresh-digest rule)', async () => {
    const home = tempHome()
    enable(home)
    const { post } = rig({ home })
    const next = async (): Promise<unknown> => ({ kind: 'accept' })
    await post(bashExec('pnpm build'), promotedResult(), next)
    const second = await post(bashExec('pnpm build'), promotedResult(), next)
    expect(contextsOf(second)).toHaveLength(0)
  })

  it('reworded description is a different digest? NO — guidance deduped across it (effect-field digest)', async () => {
    const home = tempHome()
    enable(home)
    const { post } = rig({ home })
    const next = async (): Promise<unknown> => ({ kind: 'accept' })
    await post(bashExec('pnpm build'), promotedResult(), next)
    const reworded = bashExec('pnpm build', { description: 'build the thing again', timeoutMs: 99 })
    const second = await post(reworded, promotedResult(), next)
    expect(contextsOf(second)).toHaveLength(0)
  })

  it('downstream additionalContexts from other listeners are preserved', async () => {
    const home = tempHome()
    enable(home)
    const { post } = rig({ home })
    const other = { role: 'user', content: [{ type: 'text', text: 'other' }] }
    const decision = await post(bashExec('pnpm build'), promotedResult(), async () => ({ kind: 'accept', additionalContexts: [other] }))
    const contexts = contextsOf(decision)
    expect(contexts).toHaveLength(2)
    expect(contexts[0]!.source?.kind).toBeUndefined()
    expect(contexts[1]!.source?.kind).toBe('retry-attendant')
  })

  it('session event appended on fresh outcome-with-guidance, with digest + class', async () => {
    const home = tempHome()
    enable(home)
    const agent = { session: { header: { id: 's1' }, append: (event: string) => events.push(event) }, inject: (): void => {} }
    const events: string[] = []
    const { post } = rig({ home })
    const exec = bashExec('pnpm build', { agent })
    await post(exec, promotedResult(), async () => ({ kind: 'accept' }))
    expect(events).toEqual(['retry-attendant/event'])
  })

  it('agent-less execution still gets M1 guidance (no state keying needed)', async () => {
    const home = tempHome()
    enable(home)
    const { post } = rig({ home })
    const exec = { name: 'bash', arguments: { command: 'pnpm build' } } as unknown as ToolExecution
    const decision = await post(exec, promotedResult(), async () => ({ kind: 'accept' }))
    expect(contextsOf(decision)).toHaveLength(1)
  })

  it('forced internal throw ⇒ passthrough + debug log (swallow rule)', async () => {
    const home = tempHome()
    enable(home)
    const { post, ctx } = rig({ home, stateFor: (): never => { throw new Error('boom') } })
    const downstream = { kind: 'accept', content: [{ type: 'text', text: 'result' }] }
    const decision = await post(bashExec('pnpm build'), promotedResult(), async () => downstream)
    expect(decision).toBe(downstream)
    expect(ctx.logger.debug).toHaveBeenCalledWith(expect.stringContaining('retry-attendant: post-execute degraded to passthrough'))
  })
})
