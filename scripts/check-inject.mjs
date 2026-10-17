#!/usr/bin/env node
/**
 * check-inject.mjs — a cordis plugin that reads `ctx.<service>` must declare
 * that service in its `export const inject`.
 *
 * Why: cordis throws `cannot get property "<svc>" without inject` on the
 * plugin's own context at runtime, but hand-built test contexts (root ctx
 * with the service mounted) never exercise the guard — only a real preset
 * boot does (#140: advisor-watchdog / prompt-suggest called
 * `runSideQuery(ctx)` → `ctx.llm` with no inject; every side query failed
 * in ~2ms while all tests stayed green).
 *
 * How (TypeScript AST, so comments/strings/types never match):
 *   - plugin entry = packages/<group>/<pkg>/src/index.ts exporting `apply`;
 *   - declared = string elements of `export const inject = [...]`, or keys of
 *     an object-form inject;
 *   - used = every `ctx.<svc>` / `this.ctx.<svc>` property read in the
 *     package's src/** (value positions only), plus `runSideQuery(ctx, …)`
 *     which reads `ctx.llm`;
 *   - services checked: the cordis-guarded harness services below. Reads via
 *     `ctx.get('<svc>')` are the sanctioned optional path and never flagged.
 *
 * Not flagged: a function wrapped as `Object.assign(fn, { inject: [...] })`
 * reading services it declares itself; sub-directories with their own
 * `index.ts` inject (separate client plugin entries).
 *
 * Escape hatch (reviewed, never silent): a line
 *     // check-inject-ignore: <svc> — <reason>
 * in the source file exempts that one service for that file.
 *
 * Usage: node scripts/check-inject.mjs [repo-root]
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const SERVICES = ['llm', 'settings', 'ccModelRoutes', 'sessions', 'systemPrompt', 'tools', 'hooks', 'shell', 'fs', 'permissions']

const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

/** Declared inject list of an entry module, or null when it does not export `apply`. */
export function readEntry(file, text) {
  const sf = parse(file, text)
  let hasApply = false
  let declared = []
  const isExported = (n) => ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === 'apply' && isExported(st)) hasApply = true
    if (ts.isVariableStatement(st) && isExported(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue
        if (d.name.text === 'apply') hasApply = true
        if (d.name.text !== 'inject' || !d.initializer) continue
        let init = d.initializer
        while (ts.isAsExpression(init) || ts.isSatisfiesExpression?.(init) || ts.isParenthesizedExpression(init)) init = init.expression
        if (ts.isArrayLiteralExpression(init)) declared = init.elements.filter(ts.isStringLiteralLike).map((e) => e.text)
        else if (ts.isObjectLiteralExpression(init)) {
          for (const p of init.properties) {
            const key = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : undefined
            if (!key) continue
            // { required: [...], optional: [...] } form
            if ((key === 'required' || key === 'optional') && ts.isPropertyAssignment(p) && ts.isArrayLiteralExpression(p.initializer)) {
              declared.push(...p.initializer.elements.filter(ts.isStringLiteralLike).map((e) => e.text))
            } else declared.push(key)
          }
        }
      }
    }
  }
  if (!hasApply) return null
  return { declared }
}

const isCtx = (e) =>
  (ts.isIdentifier(e) && e.text === 'ctx') ||
  (ts.isPropertyAccessExpression(e) && e.expression.kind === ts.SyntaxKind.ThisKeyword && e.name.text === 'ctx')

/** String elements of an `inject` array literal, or keys of an object-form inject. */
function injectNames(init) {
  while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression
  if (ts.isArrayLiteralExpression(init)) return init.elements.filter(ts.isStringLiteralLike).map((e) => e.text)
  return []
}

/**
 * Services read as `ctx.<svc>` (value positions) in one source text, with
 * line numbers. A function wrapped as `Object.assign(fn, { inject: [...] })`
 * (cordis per-installer inject, e.g. invariant companions) may read the
 * services it declares itself. `// check-inject-ignore: <svc>` in the file
 * exempts that service for the file.
 */
export function usedServices(file, text) {
  const sf = parse(file, text)
  const ignored = new Set([...text.matchAll(/\/\/\s*check-inject-ignore:\s*(\w+)/g)].map((m) => m[1]))
  const used = new Map()
  const add = (svc, node, local) => {
    if (local.has(svc) || ignored.has(svc) || used.has(svc)) return
    used.set(svc, sf.getLineAndCharacterOfPosition(node.getStart()).line + 1)
  }
  const visit = (n, local) => {
    if (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) return
    if (ts.isPropertyAccessExpression(n) && isCtx(n.expression) && SERVICES.includes(n.name.text)) add(n.name.text, n, local)
    if (ts.isCallExpression(n)) {
      if (ts.isIdentifier(n.expression) && n.expression.text === 'runSideQuery' && n.arguments[0] && isCtx(n.arguments[0])) add('llm', n, local)
      const callee = n.expression
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'Object'
        && callee.name.text === 'assign' && n.arguments.length === 2 && ts.isObjectLiteralExpression(n.arguments[1])) {
        const injectProp = n.arguments[1].properties.find((p) => ts.isPropertyAssignment(p) && p.name && ts.isIdentifier(p.name) && p.name.text === 'inject')
        if (injectProp) {
          const inner = new Set([...local, ...injectNames(injectProp.initializer)])
          visit(n.arguments[0], inner)
          visit(n.arguments[1], local)
          return
        }
      }
    }
    ts.forEachChild(n, (c) => visit(c, local))
  }
  visit(sf, new Set())
  return used
}

/** Source files of one plugin: src/** minus sub-directories that are their own plugin entry (e.g. src/client/). */
function* pluginFiles(srcDir) {
  for (const e of readdirSync(srcDir)) {
    const p = join(srcDir, e)
    if (statSync(p).isDirectory()) {
      const sub = join(p, 'index.ts')
      if (existsSync(sub) && /export const inject\b/.test(readFileSync(sub, 'utf8'))) continue
      yield* pluginFiles(p)
    } else if (/\.(m|c)?tsx?$/.test(e) && !/\.d\.ts$/.test(e)) yield p
  }
}

export function checkRepo(root) {
  const problems = []
  let entries = 0
  const pk = join(root, 'packages')
  for (const group of readdirSync(pk).sort()) {
    if (!statSync(join(pk, group)).isDirectory()) continue
    for (const name of readdirSync(join(pk, group)).sort()) {
      const index = join(pk, group, name, 'src', 'index.ts')
      if (!existsSync(index)) continue
      const entry = readEntry(index, readFileSync(index, 'utf8'))
      if (!entry) continue
      entries++
      const missing = new Map()
      for (const f of pluginFiles(join(pk, group, name, 'src'))) {
        for (const [svc, line] of usedServices(f, readFileSync(f, 'utf8'))) {
          if (entry.declared.includes(svc) || missing.has(svc)) continue
          missing.set(svc, `${relative(root, f)}:${line}`)
        }
      }
      for (const [svc, at] of missing) {
        problems.push(`${relative(root, index)}: reads ctx.${svc} (${at}) but \`export const inject\` does not list '${svc}'`)
      }
    }
  }
  return { entries, problems }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..')
  const { entries, problems } = checkRepo(root)
  for (const p of problems) console.error(`check-inject: ${p}`)
  if (problems.length) {
    console.error('  fix: add the service to `export const inject` (cordis guards ctx.<svc> on the plugin context),')
    console.error("  or read it optionally via ctx.get('<svc>'), or add a reviewed `// check-inject-ignore: <svc> — <reason>`.")
    process.exit(1)
  }
  console.log(`check-inject: OK (${entries} plugin entries)`)
}
