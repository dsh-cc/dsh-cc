/**
 * Unit tests for the manage_skill tool: registration + schema, gate behavior
 * (default enabled, settings-off text, absent settings service), full CRUD +
 * list shapes, every store error code surfaced as isError with its code word,
 * per-action invalid_params, `skills/learned-changed` emitted on successful
 * mutations only, and sanitization of tool-provided descriptions.
 *
 * The store home is a tempdir via `DSH_HOME` (command-learn.spec precedent);
 * nothing touches the real home.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntimeCC from '@dsh-cc/tools'
import * as ToolManageSkill from '@dsh-cc/tool-manage-skill'
import { learnedSkillPath } from '@dsh-cc/skill-loader'

let homeDir: string

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'tool-manage-skill-'))
  process.env.DSH_HOME = homeDir
})

afterAll(async () => {
  delete process.env.DSH_HOME
})

interface SetupOptions {
  /** Raw `cc-learn` settings section (undefined → absent section → default enabled). */
  section?: unknown
  /** Whether a settings service is attached at all (default true). */
  withSettings?: boolean
  /** Registry claimants surfaced by `ctx.skills.list`. */
  claimants?: readonly { name: string; provider: string; source: string }[]
}

async function setup(options: SetupOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntimeCC)
  ctx.provide('skills', {
    list: async () => options.claimants ?? [],
  } as never)
  if (options.withSettings !== false) {
    ctx.provide('settings', {
      get: (ns: string) => (ns === 'cc-learn' ? options.section : undefined),
    } as never)
  }
  const changed = vi.fn()
  ctx.on('skills/learned-changed', changed)
  await ctx.plugin(ToolManageSkill)
  return { ctx, changed }
}

