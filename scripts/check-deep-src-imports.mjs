#!/usr/bin/env node
/**
 * check-deep-src-imports.mjs — presubmit gate: no package's published source
 * may import across package boundaries into another workspace package's src/
 * tree (e.g. `@dsh-cc/foo/src/bar.ts`).
 *
 * Why: tsc preserves such specifiers verbatim in the lib/ emit. In dev they
 * resolve through tsconfig paths, but at runtime Node must load the raw .ts
 * file under node_modules — and Node's type stripping is disabled there
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so the plugin tree fails to
 * boot. Cross-package imports must go through the package root's exports.
 *
 * Model: scan every packages/<group>/<pkg>/src/**.ts for import/export
 * specifiers matching `@<scope>/<pkg>/src/`. Tests are excluded: they never
 * ship into a runtime composition and always resolve through vitest's
 * tsconfig-paths alias. Exit 1 with one diagnostic per offending file.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = join(ROOT, 'packages')

/** Matches cross-package specifiers that reach into a package's src tree. */
const DEEP_SRC = /from\s+['"]@[\w-]+\/[\w-]+\/src\//g

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'lib') continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) yield p
  }
}

const problems = []
for (const group of readdirSync(PACKAGES)) {
  const groupDir = join(PACKAGES, group)
  if (!statSync(groupDir).isDirectory()) continue
  for (const pkg of readdirSync(groupDir)) {
    const pkgDir = join(groupDir, pkg)
    if (!statSync(pkgDir).isDirectory()) continue
    const srcDir = join(pkgDir, 'src')
    try {
      if (!statSync(srcDir).isDirectory()) continue
    } catch {
      continue
    }
    for (const file of walk(srcDir)) {
      const text = readFileSync(file, 'utf8')
      if (DEEP_SRC.test(text)) problems.push(relative(ROOT, file))
      DEEP_SRC.lastIndex = 0
    }
  }
}

if (problems.length > 0) {
  console.error('check:deep-imports — cross-package imports into a src/ tree (import the package root instead):\n')
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
