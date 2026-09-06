import { describe, expect, it } from 'vitest'
import {
  formatModelCatalog,
  parseModelChoice,
  type CatalogEntry,
} from '@dsh-cc/tui/model-catalog.ts'

const CATALOG: readonly CatalogEntry[] = [
  { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
]

describe('formatModelCatalog', () => {
  it('lists provider/id pairs and marks the current route', () => {
    const text = formatModelCatalog(CATALOG, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    expect(text).toContain('* 1. deepseek-official/deepseek-v4-flash — DeepSeek V4 Flash')
    expect(text).toContain('  2. deepseek-official/deepseek-v4-pro — DeepSeek V4 Pro')
    expect(text).toContain('  3. openai/gpt-5 — GPT-5')
  })

  it('renders an empty catalog as a seam message', () => {
    expect(formatModelCatalog([], undefined)).toBe('No models are advertised by the mounted LLM adapters.')
  })
})

describe('parseModelChoice', () => {
  it('accepts a 1-based catalog index', () => {
    expect(parseModelChoice('2', CATALOG)).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
    })
  })

  it('accepts provider/model or a unique model id', () => {
    expect(parseModelChoice('openai/gpt-5', CATALOG)).toEqual({ provider: 'openai', model: 'gpt-5' })
    expect(parseModelChoice('deepseek-v4-flash', CATALOG)).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
  })

  it('rejects an empty, out-of-range, or ambiguous id', () => {
    expect(parseModelChoice('', CATALOG)).toBeUndefined()
    expect(parseModelChoice('9', CATALOG)).toBeUndefined()
    expect(parseModelChoice('nope', CATALOG)).toBeUndefined()
  })
})
