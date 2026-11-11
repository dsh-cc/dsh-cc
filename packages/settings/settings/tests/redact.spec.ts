import { describe, expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { redactSecrets } from '../src/index.ts'

const secret = z.string().role('secret')

describe('redactSecrets', () => {
  it('removes a secret declared on a plain object field', () => {
    const schema = z.object({ name: z.string(), token: secret })
    const result = redactSecrets(schema as never, { name: 'x', token: 't' })
    expect(result.value).toEqual({ name: 'x' })
    expect(result.secrets).toEqual([{ path: ['token'], set: true }])
  })

  it('records an unset secret slot so a form can render a write-only input', () => {
    const schema = z.object({ token: secret })
    expect(redactSecrets(schema as never, {}).secrets).toEqual([{ path: ['token'], set: false }])
  })

  it('walks dict entries and array items with concrete keys and indexes', () => {
    const schema = z.object({
      hosts: z.dict(z.object({ key: secret })),
      list: z.array(z.object({ key: secret })),
    })
    const result = redactSecrets(schema as never, {
      hosts: { a: { key: 'k' } },
      list: [{ key: 'k0' }],
    })
    expect(result.value).toEqual({ hosts: { a: {} }, list: [{}] })
    expect(result.secrets).toEqual([
      { path: ['hosts', 'a', 'key'], set: true },
      { path: ['list', '0', 'key'], set: true },
    ])
  })

  // The three shapes the vendored walker used to return verbatim with nothing
  // recording that a secret had been missed.
  it('reaches a secret inside a union branch', () => {
    const schema = z.union([z.object({ token: secret }), z.object({ user: z.string() })])
    const result = redactSecrets(schema as never, { token: 'leaked' })
    expect(result.value).toEqual({})
    expect(result.secrets).toEqual([{ path: ['token'], set: true }])
  })

  it('reaches a secret through an intersect', () => {
    const schema = z.intersect([z.object({ name: z.string() }), z.object({ token: secret })])
    const result = redactSecrets(schema as never, { name: 'x', token: 'leaked' })
    expect(result.value).toEqual({ name: 'x' })
    expect(result.secrets).toEqual([{ path: ['token'], set: true }])
  })

  it('reaches a secret behind a transform', () => {
    const schema = z.transform(z.object({ token: secret }), (value: { token?: string }) => value)
    const result = redactSecrets(schema as never, { token: 'leaked' })
    expect(result.value).toEqual({})
    expect(result.secrets).toEqual([{ path: ['token'], set: true }])
  })

  it('records a path reachable through several branches exactly once', () => {
    // Both branches declare `token`; the removal record is a set of positions,
    // not a per-branch list, and `set` survives from whichever branch saw it.
    const schema = z.union([z.object({ token: secret }), z.object({ token: secret })])
    const result = redactSecrets(schema as never, { token: 'leaked' })
    expect(result.value).toEqual({})
    expect(result.secrets).toEqual([{ path: ['token'], set: true }])
  })

  it('never mutates the input', () => {
    const schema = z.object({ token: secret })
    const input = { token: 'leaked' }
    redactSecrets(schema as never, input)
    expect(input).toEqual({ token: 'leaked' })
  })
})
