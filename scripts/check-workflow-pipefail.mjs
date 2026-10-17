#!/usr/bin/env node
/**
 * check-workflow-pipefail.mjs — every GitHub Actions workflow must run its
 * `run:` steps under pipefail.
 *
 * Why: without an explicit `shell:`, GitHub runs steps as `bash -e {0}` —
 * NO pipefail — so `vitest run ... | tee log` exits with tee's status and a
 * red test run reports green (found during the v0.9.1 publish fix, #246).
 * `shell: bash` maps to `bash --noprofile --norc -eo pipefail {0}`.
 *
 * Rules (pure line scan, no node_modules — runs in the static prefix):
 *   1. each .github/workflows/*.yml has a top-level
 *        defaults:
 *          run:
 *            shell: bash
 *   2. a step that overrides `shell:` to anything other than bash and
 *      whose `run:` contains a pipe must `set -o pipefail` itself.
 *
 * Usage: node scripts/check-workflow-pipefail.mjs [repo-root]
 * Exit 1 with file:line for each violation.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..')

export function checkWorkflow(name, text) {
  const out = []
  if (!/^defaults:[ \t]*\n[ \t]+run:[ \t]*\n[ \t]+shell:[ \t]*bash[ \t]*(#.*)?$/m.test(text)) {
    out.push(`${name}: missing top-level \`defaults: run: shell: bash\` (default GHA shell has no pipefail)`)
  }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(-\s+)?run:\s*([|>][-+]?)?(.*)$/)
    if (!m) continue
    const ind = m[1].length
    const body = [m[4]]
    let j = i + 1
    if (m[3]) while (j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > ind)) body.push(lines[j++])
    // step boundaries: scan back to the `- ` that opens this step, forward to the next sibling key block end
    let s = i
    while (s > 0 && !/^\s*-\s/.test(lines[s])) s--
    let e = j
    while (e < lines.length && lines[e].trim() !== '' && !/^\s*-\s/.test(lines[e]) && lines[e].search(/\S/) >= ind - (m[2] ? 0 : 0)) e++
    const step = lines.slice(s, e).join('\n')
    const shell = step.match(/^\s*shell:\s*(\S+)/m)?.[1]
    const code = body.join('\n').replace(/(^|\s)#.*$/gm, '')
    const pipes = /(^|[^|])\|(?!\|)/.test(code.replace(/'[^'\n]*'|"[^"\n]*"/g, "''"))
    if (shell && shell !== 'bash' && pipes && !/pipefail/.test(code)) {
      out.push(`${name}:${i + 1}: step uses shell: ${shell} with a pipe but no \`set -o pipefail\``)
    }
  }
  return out
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const dir = join(root, '.github', 'workflows')
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()
  const problems = files.flatMap((f) => checkWorkflow(f, readFileSync(join(dir, f), 'utf8')))
  for (const p of problems) console.error(`check-workflow-pipefail: ${p}`)
  if (problems.length) process.exit(1)
  console.log(`check-workflow-pipefail: OK (${files.length} workflows, all run steps under pipefail)`)
}
