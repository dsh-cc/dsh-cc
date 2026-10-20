import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

export function isPackageSourcePath(path: string): boolean {
  return path.split(/[\\/]/).slice(0, -1).includes('src')
}

/** Inspect calls, rather than matching examples in comments or strings. */
function countToolRegistrations(source: string, file: string): number {
  let count = 0
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee) && callee.text === 'defineTool') count++
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'register') {
        const receiver = callee.expression
        if ((ts.isIdentifier(receiver) && receiver.text === 'tools')
          || (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'tools')) count++
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return count
}

/** All first-party packages whose src uses defineTool(/tools.register(. */
export function findToolPackages(repoRoot: string, manifest: ReadonlySet<string>, excluded: Readonly<Record<string, string>>): string[] {
  const pkgRoot = join(repoRoot, 'packages')
  const offenders = new Set<string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts') || entry.name.endsWith('.d.ts')) continue
      if (!isPackageSourcePath(full.slice(pkgRoot.length))) continue
      const source = readFileSync(full, 'utf8')
      if (!countToolRegistrations(source, full)) continue
      const pkg = owningPackageName(full)
      if (pkg !== undefined && !manifest.has(pkg) && !(pkg in excluded)) offenders.add(pkg)
    }
  }
  walk(pkgRoot)
  return [...offenders].sort()
}

/** Name of the nearest enclosing package.json, or undefined outside one. */
function owningPackageName(file: string): string | undefined {
  let dir = file
  for (;;) {
    const parent = join(dir, '..')
    if (parent === dir) return undefined
    dir = parent
    try {
      return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name as string
    } catch {
      // No package.json at this level; keep walking up.
    }
  }
}


/** Fail closed on added/removed call sites, even inside a surveyed package.
 * The inventory includes exact counts for excluded utility/passthrough files;
 * an exclusion can never silently extend to another file in the same package.
 */
export function findUncoveredToolSources(repoRoot: string, inventory: Readonly<Record<string, number>>): string[] {
  const actual: Record<string, number> = {}
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'lib', 'dist'].includes(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      const path = relative(repoRoot, full).split(/[/\\]/).join('/')
      if (!path.endsWith('.ts') || path.endsWith('.spec.ts') || path.endsWith('.d.ts') || !isPackageSourcePath(path)) continue
      const count = countToolRegistrations(readFileSync(full, 'utf8'), full)
      if (count > 0) actual[path] = count
    }
  }
  walk(join(repoRoot, 'packages'))
  return [...new Set([...Object.keys(actual), ...Object.keys(inventory)])].sort().flatMap(path => {
    const expected = inventory[path] ?? 0
    const found = actual[path] ?? 0
    return expected === found ? [] : [`${path}: expected ${expected} registration calls, found ${found}`]
  })
}
