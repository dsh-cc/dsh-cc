import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  discoverAgents,
  findProjectAgentsDir,
  loadAgentsDir,
  loadClaudeCodeAgents,
} from '@dsh-cc/claude-code-agents'

const AGENT_MD = (body: string): string => `---
description: test agent
---
${body}`

async function rootdir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dsh-cc-agents-'))
}

async function writeAgent(dir: string, name: string, body: string): Promise<void> {
  const agents = join(dir, '.claude', 'agents')
  await mkdir(agents, { recursive: true })
  await writeFile(join(agents, `${name}.md`), AGENT_MD(body))
}

describe('findProjectAgentsDir', () => {
  it('finds the nearest .claude/agents by walking up', async () => {
    const root = await rootdir()
    const agentsDir = join(root, 'a', 'b', '.claude', 'agents')
    await mkdir(agentsDir, { recursive: true })
    expect(await findProjectAgentsDir(join(root, 'a', 'b', 'c')))
      .toBe(agentsDir)
  })

  it('returns undefined when no ancestor has a .claude/agents', async () => {
    const root = await rootdir()
    await mkdir(join(root, 'x'), { recursive: true })
    expect(await findProjectAgentsDir(join(root, 'x'))).toBeUndefined()
  })
})

describe('loadAgentsDir', () => {
  it('loads .md and .json files, ordered by filename, skipping non-agent files', async () => {
    const agentsDir = join(await rootdir(), '.claude', 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(join(agentsDir, 'zeta.md'), AGENT_MD('z'))
    await writeFile(join(agentsDir, 'alpha.md'), AGENT_MD('a'))
    await writeFile(join(agentsDir, 'bravo.json'), JSON.stringify({ description: 'j', prompt: 'p' }))
    await writeFile(join(agentsDir, 'readme.txt'), 'not an agent')

    const agents = await loadAgentsDir(agentsDir, 'project')
    expect(agents.map(agent => agent.agentType)).toEqual(['alpha', 'bravo', 'zeta'])
    expect(agents[1]?.source).toBe('project')
  })

  it('treats an absent directory as supplying no agents', async () => {
    expect(await loadAgentsDir(join(await rootdir(), '.claude', 'agents'), 'user')).toEqual([])
  })

  it('throws when a discovered file cannot be parsed', async () => {
    const agentsDir = join(await rootdir(), '.claude', 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(join(agentsDir, 'broken.md'), '---\ndescription: x\nmaxTurns: -3\n---\nbody')
    await expect(loadAgentsDir(agentsDir, 'project')).rejects.toThrow(/maxTurns must be a positive integer/)
  })
})

describe('discoverAgents', () => {
  it('projects shadow users on a name collision', async () => {
    const root = await rootdir()
    const userDir = join(await rootdir(), '.claude', 'agents')
    await mkdir(userDir, { recursive: true })
    await writeFile(join(userDir, 'git.md'), AGENT_MD('user version'))
    await writeAgent(root, 'git', 'project version')
    await writeAgent(root, 'code', 'only project')

    const agents = await discoverAgents(root, userDir)
    const git = agents.find(agent => agent.agentType === 'git')
    expect(git?.systemPrompt).toMatch(/project version/)
    expect(git?.source).toBe('project')
    expect(agents.map(agent => agent.agentType)).toEqual(expect.arrayContaining(['git', 'code']))
  })

  it('keeps only the user layer when the project layer is absent', async () => {
    const root = await rootdir()
    const userDir = join(await rootdir(), '.claude', 'agents')
    await mkdir(userDir, { recursive: true })
    await writeFile(join(userDir, 'only.md'), AGENT_MD('u'))

    const agents = await discoverAgents(root, userDir)
    expect(agents.map(agent => agent.agentType)).toEqual(expect.arrayContaining(['only']))
    const only = agents.find(agent => agent.agentType === 'only')
    expect(only?.source).toBe('user')
  })

  it('always yields the bundled agents even with no layers', async () => {
    const root = await rootdir()
    const agents = await discoverAgents(root, undefined)
    expect(agents.map(agent => agent.agentType)).toEqual(expect.arrayContaining(['explore', 'dsh-cc-guide']))
    for (const name of ['explore', 'dsh-cc-guide']) {
      expect(agents.find(agent => agent.agentType === name)?.source).toBe('bundled')
    }
  })

  it('a project agent shadows its bundled namesake', async () => {
    const root = await rootdir()
    await writeAgent(root, 'explore', 'project explore body')
    const agents = await discoverAgents(root, undefined)
    const explore = agents.find(agent => agent.agentType === 'explore')
    expect(explore?.source).toBe('project')
    expect(explore?.systemPrompt).toMatch(/project explore body/)
  })

  it('a user agent shadows bundled, and project shadows that user agent', async () => {
    const root = await rootdir()
    const userDir = join(await rootdir(), '.claude', 'agents')
    await mkdir(userDir, { recursive: true })
    await writeFile(join(userDir, 'dsh-cc-guide.md'), AGENT_MD('user guide body'))

    const userWins = await discoverAgents(root, userDir)
    const userGuide = userWins.find(agent => agent.agentType === 'dsh-cc-guide')
    expect(userGuide?.source).toBe('user')
    expect(userGuide?.systemPrompt).toMatch(/user guide body/)

    await writeAgent(root, 'dsh-cc-guide', 'project guide body')
    const projectWins = await discoverAgents(root, userDir)
    const projectGuide = projectWins.find(agent => agent.agentType === 'dsh-cc-guide')
    expect(projectGuide?.source).toBe('project')
    expect(projectGuide?.systemPrompt).toMatch(/project guide body/)
  })

  it('skips the user layer when userDir is undefined', async () => {
    const root = await rootdir()
    await writeAgent(root, 'code', 'c')
    const agents = await discoverAgents(root, undefined)
    expect(agents.map(agent => agent.agentType)).toEqual(expect.arrayContaining(['code']))
    expect(agents.find(agent => agent.agentType === 'code')?.source).toBe('project')
  })
})

describe('loadClaudeCodeAgents', () => {
  it('skips and warns on a file definition whose agentType contains a colon', async () => {
    const root = await rootdir()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await writeAgent(root, 'code', 'project body')
      await writeAgent(root, 'p:researcher', 'shadowing body')

      const agents = await loadClaudeCodeAgents(root, { userDir: join(await rootdir(), '.claude', 'agents') })
      expect(agents.map(agent => agent.agentType)).toEqual(expect.arrayContaining(['code']))
      expect(agents.some(agent => agent.agentType === 'p:researcher')).toBe(false)
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/p:researcher/))
    } finally {
      warn.mockRestore()
    }
  })

  it('a colon agentType loaded via loadAgentsDir still survives (guard placement)', async () => {
    const agentsDir = join(await rootdir(), '.claude', 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(join(agentsDir, 'review:security.md'), AGENT_MD('plugin-style body'))
    const agents = await loadAgentsDir(agentsDir, 'project')
    expect(agents.map(agent => agent.agentType)).toEqual(['review:security'])
  })

  it('loads project and user agents through the public function', async () => {
    const root = await rootdir()
    await writeAgent(root, 'code', 'project body')
    const userDir = join(await rootdir(), '.claude', 'agents')
    await mkdir(userDir, { recursive: true })
    await writeFile(join(userDir, 'code.md'), AGENT_MD('user body'))
    await writeFile(join(userDir, 'user-only.md'), AGENT_MD('u'))

    const agents = await loadClaudeCodeAgents(root, { userDir })
    expect(agents.map(agent => agent.agentType).sort())
      .toEqual(expect.arrayContaining(['code', 'user-only']))
    const code = agents.find(agent => agent.agentType === 'code')
    expect(code?.source).toBe('project')
    expect(code?.systemPrompt).toMatch(/project body/)
  })

  it('defaults the user layer to the OS home', async () => {
    // Homing the user layer at "~/.claude/agents" does not throw when absent.
    const root = await rootdir()
    await writeAgent(root, 'code', 'c')
    const agents = await loadClaudeCodeAgents(root)
    expect(agents.map(agent => agent.agentType)).toEqual(expect.arrayContaining(['code']))
    expect(agents.find(agent => agent.agentType === 'code')?.source).toBe('project')
  })
})
