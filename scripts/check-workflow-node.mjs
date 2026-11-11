#!/usr/bin/env node
/**
 * check-workflow-node.mjs — every workflow pins the Node runtime explicitly,
 * and every literal it pins is a line this repo has actually declared.
 *
 * Why: these workflows install, build and test the sibling harness, whose own
 * `engines.node` floor moves independently of this repo (2026-10-15 it became
 * `>=24.9.0`). A `node-version:` literal that nobody revisits leaves CI
 * building the harness on a runtime it does not support, and the only signal
 * is a `[WARN] Unsupported engine` line inside an otherwise green log. That is
 * exactly what had happened by 2026-11: presubmit had pinned 22 since
 * 2026-08-16 while the pinned harness required 24.9+. Comments cannot hold
 * this invariant; a gate can.
 *
 * Rules (pure line scan, no node_modules — runs in the static prefix):
 *   1. every .github/workflows/*.yml has at least one `actions/setup-node`
 *      step (without one the job inherits whatever the runner image ships).
 *   2. each setup-node step declares exactly one of `node-version-file:` or
 *      `node-version:`.
 *   3. a `node-version:` literal must be the primary line (`.nvmrc`) or the
 *      engines floor from the root package.json (a minor/patch pin of that
 *      major is allowed).
 *
 * The two-line policy itself (why `.nvmrc` is primary, why one job keeps the
 * floor, why publish/release-tag use a literal) lives in deviation #5 of
 * .github/workflows/presubmit.yml and in docs/dev.md "Node version line".
 *
 * Usage: node scripts/check-workflow-node.mjs [repo-root]
 * Exit 1 with file:line for each violation.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** First `.nvmrc` line that is neither blank nor a comment. */
export function readPrimaryLine(text) {
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    return line
  }
  return undefined
}

/** Lowest supported major from an engines range like `^22.19 || >=24`. */
export function readFloorMajor(engines) {
  const majors = String(engines ?? '')
    .split('||')
    .map((alt) => alt.match(/\d+/)?.[0])
    .filter(Boolean)
    .map(Number)
  return majors.length > 0 ? Math.min(...majors) : undefined
}

/** Major of a version token like `24`, `24.22.2` or `v22.19.0`. */
function majorOf(version) {
  const match = String(version).trim().replace(/^v/, '').match(/^(\d+)/)
  return match ? Number(match[1]) : undefined
}

/** Setup-node steps of one workflow, with their version keys. */
function setupNodeSteps(text) {
  const lines = text.split('\n')
  const steps = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*-\s+uses:\s*actions\/setup-node@/.test(lines[i])) continue
    const indent = lines[i].search(/\S/)
    const keys = []
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue
      if (lines[j].search(/\S/) <= indent) break // next step or sibling key
      const m = lines[j].match(/^\s+(node-version-file|node-version):\s*([^#\s]+)/)
      if (m) keys.push({ key: m[1], value: m[2], line: j + 1 })
    }
    steps.push({ line: i + 1, keys })
  }
  return steps
}

export function checkWorkflow(name, text, { primary, floorMajor }) {
  const out = []
  const steps = setupNodeSteps(text)
  if (steps.length === 0) {
    out.push(`${name}: no \`actions/setup-node\` step — the job would run on whatever Node the runner image ships`)
  }
  for (const step of steps) {
    const literal = step.keys.filter((key) => key.key === 'node-version')
    const fromFile = step.keys.filter((key) => key.key === 'node-version-file')
    if (literal.length === 0 && fromFile.length === 0) {
      out.push(`${name}:${step.line}: setup-node step declares neither \`node-version-file\` nor \`node-version\``)
      continue
    }
    if (literal.length > 0 && fromFile.length > 0) {
      out.push(`${name}:${step.line}: setup-node step declares both \`node-version\` and \`node-version-file\``)
      continue
    }
    for (const { value, line } of literal) {
      const major = majorOf(value)
      if (major === majorOf(primary) || major === floorMajor) continue
      out.push(
        `${name}:${line}: \`node-version: ${value}\` is neither the primary line (\`.nvmrc\` = ${primary}) nor the engines floor (${floorMajor})`,
      )
    }
  }
  return out
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..')
  const primary = readPrimaryLine(readFileSync(join(root, '.nvmrc'), 'utf8'))
  if (!primary) {
    console.error('check-workflow-node: .nvmrc has no version line')
    process.exit(1)
  }
  const engines = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).engines?.node
  const floorMajor = readFloorMajor(engines)
  if (floorMajor === undefined) {
    console.error('check-workflow-node: root package.json has no parseable engines.node range')
    process.exit(1)
  }
  const dir = join(root, '.github', 'workflows')
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()
  const problems = files.flatMap((file) =>
    checkWorkflow(file, readFileSync(join(dir, file), 'utf8'), { primary, floorMajor }),
  )
  for (const problem of problems) console.error(`check-workflow-node: ${problem}`)
  if (problems.length) process.exit(1)
  console.log(`check-workflow-node: OK (${files.length} workflows, primary ${primary}, floor ${floorMajor})`)
}
