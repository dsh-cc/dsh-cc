import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { TaskGrants } from '../src/task-grant-service.ts'

const temporaryRoots: string[] = []

function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' })
}

function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grant-descriptor-path-')))
  temporaryRoots.push(root)
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, '.dsh/vwa/batches'), { recursive: true })
  git(root, ['init', '--initial-branch=descriptor-path'])
  git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'fixture'])
  return root
}

function descriptor(root: string, writePaths: string[] = ['docs']): string {
  const path = join(root, 'grant-descriptor.json')
  writeFileSync(path, JSON.stringify({ rules: [], tools: [], writePaths, sandboxEscalation: false }))
  return path
}

function setup(root: string): {
  agent: Agent
  grants: TaskGrants
  state: { workspace: string; goalId: string | null }
} {
  const id = SessionId(randomUUID())
  const session = Session.create(id, undefined, {
    version: 4, isSeeded: false, id, createdAt: Date.now(), cwd: root,
  })
  session.append('turn/start', { turn: 1 })
  const agent = { id, session, inject: () => {} } as unknown as Agent
  const state: { workspace: string; goalId: string | null } = { workspace: root, goalId: null }
  const grants = new TaskGrants({
    bashToolName: 'Bash', fileEditTools: new Set(['write']),
    workspaceOf: () => state.workspace,
    activeGoalIdOfSession: () => state.goalId,
  })
  return { agent, grants, state }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('task-grant descriptor identity in the active session workspace', () => {
  it('resolves relative descriptor paths against the workspace rather than process.cwd', async () => {
    const root = workspace()
    descriptor(root)
    const { agent, grants } = setup(root)
    const view = await grants.propose(agent, 'grant-descriptor.json')
    expect(view.root).toBe(root)
    expect(view.branch).toBe('descriptor-path')
    expect(await grants.create(agent, 'grant-descriptor.json')).toBe(view)
  })

  it('uses the same canonical descriptor identity for a symlink and its target', async () => {
    const root = workspace()
    const path = descriptor(root)
    const alias = join(root, 'descriptor-alias.json')
    symlinkSync(path, alias)
    const { agent, grants } = setup(root)
    const view = await grants.propose(agent, alias)
    expect(await grants.create(agent, path)).toBe(view)
  })

  it('rejects a descriptor symlink retarget even when the replacement bytes are identical', async () => {
    const root = workspace()
    const path = descriptor(root)
    const replacement = join(root, 'identical-descriptor.json')
    writeFileSync(replacement, JSON.stringify({ rules: [], tools: [], writePaths: ['docs'], sandboxEscalation: false }))
    const alias = join(root, 'descriptor-alias.json')
    symlinkSync(path, alias)
    const { agent, grants } = setup(root)
    await grants.propose(agent, alias)
    unlinkSync(alias)
    symlinkSync(replacement, alias)
    await expect(grants.create(agent, alias)).rejects.toThrow(/pending|changed/)
    expect(grants.of(agent)).toHaveLength(0)
  })

  it('rejects workspace changes before confirmation and permits a fresh relative proposal there', async () => {
    const first = workspace()
    const second = workspace()
    const path = descriptor(first)
    descriptor(second, ['.dsh/vwa/batches'])
    const { agent, grants, state } = setup(first)
    await grants.propose(agent, path)
    state.workspace = second
    await expect(grants.create(agent, path)).rejects.toThrow(/workspace\/branch\/goal changed/)
    const next = await grants.propose(agent, 'grant-descriptor.json')
    expect(next.root).toBe(second)
    expect(next.writePaths).toEqual(['.dsh/vwa/batches'])
    expect(await grants.create(agent, 'grant-descriptor.json')).toBe(next)
  })

  it('rejects a branch switch after the descriptor approval view', async () => {
    const root = workspace()
    const path = descriptor(root)
    const { agent, grants } = setup(root)
    await grants.propose(agent, path)
    git(root, ['switch', '-c', 'switched-branch'])
    await expect(grants.create(agent, path)).rejects.toThrow(/workspace\/branch\/goal changed/)
    expect(grants.of(agent)).toHaveLength(0)
  })

  it('rejects an active goal change after the descriptor approval view', async () => {
    const root = workspace()
    const path = descriptor(root)
    const { agent, grants, state } = setup(root)
    state.goalId = 'goal-1'
    await grants.propose(agent, path)
    state.goalId = 'goal-2'
    await expect(grants.create(agent, path)).rejects.toThrow(/workspace\/branch\/goal changed/)
    expect(grants.of(agent)).toHaveLength(0)
  })

  it.each(['.dsh', 'docs/state'])('rejects a proposed prefix covering authoritative canonical state: %s', async (writePath) => {
    const root = workspace()
    symlinkSync(join(root, '.dsh/vwa'), join(root, 'docs/state'))
    const path = descriptor(root, [writePath])
    const { agent, grants } = setup(root)
    await expect(grants.propose(agent, path)).rejects.toThrow(/authoritative VWA state/)
    expect(grants.of(agent)).toHaveLength(0)
  })

  it('rejects a proposed symlink prefix whose canonical target is outside the workspace', async () => {
    const root = workspace()
    const outside = workspace()
    symlinkSync(outside, join(root, 'docs/outside'))
    const path = descriptor(root, ['docs/outside'])
    const { agent, grants } = setup(root)
    await expect(grants.propose(agent, path)).rejects.toThrow(/workspace root/)
    expect(grants.of(agent)).toHaveLength(0)
  })
})
