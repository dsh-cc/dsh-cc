/**
 * Tests for the bridge-lane library generator.
 *
 * The gate's job is to keep two committed copies of a security-relevant
 * parser honest against one authored source. These cases pin the failure
 * modes that would otherwise let drift through: a hand-edited copy, a copy
 * that lost its GENERATED banner, a missing copy, a stale copy after a source
 * edit, and an incomplete authored tree (which must fail loudly instead of
 * silently generating from a partial source).
 *
 * Every mutation case runs against a SYNTHETIC root under the temp dir — a
 * gate's own test must never mutate the repository it gates. The real tree is
 * only ever read, by the read-only assertions at the top.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { LANES, SHARED_MODULES, banner, expectedCopy, run, sourceDir, targetDirs } from './generate-bridge-lane-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')
const SCRIPT = join(HERE, 'generate-bridge-lane-lib.mjs')

/**
 * Build a synthetic repository root: an authored source tree plus one
 * generated copy per lane, produced by the generator itself.
 * @returns the temp root path.
 */
function syntheticRoot() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-lane-'))
  mkdirSync(sourceDir(root), { recursive: true })
  writeFileSync(join(sourceDir(root), 'lane.mjs'), 'export const LANE = { name: "fixture-lane" }\n')
  for (const module of SHARED_MODULES) {
    writeFileSync(join(sourceDir(root), module), `// authored ${module}\nexport const tag = '${module}'\n`)
  }
  for (const target of targetDirs(root)) mkdirSync(target.dir, { recursive: true })
  assert.equal(run({ write: true, root }).length, SHARED_MODULES.length * LANES.length)
  return root
}

const roots = []
/**
 * A synthetic root that is cleaned up after the suite.
 * @returns the root path.
 */
function fixture() {
  const root = syntheticRoot()
  roots.push(root)
  return root
}

after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('generate-bridge-lane-lib (committed tree, read-only)', () => {
  it('the authored tree carries a lane.mjs the modules can import', () => {
    assert.match(readFileSync(join(sourceDir(REPO_ROOT), 'lane.mjs'), 'utf8'), /export const LANE/)
  })

  it('every committed copy is exactly banner + authored source', () => {
    for (const module of SHARED_MODULES) {
      const expected = expectedCopy(module, REPO_ROOT)
      assert.equal(expected, banner(module) + readFileSync(join(sourceDir(REPO_ROOT), module), 'utf8'))
      for (const target of targetDirs(REPO_ROOT)) {
        assert.equal(readFileSync(join(target.dir, module), 'utf8'), expected, `${target.name}/${module}`)
      }
    }
  })

  it('--check is clean on the committed tree', () => {
    assert.deepEqual(run({ write: false }), [])
  })

  it('--check is clean from a foreign cwd (CI invokes it by absolute path)', () => {
    execFileSync(process.execPath, [SCRIPT, '--check'], { cwd: tmpdir(), encoding: 'utf8', stdio: 'pipe' })
  })
})

describe('generate-bridge-lane-lib (drift detection, synthetic tree)', () => {
  it('reports and never rewrites a hand-edited copy', () => {
    const root = fixture()
    const victim = join(targetDirs(root)[0].dir, 'lexer.mjs')
    writeFileSync(victim, `${readFileSync(victim, 'utf8')}\n// hand-edited\n`)
    const drift = run({ write: false, root })
    assert.equal(drift.length, 1)
    assert.match(drift[0], /stale/)
    assert.match(readFileSync(victim, 'utf8'), /hand-edited/, '--check must not write')
  })

  it('reports a copy that lost its GENERATED banner', () => {
    const root = fixture()
    const victim = join(targetDirs(root)[1].dir, 'argv.mjs')
    writeFileSync(victim, readFileSync(victim, 'utf8').replace(banner('argv.mjs'), ''))
    assert.equal(run({ write: false, root }).length, 1)
  })

  it('reports a missing copy, and write restores it byte-exactly', () => {
    const root = fixture()
    const victim = join(targetDirs(root)[1].dir, 'canonical.mjs')
    rmSync(victim)
    const drift = run({ write: false, root })
    assert.equal(drift.length, 1)
    assert.match(drift[0], /missing/)
    assert.equal(run({ write: true, root }).length, 1)
    assert.equal(readFileSync(victim, 'utf8'), expectedCopy('canonical.mjs', root))
  })

  it('a source edit without regeneration shows up as drift on every lane', () => {
    const root = fixture()
    const source = join(sourceDir(root), 'argv.mjs')
    writeFileSync(source, `${readFileSync(source, 'utf8')}// tightened\n`)
    const drift = run({ write: false, root })
    assert.equal(drift.length, LANES.length)
    assert.equal(run({ write: true, root }).length, LANES.length)
    assert.deepEqual(run({ write: false, root }), [])
  })

  it('banner() names the authored source and the regeneration command', () => {
    const text = banner('lexer.mjs')
    assert.match(text, /GENERATED FILE — do not edit/)
    assert.match(text, /scripts\/lib\/bridge-lane\/lexer\.mjs/)
    assert.match(text, /node scripts\/generate-bridge-lane-lib\.mjs/)
  })

  it('an incomplete authored tree fails loudly instead of generating from partial source', () => {
    const root = fixture()
    rmSync(join(sourceDir(root), 'lane.mjs'))
    assert.throws(() => run({ write: false, root }), /missing .*lane\.mjs/)
    assert.throws(() => run({ write: true, root }), /missing .*lane\.mjs/)
  })
})

describe('generate-bridge-lane-lib CLI', () => {
  it('exits non-zero on drift and zero once regenerated', () => {
    // The CLI always targets the real repository root, so this case is the
    // only one allowed to write there: it mutates one copy and the generator
    // immediately restores it from the committed source.
    const victim = join(targetDirs(REPO_ROOT)[0].dir, 'argv.mjs')
    const pristine = readFileSync(victim, 'utf8')
    try {
      writeFileSync(victim, 'export {}\n')
      assert.throws(() => execFileSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8', stdio: 'pipe' }))
      execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8', stdio: 'pipe' })
      execFileSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8', stdio: 'pipe' })
      assert.equal(readFileSync(victim, 'utf8'), pristine)
    } finally {
      writeFileSync(victim, pristine)
    }
  })

  it('an unknown argument is a usage error, not a silent write', () => {
    assert.throws(() => execFileSync(process.execPath, [SCRIPT, '--wrote'], { encoding: 'utf8', stdio: 'pipe' }))
  })

  it('the committed copies exist (the gate is not vacuously clean)', () => {
    for (const target of targetDirs(REPO_ROOT)) {
      for (const module of SHARED_MODULES) assert.ok(existsSync(join(target.dir, module)), `${target.name}/${module}`)
    }
  })
})
