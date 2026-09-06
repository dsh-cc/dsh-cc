/**
 * Unit tests for definition fingerprints (§4.4): stability across
 * comment/format-only markdown edits, sensitivity to any declared field
 * (tools, model, persona, maxTurns, effort), and plain-vs-named
 * discrimination.
 *
 * @module tests/fingerprint.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadAgentsDir } from '@dsh-cc/claude-code-agents'
import { definitionFingerprint, personaHash } from '../src/fingerprint.ts'
import type { AgentDefinition } from '@dsh-cc/claude-code-agents'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

function tempAgentsDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fingerprint-'))
  roots.push(root)
  return mkdirSync(join(root, '.claude', 'agents'), { recursive: true })
}

const BASE_MD = [
  '---',
  'name: researcher',
  'description: Finds things',
  'tools: Read, Grep',
  'model: sonnet',
  'maxTurns: 30',
  'effort: high',
  '---',
  '',
  'You are a researcher.',
  '',
].join('\n')

async function loadOne(dir: string): Promise<AgentDefinition> {
  const agents = await loadAgentsDir(dir, 'project')
  expect(agents).toHaveLength(1)
  return agents[0]
}

describe('definitionFingerprint', () => {
  it('is stable across comment/format-only markdown edits', async () => {
    const dir = tempAgentsDir()
    writeFileSync(join(dir, 'researcher.md'), BASE_MD)
    const before = definitionFingerprint(await loadOne(dir))
    const reformatted = BASE_MD.replace('tools: Read, Grep', 'tools: Read,Grep')
      .replace('description: Finds things', 'description:   Finds things')
    writeFileSync(join(dir, 'researcher.md'), `${reformatted}\n`)
    expect(definitionFingerprint(await loadOne(dir))).toBe(before)
  })

  const mutations: [string, string, string][] = [
    ['tools', 'tools: Read, Grep', 'tools: Read'],
    ['model', 'model: sonnet', 'model: opus'],
    ['maxTurns', 'maxTurns: 30', 'maxTurns: 50'],
    ['effort', 'effort: high', 'effort: low'],
  ]

  for (const [field, from, to] of mutations) {
    it(`changes when the ${field} frontmatter field changes`, async () => {
      const dir = tempAgentsDir()
      writeFileSync(join(dir, 'researcher.md'), BASE_MD)
      const before = definitionFingerprint(await loadOne(dir))
      writeFileSync(join(dir, 'researcher.md'), BASE_MD.replace(from, to))
      expect(definitionFingerprint(await loadOne(dir))).not.toBe(before)
    })
  }

  it('changes when the persona body changes', async () => {
    const dir = tempAgentsDir()
    writeFileSync(join(dir, 'researcher.md'), BASE_MD)
    const before = definitionFingerprint(await loadOne(dir))
    writeFileSync(join(dir, 'researcher.md'), BASE_MD.replace('You are a researcher.', 'You are a careful researcher.'))
    expect(definitionFingerprint(await loadOne(dir))).not.toBe(before)
  })

  it('tolerates absent optional fields', () => {
    const minimal = {
      agentType: 'plain',
      whenToUse: 'x',
      systemPrompt: 'y',
      source: 'project' as const,
      baseDir: '/d',
      filename: 'plain',
    }
    expect(definitionFingerprint(minimal)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('is insensitive to source-layer metadata differences', async () => {
    const dir = tempAgentsDir()
    writeFileSync(join(dir, 'researcher.md'), BASE_MD)
    const def = await loadOne(dir)
    expect(definitionFingerprint({ ...def, baseDir: '/elsewhere' })).toBe(definitionFingerprint(def))
  })
})

describe('personaHash', () => {
  it('hashes the persona string as prefixed sha256', () => {
    expect(personaHash('You are a researcher.')).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(personaHash('a')).not.toBe(personaHash('b'))
    expect(personaHash('x')).toBe(personaHash('x'))
  })
})
