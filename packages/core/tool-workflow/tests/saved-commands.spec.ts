/**
 * Unit tests for saved-workflow `/<name>` command mounting (plan §3.1, DoD 1).
 * Covers the two-directory scan with project shadowing, the process.cwd() pin
 * with the divergence note, the structural one-rule (`savedWorkflowDirs` shared
 * by the tool's name resolution and this scan), registry-collision skip-warn
 * with the remaining mounts unaborted, name-rule / parse / shape skips, help
 * output carrying the meta description and mounted file path, verbatim raw-input
 * pass-through, the next-session prompt-section clause, and the absent-seam
 * whole-mount skip. The contract test at the bottom pins the local meta shape
 * rules against the harness `validateMeta` (deepseek-harness
 * `workflow-worker-thread/src/meta.ts`).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntimeCC from '@dsh-cc/tools'
// The harness validator this package's local shape replication must agree with
// (source of truth: deepseek-harness workflow-worker-thread/src/meta.ts:13-44).
import { validateMeta } from '@deepseek-ai/dsh-workflow-worker-thread/src/meta.ts'
import { mountSavedWorkflowCommands, metaShapeViolations } from '../src/commands.ts'
import type { CommandsSeamLike, SavedWorkflowCommandDefinition, WorkflowCommandsContext } from '../src/commands.ts'
import { savedWorkflowDirs } from '../src/launch.ts'
import * as toolWorkflow from '../src/index.ts'
import { WorkflowEngine } from '@deepseek-ai/dsh-workflow'

/** Placeholder engine so the tool plugin's `workflowEngine` inject resolves (cordis lazily defers an unsatisfied plugin). */
class DummyEngine extends WorkflowEngine {
  override start(): never {
    throw new Error('dummy engine: no runs expected in this spec')
  }
}

