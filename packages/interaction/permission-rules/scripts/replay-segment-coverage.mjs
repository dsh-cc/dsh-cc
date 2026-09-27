#!/usr/bin/env node
/**
 * Offline evidence for PR-3 (L1 segment evaluation) — NOT a test gate.
 *
 * Replays the operator's frozen production bash asks (gauge lane: route or
 * model name contains 'laya', verdict 'ask', event time at or before
 * 2026-09-27T11:00+08:00 — the §1 reference freeze) through the D1 segmenter
 * and prints:
 *   1. the D1 bucket table (opaque by reason, tainted, clean/segmented), and
 *   2. how many commands would be auto-allowed post-change, i.e. every
 *      segment is covered by one of the operator's user-settings allow rules.
 *
 * Session store: $HOME/.dsh/sessions/<project>/<session>/session.v3.jsonl.zstd
 * (zstd binary, no npm deps). Rules source: $HOME/.dsh/settings.json
 * permissions.allow.
 *
 * Usage: node packages/interaction/permission-rules/scripts/replay-segment-coverage.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Node 22+ strips TS types natively (--experimental-strip-types; on by
// default in recent minors). If the runtime refuses, the script degrades to
// counting asks only and says so — it is documentation-grade evidence.
let splitShellCommand
let evaluateShell
let parseRule
let filterAutoAllowRules
try {
  ;({ splitShellCommand } = await import('../src/shell-segments.ts'))
  ;({ evaluateShell } = await import('../src/evaluate.ts'))
  ;({ parseRule } = await import('../src/parser.ts'))
  ;({ filterAutoAllowRules } = await import('../src/auto-rule-filter.ts'))
} catch {
  console.error('note: could not import the evaluator modules (shell-segments/evaluate/parser/auto-rule-filter) (run with node >= 22.6 and --experimental-strip-types); segment buckets unavailable')
}

/** The reference freeze from the design doc §1 (2026-09-27T11:00+08:00). */
const FREEZE_MS = Date.parse('2026-09-27T11:00:00+08:00')

const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
const sessionsDir = join(home, 'sessions')

/** List session directories (one level of project dirs, then session dirs). */
function sessionDirs() {
  let first = []
  let second = []
  try {
    first = readdirSafe(sessionsDir)
  } catch {
    return []
  }
  const out = []
  for (const a of first) {
    for (const b of readdirSafe(join(sessionsDir, a))) out.push(join(sessionsDir, a, b))
  }
  return out
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Decompress one .zstd transcript to text via the system zstd binary. */
function decompress(path) {
  try {
    return execFileSync('zstd', ['-dc', path], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Collect gauge-lane bash ask events: the classifier audit event whose
 * route/model contains 'laya' and whose verdict is 'ask', frozen at
 * event time ≤ FREEZE_MS. Bash command extracted from the paired
 * `tool/call` event's arguments.
 */
function collectGaugeBashAsks(lines) {
  const asks = []
  const calls = new Map()
  for (const line of lines) {
    if (line === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const type = event?.type
    if (type === 'tool/call') {
      const args = parseJson(event?.data?.arguments)
      if (typeof args?.command === 'string') calls.set(String(event?.data?.callId), args.command)
      continue
    }
    if (type !== 'permission/classifier') continue
    const data = event?.data ?? {}
    const lane = `${data?.route ?? ''} ${data?.model ?? ''}`
    if (!lane.toLowerCase().includes('laya')) continue
    if (data?.verdict !== 'ask') continue
    const time = typeof event?.time === 'number' ? event.time : NaN
    if (!Number.isFinite(time) || time > FREEZE_MS) continue
    const command = calls.get(String(data?.callId))
    if (typeof command === 'string') asks.push(command)
  }
  return asks
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The operator's parsed bash allow rules, suspension-filtered as auto mode sees them. */
async function userAllowRules() {
  try {
    const settings = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'))
    const allow = settings?.permissions?.allow
    const texts = Array.isArray(allow) ? allow.filter(entry => typeof entry === 'string' && entry.startsWith('Bash(')) : []
    const parsed = texts.map(raw => parseRule(raw, 'allow', 'userSettings')).filter(Boolean)
    return filterAutoAllowRules({ allow: parsed, deny: [], ask: [], bypassImmune: [] }, { classifyAllShell: false })
  } catch {
    return { allow: [], deny: [], ask: [], bypassImmune: [] }
  }
}

/**
 * Whether the command auto-allows post-change: run the REAL evaluator
 * (`evaluateShell`, the production segmented waterfall) in auto mode against
 * the operator's surviving (post-suspension-filter) allow rules.
 */
function coversCommand(rules, command) {
  const decision = evaluateShell(
    {
      toolName: 'Bash',
      subject: command,
      rules,
      mode: 'auto',
      isFileEdit: false,
      isReadOnly: false,
    },
    splitShellCommand(command),
  )
  return decision.kind === 'allow'
}

async function main() {
  const commands = []
  for (const dir of sessionDirs()) {
    const transcript = join(dir, 'session.v3.jsonl.zstd')
    if (!existsSync(transcript)) continue
    const lines = decompress(transcript).split('\n')
    commands.push(...collectGaugeBashAsks(lines))
  }
  const rules = await userAllowRules()
  if (splitShellCommand === undefined) {
    console.log(`frozen bash ask commands (distinct): ${new Set(commands).size} — rerun with type stripping for the bucket table`)
    return
  }

  const buckets = { opaque: {}, tainted: 0, clean: 0, covered: 0 }
  const distinct = [...new Set(commands)]
  for (const command of distinct) {
    const result = splitShellCommand(command)
    if (result.kind === 'opaque') {
      buckets.opaque[result.why] = (buckets.opaque[result.why] ?? 0) + 1
    } else if (result.segments.some(segment => segment.tainted)) {
      buckets.tainted += 1
    } else {
      buckets.clean += 1
      if (coversCommand(rules, command)) buckets.covered += 1
    }
  }

  console.log(`frozen bash ask commands (distinct): ${distinct.length}`)
  console.log('D1 bucket table:')
  for (const [why, count] of Object.entries(buckets.opaque).sort()) {
    console.log(`  opaque:${why.padEnd(10)} ${count}`)
  }
  console.log(`  tainted     ${buckets.tainted}`)
  console.log(`  clean       ${buckets.clean}`)
  console.log(`clean commands fully covered by user-settings rules post-change: ${buckets.covered}/${buckets.clean}`)
  console.log('(A zero on the frozen corpus is honest: its surviving rules predate the bare')
  console.log('/space derivation boundary forms ($ ls ⇒ Bash(ls)), and the corpus mixes multi-')
  console.log('tool chains; each fresh "always" grant of the new form re-covers that family.)')
}

main().catch(error => {
  console.error('replay failed:', error)
  process.exitCode = 1
})
