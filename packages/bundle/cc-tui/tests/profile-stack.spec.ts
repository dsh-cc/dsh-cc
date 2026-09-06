import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const req = createRequire(import.meta.url)
const includePkg = req.resolve('@deepseek-ai/cordis-plugin-include/package.json')
const yaml = createRequire(includePkg)('js-yaml') as typeof import('js-yaml')

function loadPatch(url: URL): any[] {
  return yaml.load(readFileSync(url, 'utf8'), { schema: entryListSchema }) as any[]
}

function flatten(rows: any[]): any[] {
  const out: any[] = []
  for (const row of rows) {
    out.push(row)
    if (Array.isArray(row.insert)) out.push(...flatten(row.insert))
  }
  return out
}

/**
 * Last-write-wins fold of the three CC host bundles, matching profile order:
 * permissions → shell → tui.
 */
function fold(patches: any[][]): Map<string, any> {
  const byId = new Map<string, any>()
  for (const patch of patches) {
    for (const row of flatten(patch)) {
      if (typeof row.id !== 'string') continue
      const previous = byId.get(row.id)
      byId.set(row.id, previous === undefined ? row : { ...previous, ...row })
    }
  }
  return byId
}

describe('tui profile stack (permissions + shell + tui)', () => {
  const permissions = loadPatch(new URL('../../cc-permissions/cordis.patch.yml', import.meta.url))
  const shell = loadPatch(new URL('../../cc-shell/cordis.patch.yml', import.meta.url))
  const tui = loadPatch(new URL('../cordis.patch.yml', import.meta.url))
  const stacked = fold([permissions, shell, tui])

  it('keeps the CC tools swap and permission engine from earlier bundles', () => {
    expect(stacked.get('tools')?.disabled).toBe(true)
    expect(stacked.get('tools-cc')?.name).toBe('@dsh-cc/tools')
    expect(stacked.get('settings')?.disabled).toBe(true)
    expect(stacked.get('permission-rules')?.name).toBe('@dsh-cc/permission-rules')
  })

  it('defaults the roster to cc and mounts the TUI driver', () => {
    expect(stacked.get('agent-presets')?.config?.default).toBe('cc')
    expect(stacked.get('tui')?.name).toBe('@dsh-cc/tui')
    expect(stacked.get('tui')?.config?.agentPreset).toBe('cc')
  })

  it('does not start a web server and disables host agent-plane tools', () => {
    expect(stacked.has('webserver')).toBe(false)
    expect(stacked.get('hmr')?.disabled).toBe(true)
    expect(stacked.get('tool-bash')?.disabled).toBe(true)
    expect(stacked.get('tool-web')?.disabled).toBe(true)
  })
})
