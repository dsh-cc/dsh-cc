/**
 * Materialize the shared bridge-lane library into both bridge plugins.
 *
 * The two CC-plugin packages (`cc-codex-bridge`, `cc-grok-bridge`) each ship a
 * `scripts/lib/` tree and are installed as plain copied directories — there is
 * no build step, no dependency install, and no `node_modules` in the plugin
 * cache. So a shared implementation cannot be a package dependency: the only
 * self-contained form is a committed copy in each tarball.
 *
 * This generator keeps those copies honest. `scripts/lib/bridge-lane/` is the
 * single AUTHORED source; the three modules are written into each plugin with
 * a GENERATED banner that names the source. Each plugin's own `lane.mjs` is
 * hand-written (it holds nothing but that lane's names and text) and is never
 * touched here.
 *
 * Usage:
 *   node scripts/generate-bridge-lane-lib.mjs           # write the copies
 *   node scripts/generate-bridge-lane-lib.mjs --check   # fail on any drift
 *
 * `--check` runs in pre-commit and presubmit: editing a generated copy, or
 * editing the source without regenerating, fails the gate.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')

/** Modules copied verbatim (banner aside) into every lane. */
export const SHARED_MODULES = ['lexer.mjs', 'argv.mjs', 'canonical.mjs']

/** The lane directory names that receive a copy. */
export const LANES = ['cc-codex-bridge', 'cc-grok-bridge']

/** The authored source directory for a repository root. */
export const sourceDir = (root) => join(root, 'scripts', 'lib', 'bridge-lane')

/** The generated-copy directory of each lane, for a repository root. */
export const targetDirs = (root) => LANES.map(name => ({
  name,
  dir: join(root, 'packages', 'plugin', name, 'scripts', 'lib'),
}))

/**
 * The banner every generated copy starts with. It is the whole difference
 * between a generated copy and the authored source, so `--check` compares
 * `banner + source` byte for byte.
 * @param module - the module file name, e.g. `argv.mjs`.
 * @returns the banner text, newline-terminated.
 */
export function banner(module) {
  return [
    `// GENERATED FILE — do not edit. Source: scripts/lib/bridge-lane/${module}`,
    '// Regenerate: node scripts/generate-bridge-lane-lib.mjs',
    '',
  ].join('\n')
}

/** The exact bytes a generated copy must contain. */
export function expectedCopy(module, root = REPO_ROOT) {
  return banner(module) + readFileSync(join(sourceDir(root), module), 'utf8')
}

/**
 * Compare (and optionally rewrite) the generated copies.
 * @param options - `write` materializes; `root` retargets the whole tree (the
 * gate's own tests build a synthetic root so they never touch the repository).
 * @returns the drift messages, empty when everything matches.
 */
export function run({ write = false, root = REPO_ROOT } = {}) {
  const source = sourceDir(root)
  if (!existsSync(join(source, 'lane.mjs'))) {
    // The authored tree must be self-consistent: its modules import ./lane.mjs.
    throw new Error(`generate-bridge-lane-lib: missing ${join(source, 'lane.mjs')} — the authored library imports it, so the source tree is incomplete`)
  }
  const drift = []
  for (const module of SHARED_MODULES) {
    const expected = expectedCopy(module, root)
    for (const target of targetDirs(root)) {
      const path = join(target.dir, module)
      const actual = existsSync(path) ? readFileSync(path, 'utf8') : null
      if (actual === expected) continue
      const where = relative(root, path)
      if (write) {
        mkdirSync(target.dir, { recursive: true })
        writeFileSync(path, expected)
        drift.push(`wrote ${where}`)
      } else {
        drift.push(actual === null
          ? `missing ${where}`
          : `stale ${where} (differs from scripts/lib/bridge-lane/${module})`)
      }
    }
  }
  return drift
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const write = !process.argv.includes('--check')
  const unknown = process.argv.slice(2).filter((arg) => arg !== '--check')
  if (unknown.length > 0) {
    console.error(`generate-bridge-lane-lib: unknown argument(s) ${unknown.join(' ')} — use no arguments to write, or --check`)
    process.exit(2)
  }
  const drift = run({ write })
  if (write) {
    console.log(drift.length === 0
      ? 'generate-bridge-lane-lib: copies already up to date'
      : `generate-bridge-lane-lib: ${drift.length} file(s) written`)
    if (drift.length > 0) for (const line of drift) console.log(`  ${line}`)
    process.exit(0)
  }
  if (drift.length === 0) {
    console.log(`generate-bridge-lane-lib --check OK — ${SHARED_MODULES.length} modules × ${LANES.length} lanes in sync`)
    process.exit(0)
  }
  console.error('generate-bridge-lane-lib --check FAILED:')
  for (const line of drift) console.error(`  ${line}`)
  console.error('  edit scripts/lib/bridge-lane/ and run `node scripts/generate-bridge-lane-lib.mjs`,')
  console.error('  or revert the generated copy — hand-editing a GENERATED FILE always loses.')
  process.exit(1)
}