let callCounter = 0
function call(ctx: Context, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++callCounter}`),
    name: 'manage_skill',
    arguments: args,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

const CREATE = { action: 'create', name: 'fix-flaky-test', description: 'How to unflake the CI suite here', body: 'Run pnpm -w test --retry=2.' }

describe('registration', () => {
  it('registers exactly one manage_skill with action required', async () => {
    const { ctx } = await setup()
    const schemas = ctx.tools.schemas().filter(s => s.name === 'manage_skill')
    expect(schemas).toHaveLength(1)
    expect(schemas[0]!.parameters).toMatchObject({
      type: 'object',
      properties: {
        action: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['action'],
    })
  })

  it('is not concurrency-safe (mutating tool)', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.get('manage_skill')?.isConcurrencySafe?.({ action: 'list' })).toBe(false)
  })

  it('description carries the promotion guidance', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(s => s.name === 'manage_skill')!
    expect(schema.description).toContain('procedural')
    expect(schema.description).toContain('secrets')
  })
})

describe('gate', () => {
  it('defaults to enabled when the cc-learn section is absent', async () => {
    const { ctx } = await setup({ section: undefined })
    const result = await call(ctx, { action: 'list' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('no learned skills')
  })

  it('returns the exact disabled text when cc-learn.enabled is false', async () => {
    const { ctx, changed } = await setup({ section: { enabled: false } })
    const result = await call(ctx, { ...CREATE })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('manage_skill is disabled (`cc-learn.enabled` is false in settings).')
    expect(changed).not.toHaveBeenCalled()
  })

  it('falls back to enabled when no settings service is attached', async () => {
    const { ctx } = await setup({ withSettings: false })
    const result = await call(ctx, { action: 'list' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('no learned skills')
  })
})

describe('invalid_params per action', () => {
  it.each([
    [{ action: 'create', name: 'x', description: 'd' }, 'create requires'],
    [{ action: 'create', name: 'x', body: 'b' }, 'create requires'],
    [{ action: 'update', description: 'd' }, 'update requires'],
    [{ action: 'update', name: 'x' }, 'body or description'],
    [{ action: 'delete' }, 'delete requires'],
  ])('rejects %j with invalid_params', async (args, fragment) => {
    const { ctx, changed } = await setup()
    const result = await call(ctx, args)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('invalid_params')
    expect(text(result)).toContain(fragment)
    expect(changed).not.toHaveBeenCalled()
  })
})

describe('CRUD happy paths', () => {
  it('creates a learned skill and reports the path', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, CREATE)
    expect(result.isError).toBe(false)
    expect(text(result)).toContain(`created learned skill fix-flaky-test`)
    const path = learnedSkillPath(homeDir, 'fix-flaky-test')
    expect(existsSync(path)).toBe(true)
    const raw = readFileSync(path, 'utf8')
    expect(raw).toContain('name: fix-flaky-test')
    expect(raw).toContain('learnedFrom: manage_skill')
  })

  it('updates the body while preserving unknown frontmatter keys', async () => {
    const { ctx } = await setup()
    await call(ctx, CREATE)
    const path = learnedSkillPath(homeDir, 'fix-flaky-test')
    // Seed an unknown frontmatter key directly on disk.
    const raw = readFileSync(path, 'utf8')
    const withExtra = raw.replace('learnedFrom: manage_skill', 'learnedFrom: manage_skill\ncustom-key: keep-me')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, withExtra, 'utf8')
    const result = await call(ctx, { action: 'update', name: 'fix-flaky-test', body: 'New body.' })
    expect(result.isError).toBe(false)
    const updated = readFileSync(path, 'utf8')
    expect(updated).toContain('New body.')
    expect(updated).toContain('custom-key: keep-me')
  })

  it('updates the description only when no body is given', async () => {
    const { ctx } = await setup()
    await call(ctx, CREATE)
    const result = await call(ctx, { action: 'update', name: 'fix-flaky-test', description: 'Better description.' })
    expect(result.isError).toBe(false)
    const raw = readFileSync(learnedSkillPath(homeDir, 'fix-flaky-test'), 'utf8')
    expect(raw).toContain('Better description.')
  })

  it('deletes the whole skill directory', async () => {
    const { ctx } = await setup()
    await call(ctx, CREATE)
    const result = await call(ctx, { action: 'delete', name: 'fix-flaky-test' })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('deleted learned skill fix-flaky-test')
    expect(existsSync(learnedSkillPath(homeDir, 'fix-flaky-test'))).toBe(false)
  })

  it('lists entries one per line with the pinned shape', async () => {
    const { ctx } = await setup()
    await call(ctx, CREATE)
    const result = await call(ctx, { action: 'list' })
    expect(result.isError).toBe(false)
    const lines = text(result).split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^fix-flaky-test — .+ \(\d+ B\) — .+SKILL\.md$/)
  })

  it('lists nothing as "no learned skills"', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, { action: 'list' })
    expect(text(result)).toBe('no learned skills')
  })
})

describe('error codes', () => {
  it('maps a bad name to invalid_name', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, { ...CREATE, name: 'Bad_Name!' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('invalid_name')
  })

  it('maps re-creating an existing skill to already_exists', async () => {
    const { ctx } = await setup()
    await call(ctx, CREATE)
    const result = await call(ctx, CREATE)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('already_exists')
  })

  it('maps an authored claimant to shadowed', async () => {
    const { ctx } = await setup({
      claimants: [{ name: 'fix-flaky-test', provider: 'claude-code', source: 'project-dsh' }],
    })
    const result = await call(ctx, CREATE)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('shadowed')
  })

  it('maps an oversized body to too_large', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, { ...CREATE, body: 'x'.repeat(70_000) })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('too_large')
  })

  it('maps updating a missing skill to not_found with the authored hint', async () => {
    const { ctx } = await setup({
      claimants: [{ name: 'authored-one', provider: 'claude-code', source: 'user-dsh' }],
    })
    const result = await call(ctx, { action: 'update', name: 'authored-one', body: 'x' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not_found')
    expect(text(result)).toContain('authored skill')
    expect(text(result)).toContain('claude-code')
  })

  it('maps deleting a missing skill to not_found without an authored hint', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, { action: 'delete', name: 'never-was' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not_found')
    expect(text(result)).not.toContain('authored skill')
  })
})

describe('event emission and sanitization', () => {
  it('emits skills/learned-changed on every successful mutation, never on failure', async () => {
    const { ctx, changed } = await setup()
    await call(ctx, CREATE)
    await call(ctx, { action: 'update', name: 'fix-flaky-test', body: 'v2' })
    await call(ctx, { action: 'delete', name: 'fix-flaky-test' })
    expect(changed).toHaveBeenCalledTimes(3)
    await call(ctx, { action: 'delete', name: 'fix-flaky-test' })
    expect(changed).toHaveBeenCalledTimes(3)
  })

  it('sanitizes tool-provided descriptions before writing', async () => {
    const { ctx } = await setup()
    await call(ctx, { ...CREATE, description: 'Keeps <script> and\ttabs  collapsed' })
    const raw = readFileSync(learnedSkillPath(homeDir, 'fix-flaky-test'), 'utf8')
    expect(raw).toContain('Keeps script and tabs collapsed')
    expect(raw).not.toContain('<script>')
  })

})
