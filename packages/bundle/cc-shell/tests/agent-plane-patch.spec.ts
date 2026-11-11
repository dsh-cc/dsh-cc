import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const req = createRequire(import.meta.url)
const includePkg = req.resolve('@deepseek-ai/cordis-plugin-include/package.json')
const yaml = createRequire(includePkg)('js-yaml') as typeof import('js-yaml')

function load(url: URL): any[] {
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
 * The 22 host rows the CC preset owns. This list is deliberately restated in
 * the specs of the bundles that must NOT declare it, so a row creeping back
 * into a surface bundle fails a test instead of silently re-mounting a second
 * copy of the agent plane.
 */
export const HOST_AGENT_PLANE_IDS = [
  'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search',
  'tool-str-replace-editor', 'skill-filesystem', 'tool-skill', 'tool-goal',
  'plan-mode', 'compaction-basic', 'command-compact', 'tool-result-pruner',
  'tool-subagent-control', 'tool-subagent',
  'tool-subagent-fork', 'workflow-worker-thread', 'tool-workflow', 'tool-ralph',
  'agent-instructions', 'tool-todo', 'tool-web',
] as const

const shell = flatten(load(new URL('../cordis.patch.yml', import.meta.url)))
const byId = new Map(shell.map(row => [row.id, row]))

describe('cc-shell host agent-plane vacating', () => {
  it('disables every host row the CC preset owns', () => {
    for (const id of HOST_AGENT_PLANE_IDS) {
      expect(byId.get(id)?.disabled, id).toBe(true)
    }
  })

  it('declares the rows at top level, never inside the insert list', () => {
    // An inserted `disabled` row would compose a second loader entry rather
    // than patching dsh-base's, which is a different (and wrong) mechanism.
    const inserted = new Set(
      shell.filter(row => row.insert !== undefined).flatMap(row => row.insert.map((r: any) => r.id)),
    )
    for (const id of HOST_AGENT_PLANE_IDS) {
      expect(inserted.has(id), id).toBe(false)
    }
  })

  it('disables rather than deletes, and never re-points a row it vacates', () => {
    for (const id of HOST_AGENT_PLANE_IDS) {
      const row = byId.get(id)
      expect(row?.name, id).toBeUndefined()
      expect(row?.config, id).toBeUndefined()
      expect(row?.disabled, id).toBe(true)
    }
  })

  it('does not disable the rows this bundle swaps or keeps', () => {
    // `tools` and `tool-executor-native` ARE disabled here, but for the
    // remount reason, not the agent-plane reason; settings/permissions belong
    // to cc-permissions and must stay untouched.
    for (const id of ['settings', 'permission-rules', 'webserver', 'hmr']) {
      expect(byId.has(id), id).toBe(false)
    }
  })
})
