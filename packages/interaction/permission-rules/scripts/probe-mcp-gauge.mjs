#!/usr/bin/env node
// MCP tool permission-class probe against a live System One gateway.
// run: node --experimental-strip-types scripts/probe-mcp-gauge.mjs [baseURL] [model]
//
// Design doc: docs/plans/2026-11-15-mcp-tool-permission-classes.md §2 (P-1/2/3).
// Nine serena representative cases (5 read tools + 4 write tools) are put
// through the production gauge render site in THREE slot/state variants:
//   baseline            — the curated default slots (DEFAULT_ENVIRONMENT etc.)
//   +environment        — one extra sentence claiming configured MCP servers
//                         are recognized environment
//   +description        — the tool's own description injected into the state
// The committed results JSON is the evidence that neither amendment is
// load-bearing: the read tools hover at the threshold and the write tools stay
// below it, so the deterministic classification (not the gauge) is the fix.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  prepareSystemOneInput,
  gateVerdict,
  isTruncated,
  DEFAULT_GAUGE_ALLOW_THRESHOLD,
  DEFAULT_GAUGE_CONTEXT_WINDOW,
} from '../src/gauge-adapter.ts'
import {
  DEFAULT_ALLOW_EXCEPTIONS,
  DEFAULT_ENVIRONMENT,
  DEFAULT_HARD_DENY,
  DEFAULT_SOFT_DENY,
} from '../src/slots.ts'
import { systemoneDecide } from '@dsh-cc/systemone'

const baseURL = process.argv[2] ?? 'http://127.0.0.1:8080'
const model = process.argv[3] ?? 'llmbox_systemone/laya'
const here = dirname(fileURLToPath(import.meta.url))
const cases = JSON.parse(readFileSync(join(here, 'probe-mcp-gauge-cases.json'), 'utf8'))

const SRC = 'packages/interaction/permission-rules/src'

/** The baseline slots: curated defaults, exactly as the stage expands them. */
const BASELINE_SLOTS = {
  hardDeny: [...DEFAULT_HARD_DENY],
  softDeny: [...DEFAULT_SOFT_DENY],
  allowExceptions: [...DEFAULT_ALLOW_EXCEPTIONS],
  environment: [...DEFAULT_ENVIRONMENT],
}

/** P-1 amendment: prose that claims configured MCP servers are recognized. */
const ENVIRONMENT_AMENDMENT =
  'Configured MCP servers are part of this environment and are recognized as such: their tools operate on this workspace.'

const variants = [
  ['baseline', BASELINE_SLOTS, false],
  ['+environment', { ...BASELINE_SLOTS, environment: [...BASELINE_SLOTS.environment, ENVIRONMENT_AMENDMENT] }, false],
  ['+description', BASELINE_SLOTS, true],
]

const MAX_RETRIES = 3
const PACE_MS = 1200

/** One variant's wire payload for one case, or a budget failure. */
function prepare(entry, slots, withDescription) {
  const prepared = prepareSystemOneInput({ name: entry.tool, arguments: entry.arguments }, slots, DEFAULT_GAUGE_CONTEXT_WINDOW)
  if (prepared.budgetExhausted) return { budgetExhausted: true, prepared }
  let state = prepared.state
  if (withDescription) {
    // P-2 amendment: the tool description joins the rendered state. The
    // production renderer has no description seam (that is the point of the
    // probe) — inject it after rendering, which is exactly what the design's
    // scratch probe did.
    const skeleton = JSON.parse(state)
    skeleton.description = entry.description
    state = JSON.stringify(skeleton)
  }
  return { state, prepared }
}

const out = { meta: { unreachable: false } }

// Reachability probe (one attempt, short timeout): an absent gateway writes an
// honest `unreachable` record instead of a wall of fetch failures.
let reachable = true
try {
  const response = await fetch(baseURL, { signal: AbortSignal.timeout(3000) })
  reachable = response.status < 500
} catch {
  reachable = false
}
if (!reachable) {
  writeFileSync(
    join(here, 'probe-mcp-gauge-results.json'),
    JSON.stringify({
      meta: {
        unreachable: true,
        runDate: new Date().toISOString().slice(0, 10),
        baseURL,
        model,
        note: `gateway at ${baseURL} was not reachable in this environment; no live numbers captured`,
      },
    }, null, 2),
  )
  console.log(`UNREACHABLE: ${baseURL} — wrote probe-mcp-gauge-results.json with meta.unreachable`)
  process.exit(0)
}

