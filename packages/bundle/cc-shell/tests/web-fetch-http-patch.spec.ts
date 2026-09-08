import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PATCH = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
const PKG = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
  dependencies: Record<string, string>
}

const NAME = '@deepseek-ai/dsh-web-fetch-http'
const RETIRED = '@dsh-cc/web-fetch-http'

describe('cc-shell web-fetch-http override (stock provider, CC egress caps)', () => {
  // The override row MUST be a top-level patch entry (cols 0). Restating it
  // inside the `- insert:` list would compose a second loader entry with the
  // same id as dsh-base's row and the loader would hard-throw on the duplicate.
  it('overrides the dsh-base stock row at top level with the CC egress caps', () => {
    const block = /^- id: web-fetch-http\n((?:[ \t]+.*\n?)*)/m.exec(PATCH)?.[1] ?? ''
    expect(block).toContain(`name: '${NAME}'`)
    expect(block).toContain('timeoutMs: 20000')
    expect(block).toContain('maxResponseBytes: 2000000')
    expect(block).toContain('maxRedirects: 3')
  })

  it('no longer mounts the retired SSRF-gated wrapper', () => {
    expect(PATCH).not.toContain(RETIRED)
    expect(PATCH).not.toContain('web-fetch-http-cc')
  })

  it('the fetch executor carries the CC product User-Agent', () => {
    const block = /^- id: web-fetch-http\n((?:[ \t]+.*\n?)*)/m.exec(PATCH)?.[1] ?? ''
    expect(block).toContain("userAgent: 'dsh-cc/")
  })

  it('does not declare the retired wrapper as a dependency', () => {
    expect(PKG.dependencies?.[RETIRED]).toBeUndefined()
  })
})
