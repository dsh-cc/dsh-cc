/**
 * Tool-ordering composition contract (migration slice S5 / design D5).
 *
 * Harness 0.2.2-rc.1 moved tool ordering into host `SystemPrompt` constructor
 * state: `orderTools` canonicalizes the collected catalog BEFORE the assemble
 * waterfall, so the retired `@dsh-cc/tool-append-order` plugin (a waterfall
 * listener) has no seam left. `packages/bundle/cc-shell/cordis.patch.yml`
 * therefore restates dsh-base's `system-prompt` row at TOP LEVEL — a plain
 * same-id restate, NOT disabled — carrying the base row's config plus
 * `toolOrder`:
 *
 *   listed names render in this order (the frozen always-registered catalog,
 *   captured from a green `smoke:profile-boot`), and `<unlisted-tools>`
 *   terminates the list so everything else (MCP tools, `ToolSearch`,
 *   conditionally admitted tools such as `exit_plan_mode`) renders after it,
 *   re-sorted lexicographically on every assembly.
 *
 * `tests/fixtures/cc-tool-order.json` is the source of truth for that yml list;
 * this spec keeps the two in lockstep and pins the invariants that make the
 * list safe (one rest marker, no duplicates, registered-only names, no
 * environment-dependent MCP names).
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const req = createRequire(import.meta.url)
const includePkg = req.resolve('@deepseek-ai/cordis-plugin-include/package.json')
const yaml = createRequire(includePkg)('js-yaml') as typeof import('js-yaml')

const patchPath = new URL('../../../bundle/cc-shell/cordis.patch.yml', import.meta.url).pathname
const sharedPath = new URL('../agent.shared.cordis.yml', import.meta.url).pathname
const fixturePath = new URL('./fixtures/cc-tool-order.json', import.meta.url).pathname

const patchRows = yaml.load(readFileSync(patchPath, 'utf8'), { schema: entryListSchema }) as any[]
const sharedRows = yaml.load(readFileSync(sharedPath, 'utf8'), { schema: entryListSchema }) as any[]
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as string[]

/** The ONE rest marker the harness reserves for unlisted tools. */
const REST = '<unlisted-tools>'

/** The host `system-prompt` row, as the top-level restatement. */
const systemPromptRow = patchRows.find((row) => row.id === 'system-prompt' && !Array.isArray(row.insert))

/** Code-unit comparison: the `orderTools` baseline is locale-independent. */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Locate the linked upstream checkout's file for `relative`, walking up from
 * the include plugin's realpath (composition.spec precedent: never a relative
 * path, which breaks in a worktree layout).
 */
function upstreamFile(relative: string): string | undefined {
  let cur = dirname(realpathSync(includePkg))
  for (let i = 0; i < 5; i++) {
    const candidate = join(cur, relative)
    if (existsSync(candidate)) return candidate
    cur = dirname(cur)
  }
  return undefined
}

describe('cc-shell system-prompt restatement', () => {
  it('restates the host row at TOP LEVEL (never inside an insert list)', () => {
    expect(systemPromptRow, 'top-level `id: system-prompt` row missing').toBeDefined()
    const inInsert = patchRows.some(
      (row) => Array.isArray(row.insert) && row.insert.some((child: any) => child.id === 'system-prompt'),
    )
    expect(inInsert, 'a second loader entry with this id would hard-fail boot').toBe(false)
  })

  it('is a live row: `disabled: true` would unload the host SystemPrompt service', () => {
    expect(systemPromptRow.disabled).toBeUndefined()
    expect(systemPromptRow.name).toBe('@deepseek-ai/dsh-system-prompt')
  })

  it('carries the base row config verbatim plus toolOrder', () => {
    // dsh-base's row is `{ personaPrefix: '' }`; the restate must not drop it.
    expect(systemPromptRow.config.personaPrefix).toBe('')
    expect(Array.isArray(systemPromptRow.config.toolOrder)).toBe(true)
  })

  it('keeps the yml list identical to the captured fixture (its source of truth)', () => {
    expect(systemPromptRow.config.toolOrder).toEqual(fixture)
  })
})

describe('captured catalog invariants', () => {
  it('terminates with exactly one rest marker', () => {
    expect(fixture.filter(name => name === REST)).toHaveLength(1)
    expect(fixture.at(-1)).toBe(REST)
  })

  it('lists every name once and in the captured (lexicographic) order', () => {
    const listed = fixture.filter(name => name !== REST)
    expect(new Set(listed).size).toBe(listed.length)
    // The pre-migration wire order was `orderTools`' lexicographic sort, so the
    // frozen prefix reproduces today's request prefix byte-for-byte.
    expect(listed).toEqual([...listed].sort(compareNames))
  })

  it('never lists environment-dependent MCP tools (a missing server would reject every assembly)', () => {
    expect(fixture.filter(name => name.startsWith('mcp__'))).toEqual([])
  })

  it('never lists tools that are conditionally registered or bundle-specific', () => {
    // `exit_plan_mode` is registered with `{ when }` (plan-mode admission), and
    // `ToolSearch` is mounted by the tui bundle row only — both belong to the
    // rest bucket, not the static prefix.
    expect(fixture).not.toContain('exit_plan_mode')
    expect(fixture).not.toContain('ToolSearch')
  })

  it('keeps the CC surface that defines the catalog', () => {
    // Spot-pins so a silent fixture truncation cannot pass as "no churn".
    for (const name of ['bash', 'read', 'edit', 'write', 'glob', 'grep', 'todo_write', 'list_agents']) {
      expect(fixture).toContain(name)
    }
  })
})

describe('tool-fs applyPatch stays at the upstream default (D6)', () => {
  it('the shared preset body states applyPatch: false — the upstream default, no patch tool', () => {
    const row = sharedRows.find((r) => r.id === 'tool-fs')!
    expect(row.name).toBe('@deepseek-ai/dsh-tool-fs')
    // Harness 0.2.2-rc.1's standard preset row declares the default explicitly
    // and the composition drift gate compares rows verbatim, so CC states it
    // too. Any other value would add a catalog tool CC does not want.
    expect(row.config).toEqual({ applyPatch: false })
  })

  it('upstream defaults applyPatch to false, so no `apply_patch` reaches the catalog', () => {
    const source = upstreamFile(join('packages', 'fs', 'tool-fs', 'src', 'index.ts'))
    expect(source, 'linked upstream checkout not found for the tool-fs drift anchor').toBeDefined()
    const text = readFileSync(source!, 'utf8')
    expect(text).toMatch(/applyPatch\?: boolean/)
    expect(text).toMatch(/applyPatch: z\.boolean\(\)\.default\(false\)/)
    // The captured catalog (fixture) is what the model sees: no patch tool there.
    expect(fixture).not.toContain('apply_patch')
  })
})
