import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findToolPackages, isPackageSourcePath, findUncoveredToolSources } from './tool-schema-discovery.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'schema-discovery-'))
  roots.push(root)
  const pkg = join(root, 'packages', 'core', 'new-tool')
  mkdirSync(join(pkg, 'src'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@dsh-cc/new-tool' }))
  writeFileSync(join(pkg, 'src', 'index.ts'), source)
  return root
}

describe('tool schema gate discovery', () => {
  it.each(['/core/new-tool/src/index.ts', '\\core\\new-tool\\src\\index.ts'])(
    'recognizes source paths on either platform: %s', (path) => {
      expect(isPackageSourcePath(path)).toBe(true)
    },
  )

  it.each([
    'ctx.tools.register({ parameters: {} })',
    'ctx.tools.register ({ parameters: {} })',
    'ctx.tools\n .register\n ({ parameters: {} })',
    'tools.register\n({ parameters: {} })',
    'defineTool\n({ name: "new_tool" })',
  ])('detects an unlisted package with a registration call: %s', (source) => {
    expect(findToolPackages(fixture(source), new Set(), {})).toEqual(['@dsh-cc/new-tool'])
  })

  it('ignores comments and string literals containing registration examples', () => {
    const root = fixture('// defineTool({})\nconst example = "tools.register({})"')
    expect(findToolPackages(root, new Set(), {})).toEqual([])
  })

  it('accepts manifest entries and explicit exclusions', () => {
    const root = fixture('defineTool({})')
    expect(findToolPackages(root, new Set(['@dsh-cc/new-tool']), {})).toEqual([])
    expect(findToolPackages(root, new Set(), { '@dsh-cc/new-tool': 'fixture' })).toEqual([])
  })
})

const sourcePath = 'packages/core/new-tool/src/index.ts'
describe('registration source coverage within existing packages', () => {
  it('rejects a new registration site in an already covered source file', () => {
    const root = fixture('defineTool({}); if (enabled) tools.register({})')
    expect(findUncoveredToolSources(root, { [sourcePath]: 1 })).toEqual([
      `${sourcePath}: expected 1 registration calls, found 2`,
    ])
  })
  it('rejects a new source file in an already covered package', () => {
    const root = fixture('defineTool({})')
    writeFileSync(join(root, 'packages/core/new-tool/src/extra.ts'), 'tools.register({})')
    expect(findUncoveredToolSources(root, { [sourcePath]: 1 })).toEqual([
      'packages/core/new-tool/src/extra.ts: expected 0 registration calls, found 1',
    ])
  })
  it('detects removal of a surveyed registration site', () => {
    expect(findUncoveredToolSources(fixture('// removed'), { [sourcePath]: 1 })).toEqual([
      `${sourcePath}: expected 1 registration calls, found 0`,
    ])
  })
  it('accepts exact site coverage while ignoring examples', () => {
    expect(findUncoveredToolSources(fixture('defineTool({}); // tools.register({})'), { [sourcePath]: 1 })).toEqual([])
  })
})
