import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const req = createRequire(import.meta.url)
const includePkg = req.resolve('@deepseek-ai/cordis-plugin-include/package.json')
const yaml = createRequire(includePkg)('js-yaml') as typeof import('js-yaml')

const patchPath = new URL('../cordis.patch.yml', import.meta.url).pathname
const pkgJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const doc = yaml.load(readFileSync(patchPath, 'utf8'), { schema: entryListSchema }) as any[]

const HOST_TOOL_IDS = [
  'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search',
  'tool-str-replace-editor', 'skill-filesystem', 'tool-skill', 'tool-goal',
  'plan-mode', 'compaction-basic', 'command-compact', 'tool-result-pruner',
  'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent',
  'tool-subagent-fork', 'workflow-worker-thread', 'tool-workflow', 'tool-ralph',
  'agent-instructions', 'tool-todo', 'tool-web',
]

function flatten(rows: any[]): any[] {
  const out: any[] = []
  for (const row of rows) {
    out.push(row)
    if (Array.isArray(row.insert)) out.push(...flatten(row.insert))
  }
  return out
}

describe('cc-tui bundle patch', () => {
  it('disables hmr and the web-app agent-plane host rows', () => {
    const rows = flatten(doc)
    const byId = new Map(rows.map(row => [row.id, row]))
    expect(byId.get('hmr')?.disabled).toBe(true)
    for (const id of HOST_TOOL_IDS) {
      expect(byId.get(id)?.disabled, id).toBe(true)
    }
  })

  it('does not retarget the tools or settings rows', () => {
    const ids = flatten(doc).map(row => row.id)
    expect(ids).not.toContain('tools')
    expect(ids).not.toContain('settings')
    expect(ids).not.toContain('permission-rules')
    expect(ids).not.toContain('webserver')
  })

  it('inserts the preset registry (default: cc), the cc declaration row, and a tui row', () => {
    // Harness >=0.1.7-rc.2 (G15): the deleted @deepseek-ai/dsh-agent-presets
    // scanner is replaced by the registry + a dsh-agent-preset declaration
    // row whose plugins carry the composition by reference (file-backed
    // include of @dsh-cc/preset-cc/agent.cordis.yml from the profile's
    // node_modules — the single tested source of the cc composition).
    const rows = flatten(doc)
    const registry = rows.find(row => row.id === 'agent-preset-registry')
    expect(registry?.name).toBe('@deepseek-ai/dsh-agent-preset-registry')
    expect(registry?.config?.default).toBe('cc')
    const preset = rows.find(row => row.id === 'preset-cc')
    expect(preset?.name).toBe('@deepseek-ai/dsh-agent-preset')
    expect(preset?.config?.id).toBe('cc')
    expect(preset?.config?.plugins).toEqual([
      {
        id: 'cc-composition',
        name: '@deepseek-ai/cordis-plugin-include',
        config: { path: 'node_modules/@dsh-cc/preset-cc/agent.cordis.yml' },
      },
    ])
    const tui = rows.find(row => row.id === 'tui')
    expect(tui?.name).toBe('@dsh-cc/tui')
    expect(tui?.config?.agentPreset).toBe('cc')
  })

  it('passes provider/model env vars through to the tui config block', () => {
    const rows = flatten(doc)
    const tui = rows.find(row => row.id === 'tui')
    // !!js defers evaluation to the loader; at parse time the marker carries
    // the unevaluated expression referencing the launcher env vars.
    expect(tui?.config?.provider).toEqual({ __jsExpr: 'process.env.DSH_CC_PROVIDER' })
    expect(tui?.config?.model).toEqual({ __jsExpr: 'process.env.DSH_CC_MODEL' })
  })

  it('depends on the TUI runtime package', () => {
    expect(Object.keys(pkgJson.dependencies ?? {})).toContain('@dsh-cc/tui')
  })

  it('does not ship @deepseek-ai/cordis', () => {
    const all = {
      ...pkgJson.dependencies,
      ...pkgJson.devDependencies,
      ...pkgJson.peerDependencies,
    }
    expect(all['@deepseek-ai/cordis']).toBeUndefined()
  })
})
