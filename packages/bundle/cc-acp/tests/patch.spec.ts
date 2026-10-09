import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

type Row = { id?: string, name?: string, disabled?: boolean, insert?: Row[] }

const rows = yaml.load(readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')) as Row[]

describe('cc-acp bundle patch', () => {
  it('disables the host agent-plane roster, no hmr row', () => {
    const disabled = rows.filter(r => r.disabled === true && r.insert === undefined).map(r => r.id)
    expect(disabled).toEqual([
      'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search',
      'tool-str-replace-editor', 'skill-filesystem', 'tool-skill', 'tool-goal',
      'plan-mode', 'compaction-basic', 'command-compact', 'tool-result-pruner',
      'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent',
      'tool-subagent-fork', 'workflow-worker-thread', 'tool-workflow',
      'tool-ralph', 'agent-instructions', 'tool-todo', 'tool-web',
      'acp', 'session-title-llm-cc',
    ])
    // hmr is deliberately absent: the retained dsh-acp-app bundle owns it.
    expect(rows.some(r => r.id === 'hmr')).toBe(false)
  })

  it('inserts the cc preset roster and the acp-cc driver, in order', () => {
    const insert = rows.find(r => r.insert !== undefined)!.insert!
    const ids = insert.map(r => r.id)
    expect(ids).toEqual(['agent-preset-registry', 'preset-cc', 'acp-cc'])
    expect(insert[0]).toMatchObject({ name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'cc' } })
    const composition = insert[1]!.config!.plugins[0] as { id: string, name: string, config: { path: string } }
    expect(composition).toMatchObject({
      id: 'cc-composition',
      name: '@deepseek-ai/cordis-plugin-include',
      config: { path: 'node_modules/@dsh-cc/preset-cc/agent.cordis.yml' },
    })
    expect(insert[2]).toMatchObject({
      name: '@dsh-cc/acp',
      inject: ['acpAppStartup'],
      config: { presetId: 'cc' },
    })
  })
})
