#!/usr/bin/env node
/**
 * check-model-literals.mjs — concrete model ids live only in the alias
 * registry; everything else names an alias (haiku / sonnet / opus / gauge …).
 *
 * Why: a hard-coded `deepseek-v4-flash` / `llmbox_*\/…` in a plugin silently
 * pins one backend, bypasses user routing (`ccModelRoutes`) and rots when
 * the registry moves.
 *
 * Scope: string literals (TypeScript AST — comments never match) in
 * packages/<group>/<pkg>/src/**\/*.ts. Allowed homes:
 *   - packages/compat/cc-model-aliases/**   (the registry itself)
 *   - packages/ui/tui/src/provider-presets.ts (provider catalogs shown to users)
 *   - packages/test-support/**              (fixtures / mock runs)
 *
 * Usage: node scripts/check-model-literals.mjs [repo-root]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const ALLOW = [
  /^packages\/compat\/cc-model-aliases\//,
  /^packages\/ui\/tui\/src\/provider-presets\.ts$/,
  /^packages\/test-support\//,
]

export const MODEL_ID =
  /^(?:llmbox_[a-z0-9]+\/[\w.-]+|claude-(?:3|4|opus|sonnet|haiku)[\w.-]*|gpt-[45][\w.-]*|o[134](?:-mini|-pro)?|deepseek-(?:chat|reasoner|v\d)[\w.-]*|glm-\d[\w.-]*|gemini-\d[\w.-]*|grok-\d[\w.-]*)$/

/** Model-id string literals in one TS source text: [{ line, text }]. */
export function findModelLiterals(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const hits = []
  const visit = (n) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && MODEL_ID.test(n.text)) {
      hits.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: n.text })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return hits
}

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'lib') continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (/\.(m|c)?tsx?$/.test(e) && !/\.d\.ts$/.test(e)) yield p
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..')
  const problems = []
  let files = 0
  for (const f of walk(join(root, 'packages'))) {
    const rel = relative(root, f).split(sep).join('/')
    if (!/^packages\/[^/]+\/[^/]+\/src\//.test(rel) || ALLOW.some((re) => re.test(rel))) continue
    files++
    for (const h of findModelLiterals(f, readFileSync(f, 'utf8'))) problems.push(`${rel}:${h.line}: '${h.text}'`)
  }
  for (const p of problems) console.error(`check-model-literals: ${p}`)
  if (problems.length) {
    console.error('  concrete model ids belong in packages/compat/cc-model-aliases; reference an alias instead.')
    process.exit(1)
  }
  console.log(`check-model-literals: OK (${files} source files, no concrete model ids outside the alias registry)`)
}
