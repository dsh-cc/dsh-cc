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
 * Last-write-wins fold of the CC host bundles, matching the ACP profile order
 * in `packages/launcher/tui/bootstrap.mjs`: permissions → shell → acp.
 * (`dsh-base` and `dsh-acp-app` resolve from the installation rather than the
 * profile, so their rows are not part of this fold.)
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

const HOST_AGENT_PLANE_IDS = [
  'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search',
  'tool-str-replace-editor', 'skill-filesystem', 'tool-skill', 'tool-goal',
  'plan-mode', 'compaction-basic', 'command-compact', 'tool-result-pruner',
  'tool-subagent-control', 'tool-subagent',
  'tool-subagent-fork', 'workflow-worker-thread', 'tool-workflow', 'tool-ralph',
  'agent-instructions', 'tool-todo', 'tool-web',
] as const

describe('acp profile stack (permissions + shell + acp)', () => {
  const permissions = loadPatch(new URL('../../cc-permissions/cordis.patch.yml', import.meta.url))
  const shell = loadPatch(new URL('../../cc-shell/cordis.patch.yml', import.meta.url))
  const acp = loadPatch(new URL('../cordis.patch.yml', import.meta.url))
  const stacked = fold([permissions, shell, acp])

  it('vacates the whole host agent plane through bundle-shell', () => {
    // The roster moved out of this bundle (PR-4) and into cc-shell so the TUI
    // and ACP lanes cannot drift; the folded profile must still end up with
    // all 22 rows disabled.
    for (const id of HOST_AGENT_PLANE_IDS) {
      expect(stacked.get(id)?.disabled, id).toBe(true)
    }
  })

  it('keeps the ACP swaps owned by this bundle', () => {
    expect(stacked.get('acp')?.disabled).toBe(true)
    expect(stacked.get('acp-cc')?.name).toBe('@dsh-cc/acp')
    expect(stacked.get('session-title-llm-cc')?.disabled).toBe(true)
  })

  it('mounts the preset roster the acp driver reads', () => {
    expect(stacked.get('agent-preset-registry')?.name).toBe('@deepseek-ai/dsh-agent-preset-registry')
    expect(stacked.get('agent-preset-registry')?.config?.default).toBe('cc')
    expect(stacked.get('preset-cc')?.name).toBe('@deepseek-ai/dsh-agent-preset')
    expect(stacked.get('preset-cc')?.config?.id).toBe('cc')
  })

  it('does not re-disable hmr (dsh-acp-app owns that row)', () => {
    expect(stacked.has('hmr')).toBe(false)
  })
})
