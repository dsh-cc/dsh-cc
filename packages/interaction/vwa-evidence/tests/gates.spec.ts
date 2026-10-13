/**
 * Gate pins (§4.3): Gate A link semantics, Gate B fixed abstained, Gate C
 * frozen language table with an INJECTED executor, and aggregation
 * (timeout => abstained, skip => missing).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_GATE_TIMEOUT_MS, gateBStyle, headingSlug, runGates, type Executor } from '../src/gates.ts'

function passExec(): Executor {
  return async () => ({ code: 0, stdout: '', stderr: '' })
}

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vwa-gates-'))
}

describe('Gate A links', () => {
  it('passes when relative links, anchors and in-repo paths resolve', async () => {
    const root = await tempWorkspace()
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'a.md'), '# Alpha\n\n[beta](b.md)\n[jump](#alpha)\n![img](b.md)\n')
    await writeFile(join(root, 'docs', 'b.md'), '# Beta\n')
    const gates = await runGates(['docs/a.md'], root, passExec(), { skip: ['exec'] })
    expect(gates.find(g => g.gate === 'link')?.status).toBe('pass')
    await rm(root, { recursive: true, force: true })
  })

  it('fails on a broken relative link and a missing anchor', async () => {
    const root = await tempWorkspace()
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'a.md'), '# Alpha\n\n[ghost](ghost.md)\n[missing](#nowhere)\n')
    const gates = await runGates(['docs/a.md'], root, passExec(), { skip: ['exec'] })
    const link = gates.find(g => g.gate === 'link')
    expect(link?.status).toBe('fail')
    expect(link?.detail).toContain('ghost.md')
    expect(link?.detail).toContain('#nowhere')
    await rm(root, { recursive: true, force: true })
  })

  it('ignores external links entirely', async () => {
    const root = await tempWorkspace()
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'a.md'), '[x](https://example.com/a) [y](mailto:a@b.c) [z](//host/p)\n')
    const gates = await runGates(['docs/a.md'], root, passExec(), { skip: ['exec'] })
    expect(gates.find(g => g.gate === 'link')?.status).toBe('pass')
    await rm(root, { recursive: true, force: true })
  })

  it('heading slugs match GitHub style', () => {
    expect(headingSlug('Gate A: links & paths!')).toBe('gate-a-links--paths')
  })
})

describe('Gate B style (§4.3 fixed abstained)', () => {
  it('always abstains with the reserved-interface detail', async () => {
    const gates = await runGates([], '/tmp', passExec())
    const style = gates.find(g => g.gate === 'style')
    expect(style).toEqual(gateBStyle())
    expect(style?.status).toBe('abstained')
    expect(style?.detail).toContain('§4.3')
  })
})

describe('Gate C executability', () => {
  it('passes a valid bash snippet and fails a broken one via bash -n', async () => {
    const root = await tempWorkspace()
    await mkdir(join(root, 'docs'), { recursive: true })
    const exec: Executor = async (cmd, args) => {
      expect(cmd).toBe('bash')
      expect(args[0]).toBe('-n')
      const code = args[1] === 'echo ok' ? 0 : 1
      return { code, stdout: '', stderr: code === 0 ? '' : 'syntax error' }
    }
    await writeFile(join(root, 'docs', 'a.md'), '# A\n\n```bash\necho ok\n```\n\n```bash\nfi end\n```\n')
    const gates = await runGates(['docs/a.md'], root, exec, { skip: ['link'] })
    const execGate = gates.find(g => g.gate === 'exec')
    expect(execGate?.status).toBe('fail')
    expect(execGate?.detail).toContain('syntax error')
    await rm(root, { recursive: true, force: true })
  })

  it('checks ts snippets through the minimal tsc-class invocation', async () => {
    const root = await tempWorkspace()
    await mkdir(join(root, 'docs'), { recursive: true })
    const seen: string[][] = []
    const exec: Executor = async (cmd, args) => {
      expect(cmd).toBe('npx')
      expect(args[0]).toBe('tsc')
      expect(args).toContain('--noEmit')
      expect(args).toContain('--skipLibCheck')
      seen.push(args)
      return { code: 0, stdout: '', stderr: '' }
    }
    await writeFile(join(root, 'docs', 'a.md'), '```ts\nconst x: number = 1\n```\n')
    const gates = await runGates(['docs/a.md'], root, exec, { skip: ['link'] })
    expect(gates.find(g => g.gate === 'exec')?.status).toBe('pass')
    expect(seen[0]?.at(-1)).toContain('snippet.ts')
    await rm(root, { recursive: true, force: true })
  })

  it('abstains with detail for non-table languages (never silent)', async () => {
    const root = await tempWorkspace()
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'a.md'), '```python\nprint(1)\n```\n\n```\nplain\n```\n')
    const gates = await runGates(['docs/a.md'], root, passExec(), { skip: ['link'] })
    const execGate = gates.find(g => g.gate === 'exec')
    expect(execGate?.status).toBe('pass')
    expect(execGate?.detail).toContain('abstained languages: (none), python')
    await rm(root, { recursive: true, force: true })
  })
})

describe('aggregation (§4.3)', () => {
  it('timeout makes a gate abstained with detail, never silent', async () => {
    const root = await tempWorkspace()
    await mkdir(join(root, 'docs'), { recursive: true })
    const never: Executor = () => new Promise(() => undefined)
    await writeFile(join(root, 'docs', 'a.md'), '```bash\necho hi\n```\n')
    const gates = await runGates(['docs/a.md'], root, never, { skip: ['link'], timeoutMs: 50 })
    expect(gates.find(g => g.gate === 'exec')?.status).toBe('abstained')
    expect(gates.find(g => g.gate === 'exec')?.detail).toContain('timed out')
    await rm(root, { recursive: true, force: true })
  })

  it('skipped gates report missing with required detail', async () => {
    const gates = await runGates([], '/tmp', passExec(), { skip: ['link', 'exec'] })
    for (const gate of gates.filter(g => g.status === 'missing')) {
      expect(gate.detail).toBeDefined()
    }
  })

  it('default timeout is 30s', () => {
    expect(DEFAULT_GATE_TIMEOUT_MS).toBe(30_000)
  })
})
