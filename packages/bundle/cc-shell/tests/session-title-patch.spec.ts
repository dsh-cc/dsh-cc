import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PATCH = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
const PKG = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
  dependencies: Record<string, string>
}

const NAME = '@dsh-cc/session-title-provider'

describe('cc-shell session-title overlay patch', () => {
  it('disables the stock session-title-llm row', () => {
    const block = /^- id: session-title-llm\n((?:[ \t]+.*\n?)*)/m.exec(PATCH)?.[1] ?? ''
    expect(block).toContain('disabled: true')
  })

  it('inserts the cc provider row with the provider package name and id', () => {
    expect(PATCH).toContain('id: session-title-llm-cc')
    expect(PATCH).toContain(`name: '${NAME}'`)
  })

  it('declares the provider as a runtime dependency of the bundle', () => {
    expect(PKG.dependencies?.[NAME]).toBe('workspace:^')
  })
})