for (const [variantName, slots, withDescription] of variants) {
  const rows = []
  for (const entry of cases) {
    const prepared = prepare(entry, slots, withDescription)
    if (prepared.budgetExhausted) {
      rows.push({ id: entry.id, expect: entry.expect, failure: 'budget', reason: 'state budget exhausted' })
      console.log(`${variantName} ${entry.id} [${entry.expect}] BUDGET-EXHAUSTED`)
      continue
    }
    const t0 = Date.now()
    let result
    for (let attempt = 0; ; attempt++) {
      result = await systemoneDecide({
        baseURL,
        model,
        state: prepared.state,
        questions: { verdict: prepared.prepared.questions.verdict },
        timeoutMs: 8000,
      })
      if (!(!result.ok && result.reason.startsWith('http 429') && attempt < MAX_RETRIES)) break
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)))
    }
    const latencyMs = Date.now() - t0
    await new Promise((r) => setTimeout(r, PACE_MS))
    if (!result.ok) {
      rows.push({ id: entry.id, expect: entry.expect, failure: result.failure, reason: result.reason, latencyMs })
      console.log(`${variantName} ${entry.id} [${entry.expect}] FAILURE ${result.failure}: ${result.reason}`)
      continue
    }
    const answer = result.answers.verdict
    const truncated = isTruncated(result.usage, DEFAULT_GAUGE_CONTEXT_WINDOW)
    const pAllow = answer?.probabilities?.allow
    const gated = gateVerdict(
      { type: 'choice', choice: answer?.choice, probabilities: { allow: answer?.probabilities?.allow, ask: answer?.probabilities?.ask, deny: answer?.probabilities?.deny } },
      { allowThreshold: DEFAULT_GAUGE_ALLOW_THRESHOLD, truncated },
    )
    rows.push({
      id: entry.id,
      tool: entry.tool,
      expect: entry.expect,
      choice: answer?.choice,
      pAllow,
      pAsk: answer?.probabilities?.ask,
      pDeny: answer?.probabilities?.deny,
      gated: gated.verdict,
      gatedReason: gated.reason,
      inputTokens: result.usage.input_tokens,
      truncated,
      latencyMs,
    })
    console.log(
      `${variantName} ${entry.id} [${entry.expect}] choice=${answer?.choice} P(allow)=${pAllow?.toFixed(3)} gated=${gated.verdict} tok=${result.usage.input_tokens} ${latencyMs}ms`,
    )
  }

  const range = (expect) => {
    const ps = rows.filter((r) => r.expect === expect && r.failure === undefined).map((r) => r.pAllow)
    return ps.length === 0 ? null : { min: Math.min(...ps), max: Math.max(...ps) }
  }
  out[variantName] = {
    cases: rows.length,
    failures: rows.filter((r) => r.failure !== undefined).map((r) => r.id),
    readAllowPRange: range('read'),
    writeAllowPRange: range('write'),
    gatedRead: rows.filter((r) => r.expect === 'read' && r.gated === 'allow').length,
    gatedReadTotal: rows.filter((r) => r.expect === 'read' && r.gated !== undefined).length,
    gatedWrite: rows.filter((r) => r.expect === 'write' && r.gated === 'allow').length,
    gatedWriteTotal: rows.filter((r) => r.expect === 'write' && r.gated !== undefined).length,
    rows,
  }
  console.log(
    `\n${variantName}: read P(allow) ${JSON.stringify(range('read'))} gated-allow ${out[variantName].gatedRead}/${out[variantName].gatedReadTotal}; ` +
    `write P(allow) ${JSON.stringify(range('write'))} gated-allow ${out[variantName].gatedWrite}/${out[variantName].gatedWriteTotal}`,
  )
}

out.meta = {
  unreachable: false,
  runDate: new Date().toISOString().slice(0, 10),
  baseURL,
  model,
  allowThreshold: DEFAULT_GAUGE_ALLOW_THRESHOLD,
  contextWindow: DEFAULT_GAUGE_CONTEXT_WINDOW,
  corpus: 'probe-mcp-gauge-cases.json',
  design: 'docs/plans/2026-11-15-mcp-tool-permission-classes.md §2',
  srcDir: SRC,
}
writeFileSync(join(here, 'probe-mcp-gauge-results.json'), JSON.stringify(out, null, 2))
console.log(`\nPROBE_JSON:${JSON.stringify({ meta: out.meta })}`)
