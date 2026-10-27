/**
 * Package-shape pin for the official plugin distribution
 * (docs/plans/2026-09-07-official-agents-plugin.md §5.3): everything the
 * package declares in `files` exists on disk, and the nested CC manifest
 * stays in lockstep with the npm manifest — so the published artifact can
 * never silently lose a component the loader mounts. These agent files are
 * the single source of truth: the repo's workspace copies
 * (.claude/agents/deep-reasoner|fast-worker.md) were deleted in the
 * subagent-cleanup cutover, retiring the Output-contract drift guard that
 * used to compare the two.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const PKG_DIR = dirname(import.meta.dirname)

describe('packages/plugin/dsh-cc-agents package shape', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
    name: string
    version: string
    files: string[]
  }

  it('is the official plugin package with a publishable manifest', () => {
    expect(pkg.name).toBe('@dsh-cc/plugin-dsh-cc-agents')
    expect(pkg.private).not.toBe(true)
  })

  it('declares every shipped component in `files`, and each entry exists on disk', () => {
    expect(pkg.files).toEqual(expect.arrayContaining([
      '.claude-plugin/plugin.json',
      'agents',
      'hooks',
      'skills',
      'README.md',
    ]))
    for (const entry of pkg.files) {
      const path = join(PKG_DIR, entry)
      expect(existsSync(path), `files entry "${entry}" exists`).toBe(true)
      if (statSync(path).isDirectory()) {
        // A directory entry ships only when it is non-empty (npm pack drops
        // empty dirs) — so a lost agents/ or skills/ tree fails here.
        expect(readdirSync(path).length, `files dir "${entry}" non-empty`).toBeGreaterThan(0)
      }
    }
  })

  it('the agents directory holds all three agent definitions', () => {
    expect(existsSync(join(PKG_DIR, 'agents', 'critic.md'))).toBe(true)
    expect(existsSync(join(PKG_DIR, 'agents', 'executor.md'))).toBe(true)
    expect(existsSync(join(PKG_DIR, 'agents', 'marathon.md'))).toBe(true)
  })

  it('the hooks directory carries the serena gate trio and a valid hooks.json', () => {
    expect(existsSync(join(PKG_DIR, 'hooks', 'serena-gate.mjs'))).toBe(true)
    expect(existsSync(join(PKG_DIR, 'hooks', 'serena-remind.mjs'))).toBe(true)
    expect(existsSync(join(PKG_DIR, 'hooks', 'serena-session-cleanup.mjs'))).toBe(true)
    const hooksJson = JSON.parse(readFileSync(join(PKG_DIR, 'hooks', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, unknown>
    }
    expect(Object.keys(hooksJson.hooks).sort()).toEqual(['PreToolUse', 'SessionEnd'])
  })

  it('keeps the retired workspace shadow copies deleted (no dual existence)', () => {
    const repoRoot = join(PKG_DIR, '..', '..', '..')
    for (const name of ['deep-reasoner.md', 'fast-worker.md']) {
      expect(
        existsSync(join(repoRoot, '.claude', 'agents', name)),
        `${name} must NOT reappear under .claude/agents — the plugin copies are the single source of truth`,
      ).toBe(false)
    }
  })

  it('the skills directory holds the uniquely-named orchestration skill', () => {
    expect(existsSync(join(PKG_DIR, 'skills', 'dsh-cc-agents-orchestration', 'SKILL.md'))).toBe(true)
  })

  it('the nested plugin manifest is name/version lockstep with package.json', () => {
    const manifest = JSON.parse(
      readFileSync(join(PKG_DIR, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { name: string; version: string }
    expect(manifest.name).toBe('dsh-cc-agents')
    expect(manifest.version).toBe(pkg.version)
  })
})


describe('formal-design skill distribution', () => {
  const skill = join(PKG_DIR, 'skills/formal-design')
  const required = ['SKILL.md', 'references/modeling-guide.md', 'references/review-contract.md', 'references/agents-snippet.md',
    'references/lean-modeling-guide.md', 'references/lean-conformance.md', 'references/combined-models.md',
    'lean/Inspector.lean', 'lean/Driver.lean',
    'toolchain/tla2tools.jar', 'toolchain/LICENSE', 'toolchain/THIRD-PARTY-NOTICES.md',
    'toolchain/licenses/JAVAMAIL-EPL-2.0.txt', 'toolchain/licenses/ACTIVATION-APACHE-2.0.txt',
    'toolchain/licenses/ACTIVATION-NOTICE.txt', 'scripts/preflight.mjs', 'scripts/check.mjs', 'scripts/check-evidence.mjs', 'scripts/manifest.lib.mjs',
    'scripts/fingerprint.lib.mjs', 'scripts/process.lib.mjs', 'scripts/tlc-output.lib.mjs', 'scripts/toolchain.json',
    'scripts/lean-preflight.mjs', 'scripts/lean-check.mjs', 'scripts/lean-check-conformance.mjs', 'scripts/lean-check-evidence.mjs',
    'scripts/lean-provision.mjs', 'scripts/lean-manifest.lib.mjs', 'scripts/lean-fingerprint.lib.mjs', 'scripts/lean-process.lib.mjs',
    'scripts/lean-evidence.lib.mjs', 'scripts/lean-conformance.lib.mjs', 'scripts/lean-toolchain.json',
    'scripts/check-combined-evidence.mjs', 'scripts/bridge.lib.mjs',
    'examples/task-lifecycle/Model.tla', 'examples/task-lifecycle/checks.json', 'examples/task-lifecycle/design.md',
    'examples/task-lifecycle/workflow.md', 'examples/task-lifecycle/cases/small.cfg']
  it('ships the workflow entry, references, executable runner and example', () => {
    for (const file of required) expect(existsSync(join(skill, file)), file).toBe(true)
    const entry = readFileSync(join(skill, 'SKILL.md'), 'utf8')
    expect(entry).toMatch(/^---\nname: formal-design\ndescription: .+\n---/)
    expect(entry).toContain('${CLAUDE_SKILL_DIR}/scripts/preflight.mjs')
    expect(entry).toContain('${CLAUDE_SKILL_DIR}/scripts/check.mjs')
    expect(entry).toContain('${CLAUDE_SKILL_DIR}/scripts/check-evidence.mjs')
    expect(entry).toContain('${CLAUDE_SKILL_DIR}/scripts/lean-preflight.mjs')
    expect(entry).toContain('${CLAUDE_SKILL_DIR}/scripts/lean-check.mjs')
    expect(entry).toContain('${CLAUDE_SKILL_DIR}/scripts/lean-check-conformance.mjs')
    expect(entry).toContain('${CLAUDE_SKILL_DIR}/scripts/lean-check-evidence.mjs')
    expect(entry).toContain('${CLAUDE_SKILL_DIR}/scripts/check-combined-evidence.mjs')
  })
  it('includes the complete skill tree in the actual npm publish manifest', () => {
    const pack = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: PKG_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0]
    const packed = new Set(pack.files.map((f: { path: string }) => f.path))
    const walk = (dir: string, prefix = ''): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name), prefix + e.name + '/') : [prefix + e.name])
    for (const file of walk(skill)) expect(packed.has(`skills/formal-design/${file}`), file).toBe(true)
    for (const file of required) expect(packed.has(`skills/formal-design/${file}`), file).toBe(true)
    expect(readdirSync(join(skill, 'scripts')).every(f => !statSync(join(skill, 'scripts', f)).isDirectory())).toBe(true)
  })
})


it('ships the exact upstream TLC bytes pinned by toolchain.json', () => {
  const skill = join(PKG_DIR, 'skills/formal-design')
  const pin = JSON.parse(readFileSync(join(skill, 'scripts/toolchain.json'), 'utf8'))
  const bytes = readFileSync(join(skill, 'toolchain/tla2tools.jar'))
  expect(createHash('sha1').update(bytes).digest('hex')).toBe(pin.sha1)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88')
})
