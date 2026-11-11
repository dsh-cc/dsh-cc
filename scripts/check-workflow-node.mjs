#!/usr/bin/env node
/**
 * check-workflow-node.mjs — every job pins the Node runtime explicitly, and
 * every literal it pins is a line this repo has actually declared.
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
 * Rules (line scan over the YAML jobs tree, no node_modules — runs in the
 * static prefix):
 *   1. every job has at least one `actions/setup-node` step, unless the job
 *      calls a reusable workflow (`uses:` at job level, which has no steps).
 *      Without one the job inherits whatever Node the runner image ships.
 *   2. each setup-node step declares exactly one of `node-version-file:` or
 *      `node-version:`.
 *   3. a `node-version:` literal must be the primary line (`.nvmrc`) or the
 *      engines floor from the root package.json: the floor's major, and for
 *      a minor/patch pin at least the floor's minor (`22.19.0` passes, `22.0.0`
 *      does not). `${{ ... }}` expressions are exempt — they resolve at run
 *      time and this scan cannot see through them.
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

/** Lowest supported {major, minor} from an engines range like `^22.19 || >=24`. */
export function readFloorRange(engines) {
  const alts = String(engines ?? '')
    .split('||')
    .map((alt) => alt.trim())
    .filter(Boolean)
  const parsed = []
  for (const alt of alts) {
    const m = alt.match(/^[<>=^~]*\s*v?(\d+)(?:\.(\d+))?/)
    if (m) parsed.push({ major: Number(m[1]), minor: m[2] === undefined ? undefined : Number(m[2]) })
  }
  if (parsed.length === 0) return undefined
  parsed.sort((a, b) => a.major - b.major || (a.minor ?? 0) - (b.minor ?? 0))
  return parsed[0]
}

/** Parse a version token like `24`, `24.22.2`, `"v22.19.0"`. */
export function parseVersion(value) {
  const raw = String(value).trim().replace(/^['"]|['"]$/g, '')
  const m = raw.replace(/^v/, '').match(/^(\d+)(?:\.(\d+))?/)
  if (!m) return undefined
  return { major: Number(m[1]), minor: m[2] === undefined ? undefined : Number(m[2]) }
}

/** `${{ ... }}` resolved at run time — not decidable by this scan. */
function isExpression(value) {
  return /^\$\{\{.*\}\}$/.test(value.trim())
}

/**
 * Split the workflow's `jobs:` tree into jobs. Line-based, so a `run: |`
 * block that put content at column 0 would end the scan early — acceptable
 * for a static gate over this repo's workflows.
 */
function jobBlocks(lines) {
  const start = lines.findIndex((line) => /^jobs:\s*(#.*)?$/.test(line))
  if (start === -1) return []
  const jobs = []
  let current
  for (let i = start + 1; i < lines.length; i++) {
    const text = lines[i]
    const trimmed = text.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      current?.body.push({ text, line: i + 1 })
      continue
    }
    const indent = text.search(/\S/)
    if (indent === 0) break // back to a top-level key
    if (indent === 2) {
      current = { name: trimmed.replace(/:.*$/, ''), line: i + 1, body: [] }
      jobs.push(current)
      continue
    }
    current?.body.push({ text, line: i + 1 })
  }
  return jobs
}

/** Step blocks of one job, with absolute line numbers. */
function stepBlocks(job) {
  const steps = []
  for (let i = 0; i < job.body.length; i++) {
    const open = job.body[i].text.match(/^(\s*)-\s+(.*)$/)
    if (!open) continue
    const indent = open[1].length
    const lines = [{ text: open[2].replace(/\s+#.*$/, ''), line: job.body[i].line }]
    for (let j = i + 1; j < job.body.length; j++) {
      const { text, line } = job.body[j]
      if (text.trim() === '') {
        lines.push({ text: '', line })
        continue
      }
      if (text.search(/\S/) <= indent) break
      lines.push({ text: text.trim().replace(/\s+#.*$/, ''), line })
    }
    steps.push({ line: job.body[i].line, lines })
  }
  return steps
}

/** Version keys of one setup-node step. */
function versionKeys(step) {
  const keys = []
  for (const { text, line } of step.lines) {
    const m = text.match(/^(node-version-file|node-version):\s*(.+)$/)
    if (m) keys.push({ key: m[1], value: m[2].trim(), line })
  }
  return keys
}

export function checkWorkflow(name, text, { primary, floor }) {
  const out = []
  const jobs = jobBlocks(text.split('\n'))
  if (jobs.length === 0) {
    out.push(`${name}: no \`jobs:\` block found`)
    return out
  }
  const primaryMajor = parseVersion(primary)?.major
  if (primaryMajor === undefined) {
    out.push(`${name}: cannot parse the primary line (\`.nvmrc\` = ${primary})`)
    return out
  }
  for (const job of jobs) {
    const reusable = job.body.some(({ text: line }) => /^ {4}uses:\s*\S+/.test(line))
    const nodeSteps = stepBlocks(job).filter((step) =>
      step.lines.some(({ text: line }) => /^uses:\s*actions\/setup-node@/.test(line)),
    )
    if (!reusable && nodeSteps.length === 0) {
      out.push(`${name}:${job.line}: job \`${job.name}\` has no \`actions/setup-node\` step — it would inherit whatever Node the runner image ships`)
    }
    for (const step of nodeSteps) {
      const literal = versionKeys(step).filter((key) => key.key === 'node-version')
      const fromFile = versionKeys(step).filter((key) => key.key === 'node-version-file')
      if (literal.length === 0 && fromFile.length === 0) {
        out.push(`${name}:${step.line}: setup-node step declares neither \`node-version-file\` nor \`node-version\``)
        continue
      }
      if (literal.length > 0 && fromFile.length > 0) {
        out.push(`${name}:${step.line}: setup-node step declares both \`node-version\` and \`node-version-file\``)
        continue
      }
      for (const { value, line } of literal) {
        if (isExpression(value)) continue
        const parsed = parseVersion(value)
        const onPrimary = parsed?.major === primaryMajor
        const onFloor =
          floor !== undefined &&
          parsed?.major === floor.major &&
          (parsed.minor === undefined || floor.minor === undefined || parsed.minor >= floor.minor)
        if (onPrimary || onFloor) continue
        const floorText = floor === undefined ? 'unparseable' : `${floor.major}${floor.minor === undefined ? '' : `.${floor.minor}`}`
        out.push(
          `${name}:${line}: \`node-version: ${value}\` is neither the primary line (\`.nvmrc\` = ${primary}) nor the engines floor (${floorText})`,
        )
      }
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
  const floor = readFloorRange(engines)
  if (floor === undefined) {
    console.error('check-workflow-node: root package.json has no parseable engines.node range')
    process.exit(1)
  }
  const dir = join(root, '.github', 'workflows')
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()
  const problems = files.flatMap((file) =>
    checkWorkflow(file, readFileSync(join(dir, file), 'utf8'), { primary, floor }),
  )
  for (const problem of problems) console.error(`check-workflow-node: ${problem}`)
  if (problems.length) process.exit(1)
  const floorText = `${floor.major}${floor.minor === undefined ? '' : `.${floor.minor}`}`
  console.log(`check-workflow-node: OK (${files.length} workflows, primary ${primary}, floor ${floorText})`)
}
