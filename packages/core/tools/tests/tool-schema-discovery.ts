import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

export function isPackageSourcePath(path: string): boolean {
  return path.split(/[\\/]/).slice(0, -1).includes('src')
}

/** Inspect calls, rather than matching examples in comments or strings. */
function hasToolRegistration(source: string, file: string): boolean {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node): boolean => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee) && callee.text === 'defineTool') return true
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'register') {
        const receiver = callee.expression
        if ((ts.isIdentifier(receiver) && receiver.text === 'tools')
          || (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'tools')) return true
      }
    }
    return ts.forEachChild(node, visit) ?? false
  }
  return visit(ast)
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
      if (!hasToolRegistration(source, full)) continue
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

