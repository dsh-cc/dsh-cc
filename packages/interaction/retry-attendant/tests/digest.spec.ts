import { describe, expect, it } from 'vitest'
import { digestKey, effectFields, stableJson } from '../src/digest.ts'

const BASH = { command: 'pnpm build', workdir: '/repo' }

describe('digestKey', () => {
  it('reworded description / different timeoutMs / different justification → SAME digest', () => {
    const a = digestKey('bash', { ...BASH, description: 'build the project' })
    const b = digestKey('bash', { ...BASH, description: 'compile everything', timeoutMs: 9999, justification: 'ci', sandbox_permissions: 'workspace-write' })
    expect(a).toBe(b)
  })

  it('different command → different digest', () => {
    expect(digestKey('bash', { ...BASH })).not.toBe(digestKey('bash', { command: 'pnpm test', workdir: '/repo' }))
  })

  it('different workdir → different digest', () => {
    expect(digestKey('bash', { ...BASH })).not.toBe(digestKey('bash', { command: 'pnpm build', workdir: '/other' }))
  })

  it('write projection: file_path + content only', () => {
    const a = digestKey('write', { file_path: '/a.ts', content: 'x' })
    expect(a).toBe(digestKey('write', { content: 'x', file_path: '/a.ts', description: 'ignored' }))
    expect(a).not.toBe(digestKey('write', { file_path: '/a.ts', content: 'y' }))
  })

  it('edit projection: file_path + old_string + new_string', () => {
    const args = { file_path: '/a.ts', old_string: 'a', new_string: 'b' }
    expect(digestKey('edit', args)).toBe(digestKey('edit', { ...args, description: 'x' }))
    expect(effectFields('edit', args)).toEqual(args)
  })

  it('unknown tool → all arguments projected', () => {
    expect(effectFields('mcp__x__go', { b: 1, a: 2, c: { z: 1, y: 2 } })).toEqual({ b: 1, a: 2, c: { z: 1, y: 2 } })
    expect(digestKey('mcp__x__go', { a: 1 })).not.toBe(digestKey('mcp__x__go', { a: 2 }))
  })

  it('key order is canonicalized (stableJson)', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}')
  })

  it('non-object args do not throw', () => {
    expect(digestKey('bash', null)).toBe(digestKey('bash', null))
  })
})
