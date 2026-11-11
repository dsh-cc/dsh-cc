/**
 * Contract tests for `copyForMutation`.
 *
 * The helper exists for one incident class (issue #373): a settings cascade
 * read-through returns deep-frozen sections, and schemastery re-admission
 * mutates its input in place (`z.dict` reassigns each entry). The copy must
 * decouple the containers a mutating pass writes into while preserving the
 * value's admission exactly — it is a copy, never a validator.
 *
 * @module @dsh-cc/settings/ns/tests/copy-for-mutation.spec
 */

import { describe, expect, it } from 'vitest'
import { copyForMutation } from '../src/ns/index.ts'

describe('copyForMutation', () => {
  it('copies plain objects and arrays into fresh mutable containers', () => {
    const input = { routes: { gauge: { 'max-output-tokens': 4096 } }, list: [1, [2, 3]] }
    const copy = copyForMutation(input)
    expect(copy).toEqual(input)
    expect(copy).not.toBe(input)
    expect(copy.routes).not.toBe(input.routes)
    expect(copy.list).not.toBe(input.list)
    expect(copy.list[1]).not.toBe(input.list[1])
    expect(Object.isFrozen(copy.routes)).toBe(false)
  })

  it('preserves own keys exactly: undefined-valued keys stay own and undefined', () => {
    const input: Record<string, unknown> = { a: 1, b: undefined }
    const copy = copyForMutation(input) as Record<string, unknown>
    expect(Object.hasOwn(copy, 'b')).toBe(true)
    expect(copy.b).toBeUndefined()
    expect(Object.keys(copy)).toEqual(['a', 'b'])
  })

  it('preserves insertion order of own keys', () => {
    const input = { z: 1, a: 2, m: 3 }
    expect(Object.keys(copyForMutation(input))).toEqual(['z', 'a', 'm'])
  })

  it('passes non-plain values through by reference (never rejects, never clones)', () => {
    const fn = (): number => 0
    const date = new Date(0)
    const input = { fn, date, nul: null as null, sym: Symbol.for('x') }
    const copy = copyForMutation(input)
    expect(copy.fn).toBe(fn)
    expect(copy.date).toBe(date)
    expect(copy.nul).toBeNull()
    expect(copy.sym).toBe(input.sym)
  })

  it('preserves own "__proto__" data keys', () => {
    const input = Object.create(null) as Record<string, unknown>
    input['__proto__'] = { inner: 1 }
    input.other = 2
    const copy = copyForMutation(input) as Record<string, unknown>
    expect(Object.hasOwn(copy, '__proto__')).toBe(true)
    expect((copy['__proto__'] as Record<string, unknown>).inner).toBe(1)
    expect(Object.getPrototypeOf(copy) === Object.prototype || Object.getPrototypeOf(copy) === null).toBe(true)
  })

  it('is cycle-safe', () => {
    const input: Record<string, unknown> = { name: 'root' }
    input.self = input
    const copy = copyForMutation(input) as Record<string, unknown>
    expect(copy.self).toBe(copy)
    expect(copy.name).toBe('root')
  })

  it('round-trips a deep-frozen section into a fully mutable copy', () => {
    const frozen = Object.freeze({
      routes: Object.freeze({ gauge: Object.freeze({ 'max-output-tokens': 4096 }) }),
    })
    const copy = copyForMutation(frozen)
    expect(copy).toEqual(frozen)
    expect(Object.isFrozen(copy)).toBe(false)
    expect(Object.isFrozen(copy.routes)).toBe(false)
    expect(Object.isFrozen(copy.routes.gauge)).toBe(false)
  })

  it('returns non-object scalars unchanged', () => {
    expect(copyForMutation(5)).toBe(5)
    expect(copyForMutation('x')).toBe('x')
    expect(copyForMutation(undefined)).toBeUndefined()
    expect(copyForMutation(null)).toBeNull()
  })
})