const roots: string[] = []
function workspace(): string {
  const scratch = join(process.cwd(), '.scratch')
  mkdirSync(scratch, { recursive: true })
  const root = mkdtempSync(join(scratch, 'saved-commands-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// The scan probes `<resolveDshHome()>/workflows` for the user directory; the
// resolver honors $DSH_HOME, so tests point it at a per-test temp home and
// never touch the real one.
let oldDshHome: string | undefined

function writeWorkflow(root: string, sub: '.claude/workflows' | 'user', fileName: string, body: string): string {
  const dir = sub === 'user' ? join(root, 'workflows') : join(root, '.claude', 'workflows')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, fileName)
  writeFileSync(path, body)
  return path
}

function validBody(name: string, description = 'runs an audit'): string {
  return `export const meta = { name: '${name}', description: '${description}' }\nreturn 1`
}

/** Seam stub: records definitions, refuses duplicates (registry collision), optionally one fixed name. */
function seamStub(refuse?: string): CommandsSeamLike & { registered: SavedWorkflowCommandDefinition[] } {
  const registered: SavedWorkflowCommandDefinition[] = []
  return {
    registered,
    register(definition) {
      if (registered.some(d => d.name === definition.name) || (refuse !== undefined && definition.name === refuse)) {
        throw new Error(`command "${refuse}" is already registered in this scope`)
      }
      registered.push(definition)
      return () => {
        const i = registered.indexOf(definition)
        if (i >= 0) registered.splice(i, 1)
      }
    },
  }
}

function ctxStub(commands: unknown): WorkflowCommandsContext & { warns: string[] } {
  const warns: string[] = []
  return {
    get: (key: string) => (key === 'commands' ? commands : undefined),
    logger: { warn: (message: string) => { warns.push(message) } },
    warns,
  }
}

/** Mount a scan against a prepared workspace and return the seam + warns. */
function mountScan(root: string, seam: CommandsSeamLike & { registered: SavedWorkflowCommandDefinition[] }, options: { userRoot?: string } = {}) {
  process.env.DSH_HOME = options.userRoot ?? root
  const ctx = ctxStub(seam)
  const disposers = mountSavedWorkflowCommands(ctx, root)
  return { disposers, registered: seam.registered, ...ctx }
}

beforeEach(() => { oldDshHome = process.env.DSH_HOME })
afterEach(() => {
  if (oldDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = oldDshHome
})

describe('savedWorkflowDirs (structural one-rule)', () => {
  it('lists the project directory first, then the user workflows directory', () => {
    const root = workspace()
    process.env.DSH_HOME = root
    expect(savedWorkflowDirs(root)).toEqual([
      join(root, '.claude', 'workflows'),
      join(root, 'workflows'),
    ])
  })

  it('the scanned set and the tool name-resolution set come from the same helper', () => {
    // Structural: resolveScriptSource probes exactly savedWorkflowDirs.
    const launchSrc = readFileSync(new URL('../src/launch.ts', import.meta.url), 'utf8')
    const scanSrc = readFileSync(new URL('../src/commands.ts', import.meta.url), 'utf8')
    expect(launchSrc).toContain('export function savedWorkflowDirs(cwd: string)')
    expect(launchSrc).toContain('const dirs = savedWorkflowDirs(cwd)')
    expect(scanSrc).toContain('savedWorkflowDirs(cwd)')
  })
})

describe('mountSavedWorkflowCommands', () => {
  it('skips the whole mount with one logger line when the commands seam is absent', () => {
    const root = workspace()
    writeWorkflow(root, '.claude/workflows', 'audit.js', validBody('audit'))
    const ctx = ctxStub(undefined)
    const disposers = mountSavedWorkflowCommands(ctx, root)
    expect(disposers).toEqual([])
    expect(ctx.warns).toHaveLength(1)
    expect(ctx.warns[0]).toContain('commands seam')
  })

  it('scans both directories with project shadowing user on name collision', () => {
    const root = workspace()
    const userRoot = workspace()
    const projectPath = writeWorkflow(root, '.claude/workflows', 'dup.js', validBody('dup', 'project wins'))
    const userPath = writeWorkflow(userRoot, 'user', 'dup.js', validBody('dup', 'user copy'))
    writeWorkflow(root, '.claude/workflows', 'only.js', validBody('only'))
    const seam = seamStub()
    const { registered, warns } = mountScan(root, seam, { userRoot })
    const names = registered.map(d => d.name).sort()
    expect(names).toEqual(['dup', 'only'])
    expect(registered.find(d => d.name === 'dup')!.description).toBe('project wins')
    // The user-side `dup` is silently shadowed at scan time (matching
    // resolveScriptSource's project-first rule) — no collision warn.
    expect(warns.some(w => w.includes('"/dup"'))).toBe(false)
  })

  it('same-process session fibers adopt an identical mount silently and refcount teardown', () => {
    const root = workspace()
    writeWorkflow(root, '.claude/workflows', 'audit.js', validBody('audit'))
    const seam = seamStub()
    const first = mountScan(root, seam)
    const second = mountScan(root, seam)
    // The second fiber registered nothing and warned about nothing.
    expect(seam.registered.map(d => d.name)).toEqual(['audit'])
    expect(second.warns).toEqual([])
    // The first fiber's teardown leaves the command mounted for the second.
    first.disposers.forEach(d => d())
    expect(seam.registered.map(d => d.name)).toEqual(['audit'])
    // The last holder out unregisters.
    second.disposers.forEach(d => d())
    expect(seam.registered).toEqual([])
  })

  it('a changed scan remounts (new save picked up by the next session in the same process)', () => {
    const root = workspace()
    writeWorkflow(root, '.claude/workflows', 'audit.js', validBody('audit'))
    const seam = seamStub()
    const first = mountScan(root, seam)
    writeWorkflow(root, '.claude/workflows', 'review.js', validBody('review'))
    mountScan(root, seam)
    expect(seam.registered.map(d => d.name).sort()).toEqual(['audit', 'review'])
    first.disposers.forEach(d => d()) // stale holder release must not yank the remount
    expect(seam.registered.map(d => d.name).sort()).toEqual(['audit', 'review'])
  })

  it('ignores non-.js directory entries', () => {
    const root = workspace()
    writeWorkflow(root, '.claude/workflows', 'README.md', validBody('readme'))
    writeWorkflow(root, '.claude/workflows', 'audit.js', validBody('audit'))
    const seam = seamStub()
    const { registered } = mountScan(root, seam)
    expect(registered.map(d => d.name)).toEqual(['audit'])
  })

  it('skips file names failing the command-name rule with a reason line', () => {
    const root = workspace()
    writeWorkflow(root, '.claude/workflows', 'BadName.js', validBody('BadName'))
    writeWorkflow(root, '.claude/workflows', 'ok.js', validBody('ok'))
    const seam = seamStub()
    const { registered, warns } = mountScan(root, seam)
    expect(registered.map(d => d.name)).toEqual(['ok'])
    expect(warns.some(w => w.includes('BadName.js') && w.includes('command-name rule'))).toBe(true)
  })

  it('skips parse-failing meta with a reason line and mounts valid siblings', () => {
    const root = workspace()
    writeWorkflow(root, '.claude/workflows', 'broken.js', 'export const meta = { name: badIdentifier }\nreturn 1')
    writeWorkflow(root, '.claude/workflows', 'good.js', validBody('good'))
    const seam = seamStub()
    const { registered, warns } = mountScan(root, seam)
    expect(registered.map(d => d.name)).toEqual(['good'])
    expect(warns.some(w => w.includes('good.js') === false && w.includes('broken.js') && w.includes('parse check'))).toBe(true)
  })

  it('skips parse-ok but shape-invalid meta with a shape-check reason line; valid siblings mount', () => {
    const root = workspace()
    writeWorkflow(root, '.claude/workflows', 'empty-desc.js', 'export const meta = { name: "x", description: "" }\nreturn 1')
    writeWorkflow(root, '.claude/workflows', 'unknown-field.js', 'export const meta = { name: "x", description: "d", bogus: 1 }\nreturn 1')
    writeWorkflow(root, '.claude/workflows', 'bad-phase.js', 'export const meta = { name: "x", description: "d", phases: [{ detail: "no title" }] }\nreturn 1')
    writeWorkflow(root, '.claude/workflows', 'good.js', validBody('good'))
    const seam = seamStub()
    const { registered, warns } = mountScan(root, seam)
    expect(registered.map(d => d.name)).toEqual(['good'])
    for (const file of ['empty-desc.js', 'unknown-field.js', 'bad-phase.js']) {
      expect(warns.some(w => w.includes(file) && w.includes('shape check'))).toBe(true)
    }
  })

  it('skip-warns a registry collision naming the winner and still mounts the rest', () => {
    const root = workspace()
    writeWorkflow(root, '.claude/workflows', 'collide.js', validBody('collide'))
    writeWorkflow(root, '.claude/workflows', 'after.js', validBody('after'))
    const seam = seamStub('collide')
    const { registered, warns } = mountScan(root, seam)
    expect(registered.map(d => d.name)).toEqual(['after'])
    expect(warns.some(w => w.includes('"/collide"') && w.includes('already registered') && w.includes('existing registration wins'))).toBe(true)
  })

  it('a TypeError from the registry warns as an invalid definition, not a collision', () => {
    const root = workspace()
    writeWorkflow(root, '.claude/workflows', 'blank.js', validBody('blank'))
    const base = seamStub()
    const seam: typeof base = {
      registered: base.registered,
      register(definition) {
        // The harness normalizeDefinition refuses a whitespace-only
        // description with a TypeError — a definition problem, not a name
        // collision; the warn must say so.
        throw new TypeError(`command "${definition.name}" description must not be empty`)
      },
    }
    const { registered, warns } = mountScan(root, seam)
    expect(registered).toEqual([])
    expect(warns.some(w => w.includes('"/blank"') && w.includes('invalid command definition'))).toBe(true)
    expect(warns.some(w => w.includes('already registered'))).toBe(false)
  })

  it('disposers unmount the registered commands', () => {
    const root = workspace()
    writeWorkflow(root, '.claude/workflows', 'audit.js', validBody('audit'))
    const seam = seamStub()
    const { disposers } = mountScan(root, seam)
    for (const dispose of disposers) dispose()
    expect(seam.registered).toHaveLength(0)
  })

  it('help output prints the meta description and the mounted file path', async () => {
    const root = workspace()
    const path = writeWorkflow(root, '.claude/workflows', 'audit.js', validBody('audit', 'audits the branch'))
    const seam = seamStub()
    const { registered } = mountScan(root, seam)
    const result = await registered[0]!.handler({
      agent: { followup: vi.fn() },
      rawInput: 'help',
    } as never)
    expect(result.kind).toBe('success')
    expect((result as { text: string }).text).toContain('audits the branch')
    expect((result as { text: string }).text).toContain(path)
  })

  it('passes user free-text through verbatim into the composed instruction', async () => {
    const root = workspace()
    writeWorkflow(root, '.claude/workflows', 'audit.js', validBody('audit'))
    const seam = seamStub()
    const { registered } = mountScan(root, seam)
    const followup = vi.fn()
    const raw = '  --scope "src/**" --deep  '
    await registered[0]!.handler({ agent: { followup }, rawInput: raw } as never)
    expect(followup).toHaveBeenCalledTimes(1)
    const message = followup.mock.calls[0]![0] as { content: { type: string; text?: string }[] }
    const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('')
    expect(text).toContain('Run the workflow named `audit` via the workflow tool. User arguments, verbatim, are:')
    expect(text.endsWith(raw)).toBe(true)
  })

  it('folds a rejected followup into an error result, never an escaping rejection', async () => {
    const root = workspace()
    writeWorkflow(root, '.claude/workflows', 'audit.js', validBody('audit'))
    const seam = seamStub()
    const { registered } = mountScan(root, seam)
    const result = await registered[0]!.handler({
      agent: { followup: () => Promise.reject(new Error('agent busy')) },
      rawInput: '',
    } as never)
    expect(result).toEqual({ kind: 'error', text: expect.stringContaining('could not dispatch command prompt') })
  })
})

describe('apply wiring (index.ts)', () => {
  it('pins the scan cwd to process.cwd() with the divergence note in place', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(src).toContain('mountSavedWorkflowCommands(ctx, process.cwd())')
    expect(src).toContain('diverge from what the tool resolves')
  })

  it('registers the prompt section carrying the next-session /<name> clause', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntimeCC)
    await ctx.plugin(DummyEngine)
    await ctx.plugin(toolWorkflow, {})
    expect(ctx.tools).toBeDefined()
    const provider = await ctx.systemPrompt.assemble()
    expect(JSON.stringify(provider)).toContain('invocable as `/<name>` in their NEXT session')
  })

  it('apply with no commands seam still mounts the tool (skip, no throw)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntimeCC)
    await ctx.plugin(DummyEngine)
    await ctx.plugin(toolWorkflow, {})
    expect(ctx.tools).toBeDefined()
  })
})

