import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@dsh-cc/tools'
import { TaskGrants } from '../src/task-grant-service.ts'
const decided = { decision: { kind: 'passthrough' }, risk: { level: 'LOW', reasons: [] }, mode: 'auto', isReadOnly: false } as const

describe('task grant actual Git admission', () => {
  it.each([false, true])('checks no-escalation content and completed commit ranges (background=%s)', async background => {
    const root = mkdtempSync(join(tmpdir(), 'grant-admit-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' })
    try {
      git('init', '-b', 'task'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
      writeFileSync(join(root, 'a.md'), 'a'); writeFileSync(join(root, 'code.ts'), 'a'); git('add', '.'); git('commit', '-m', 'initial')
      const session = Session.create(SessionId('admission'), undefined, { version: 4, isSeeded: false, id: SessionId('admission'), cwd: root, createdAt: Date.now() })
      const agent = { id: 'agent', session } as unknown as Agent
      const grants = new TaskGrants({ bashToolName: 'Bash', fileEditTools: new Set(), workspaceOf: () => root, activeGoalIdOfSession: () => null })
      const path = join(root, 'descriptor.json'); writeFileSync(path, JSON.stringify({ rules: ['Bash(git commit)'], tools: [], writePaths: [], sandboxEscalation: false, contentScope: 'tracked-md-only' }))
      await grants.propose(agent, path); await grants.create(agent, path)
      const exec = { token: Symbol(), name: 'Bash', callId: 'c', agent, signal: new AbortController().signal, arguments: { command: 'git commit -m checked' } } as unknown as ToolExecution
      await expect(grants.authorize(decided, { ...exec, arguments: { command: 'git commit -m checked', workdir: tmpdir() } })).rejects.toThrow(/working directory/)
      git('switch', '-c', 'other'); await expect(grants.authorize(decided, exec)).rejects.toThrow(/branch changed/); git('switch', 'task')
      writeFileSync(join(root, 'code.ts'), 'bad'); git('add', 'code.ts')
      await expect(grants.authorize(decided, exec)).rejects.toThrow(/markdown/)
      git('reset', '--hard', 'HEAD'); await grants.propose(agent, path); await grants.create(agent, path)
      writeFileSync(join(root, 'a.md'), 'good'); git('add', 'a.md'); await grants.authorize(decided, exec)
      const finish = async () => {
        writeFileSync(join(root, 'code.ts'), 'hook change'); git('add', 'code.ts'); git('commit', '-m', 'hook mutation')
      }
      await expect(grants.execute(exec, async () => {
        if (!background) await finish()
        return { content: [], isError: false, ...(background ? { value: { kind: 'background', jobId: 'test-job' } } : {}) }
      }, finish)).rejects.toThrow(/revoked/)
      expect(grants.of(agent)).toHaveLength(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