describe('contract: local meta shape rules vs harness validateMeta', () => {
  const cases: { label: string; meta: unknown }[] = [
    { label: 'valid minimal', meta: { name: 'audit', description: 'runs an audit' } },
    { label: 'valid full', meta: { name: 'audit', description: 'd', whenToUse: 'big audits', phases: [{ title: 'scan', detail: 'read', provider: 'p', model: 'm' }] } },
    { label: 'not an object', meta: 'audit' },
    { label: 'array', meta: [{ name: 'a', description: 'd' }] },
    { label: 'missing name', meta: { description: 'd' } },
    { label: 'empty description', meta: { name: 'a', description: '' } },
    { label: 'unknown field', meta: { name: 'a', description: 'd', bogus: 1 } },
    { label: 'whenToUse mistyped', meta: { name: 'a', description: 'd', whenToUse: 3 } },
    { label: 'phases not array', meta: { name: 'a', description: 'd', phases: {} } },
    { label: 'phase not object', meta: { name: 'a', description: 'd', phases: ['scan'] } },
    { label: 'phase unknown field', meta: { name: 'a', description: 'd', phases: [{ title: 's', extra: 1 }] } },
    { label: 'phase empty title', meta: { name: 'a', description: 'd', phases: [{ title: '' }] } },
    { label: 'phase detail mistyped', meta: { name: 'a', description: 'd', phases: [{ title: 's', detail: 2 }] } },
    { label: 'phase provider mistyped', meta: { name: 'a', description: 'd', phases: [{ title: 's', provider: 1 }] } },
    { label: 'phase model mistyped', meta: { name: 'a', description: 'd', phases: [{ title: 's', model: [] }] } },
  ]
  for (const { label, meta } of cases) {
    it(`agrees with the harness validator: ${label}`, () => {
      const violations = metaShapeViolations(meta)
      let harnessThrew = false
      try {
        validateMeta(meta)
      } catch {
        harnessThrew = true
      }
      expect(violations.length > 0).toBe(harnessThrew)
      expect(harnessThrew).toBe(label !== 'valid minimal' && label !== 'valid full')
    })
  }
})
