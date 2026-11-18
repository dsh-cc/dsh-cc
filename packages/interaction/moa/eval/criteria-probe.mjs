#!/usr/bin/env node
/**
 * Local-only criteria evaluation probe for the moa routing question.
 * NOT a CI artifact: it queries a live System One gateway
 * (default http://127.0.0.1:8080, model llmbox_systemone/bjev).
 *
 * Design record: docs/plans/2026-11-18-moa-domain-neutral-routing-criteria.md
 * (review-round snapshots live in .scratch/ while the design is under review).
 *
 * It evaluates BOTH shipped classifiers, each under old and new criteria:
 *  - L-shape (legacy classifier, router-classify.ts): legacy instructions,
 *    bare-text state, argmax over the four labels.
 *  - C-shape (context-routing v2): CONTEXT_ROUTE_INSTRUCTIONS, a constructed
 *    first-turn RoutingContext state, tail policy at the shipped thresholds
 *    (min-top 0.60, max-under-tail 0.10). chosen === undefined => fallback
 *    (live selection, no routing), counted separately from under-tier.
 * Cross-combinations (e.g. the tail policy over the L-shape distribution) are
 * NOT shipped behavior and are never reported.
 *
 * Reported tiers are PRE-COLLAPSE (argmaxTier / suggestedTier): the probe
 * stops before collapseAppliedTier and before the truncation sentinel (these
 * cases are far below the 4000-token budget), so a sketch<->draft flip on a
 * ladder where both aliases share a model is a label change, not a model
 * change. Gates G1-G8 of the design's section 5 are evaluated and printed as
 * PASS/FAIL/N-A with the numbers that decided each one; the merge-blocking
 * arithmetic must not live only in prose.
 *
 * Both instruction strings and the active criteria strings are SCRAPED from
 * ../src at run time, with loud assertions — a source-format drift fails
 * before any request is issued. Old criteria are embedded below as the frozen
 * historical control (never edit them).
 *
 * Usage: node criteria-probe.mjs [--base-url URL] [--model ID] [--runs N] [--pace-ms N] [--g6-resamples N]
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const baseURL = opt('base-url', 'http://127.0.0.1:8080')
const model = opt('model', 'llmbox_systemone/bjev')
const runs = Number(opt('runs', '2'))
/** Inter-call pacing (the gateway qpm is shared with live traffic). */
const PACE_MS = Number(opt('pace-ms', '350'))
/** G6 extra samples per flipped case (determinism must hold unanimously). */
const G6_RESAMPLES = Number(opt('g6-resamples', '3'))

/** Frozen historical (pre-change) criteria — the A/B control. */
const OLD_CRITERIA = {
  sketch: 'trivial: typo fixes, one-line edits, simple factual questions, renames, single-command explanations',
  draft: 'moderate: single-function utilities, small localized feature edits, explaining short code snippets',
  blueprint: 'complex: multi-file or multi-module design, architecture proposals, root-cause analysis of subtle bugs, phased refactors',
  masterplan: 'very hard or ambiguous: cross-cutting strategy, long-horizon multi-team planning, organization-scale tradeoff decisions, platform migrations',
}

const LABELS = ['sketch', 'draft', 'blueprint', 'masterplan']
const EXPOSED = new Set(['A1', 'A5', 'A9', 'A13'])
const ADVERSARIAL = ['D1', 'D2']

// ---------------------------------------------------------------- scraping --

const routerTiersSrc = readFileSync(join(here, '..', 'src', 'router-tiers.ts'), 'utf8')
const contextRoutingSrc = readFileSync(join(here, '..', 'src', 'context-routing.ts'), 'utf8')

function must(condition, message) {
  if (!condition) throw new Error(`criteria-probe: ${message}`)
}

/** Criteria map out of the ROUTING_QUESTION literal. */
function scrapeCriteria(source) {
  const out = {}
  for (const label of LABELS) {
    const m = source.match(new RegExp(`${label}:\\s*'((?:[^'\\\\]|\\\\.)*)'`))
    must(m !== null, `cannot scrape criteria "${label}" — router-tiers.ts format drifted`)
    out[label] = m[1]
  }
  return out
}

/** Legacy instructions out of the ROUTING_QUESTION literal. */
function scrapeLegacyInstructions(source) {
  const m = source.match(/ROUTING_QUESTION\s*=\s*\{[\s\S]*?instructions:\s*'((?:[^'\\]|\\.)*)'/)
  must(m !== null, 'cannot scrape legacy instructions from router-tiers.ts')
  must(m[1].includes('LOWEST capability tier'), `scraped legacy instructions look wrong: "${m[1]}"`)
  return m[1]
}

/** CONTEXT_ROUTE_INSTRUCTIONS — a '+'-concatenated literal, joined verbatim. */
function scrapeContextInstructions(source) {
  const start = source.indexOf('CONTEXT_ROUTE_INSTRUCTIONS =')
  must(start >= 0, 'cannot find CONTEXT_ROUTE_INSTRUCTIONS in context-routing.ts')
  const block = source.slice(start, source.indexOf('\n\n', start))
  const fragments = [...block.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => m[1])
  must(fragments.length > 0, 'CONTEXT_ROUTE_INSTRUCTIONS block carries no string literal')
  const joined = fragments.join('')
  must(joined.includes('currentRequest'), `scraped context instructions look wrong: "${joined}"`)
  return joined
}

const NEW_CRITERIA = scrapeCriteria(routerTiersSrc)
const LEGACY_INSTRUCTIONS = scrapeLegacyInstructions(routerTiersSrc)
const CONTEXT_INSTRUCTIONS = scrapeContextInstructions(contextRoutingSrc)

// ------------------------------------------------------------- decisions --

function argmax(p) {
  let best = -Infinity
  let tier
  for (const [i, l] of LABELS.entries()) {
    const v = p[l]
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
    if (v > best) { best = v; tier = i }
  }
  return tier
}

/** Mirrors routing-policy.ts chooseRoutingTier (1e-12 tolerance, shipped defaults). */
function tailTier(p, minTop = 0.6, maxUnder = 0.1) {
  const probs = LABELS.map(l => p[l])
  if (probs.some(v => typeof v !== 'number' || !Number.isFinite(v))) return undefined
  const maxP = Math.max(...probs)
  if (maxP + 1e-12 < minTop) return undefined
  const tails = [0, 0, 0, 0]
  for (let k = 2; k >= 0; k--) tails[k] = tails[k + 1] + probs[k + 1]
  for (let k = 0; k <= 3; k++) if (tails[k] <= maxUnder + 1e-12) return k
  return 3
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function classify(state, instructions, criteria) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${baseURL.replace(/\/$/, '')}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        state,
        questions: { route: { type: 'choice', instructions, criteria } },
      }),
    })
    const body = await res.json()
    const p = body?.answers?.route?.probabilities
    if (p) { await sleep(PACE_MS); return p }
    must(attempt < 8, `gateway error after ${attempt + 1} attempts: ${JSON.stringify(body).slice(0, 200)}`)
    await sleep(attempt === 0 ? 2000 : Math.min(2000 * 2 ** (attempt - 1), 30000))
  }
}

// ------------------------------------------------------------------ corpus --

const corpus = JSON.parse(readFileSync(join(here, 'criteria-corpus.json'), 'utf8'))
const newCriteriaLive = JSON.stringify(NEW_CRITERIA) !== JSON.stringify(OLD_CRITERIA)
const criteriaSets = newCriteriaLive ? { old: OLD_CRITERIA, new: NEW_CRITERIA } : { old: OLD_CRITERIA }

const results = []
for (let run = 0; run < runs; run++) {
  for (const c of corpus.cases) {
    for (const [setName, criteria] of Object.entries(criteriaSets)) {
      const pL = await classify(c.text, LEGACY_INSTRUCTIONS, criteria)
      const cState = {
        version: 1,
        currentRequest: c.text,
        priorUserRequests: [],
        recentToolCalls: [],
        omitted: { user: 0, assistant: false, tools: 0 },
      }
      const pC = await classify(cState, CONTEXT_INSTRUCTIONS, criteria)
      results.push({
        run, id: c.id, domain: c.domain, exposed: EXPOSED.has(c.id),
        min: LABELS.indexOf(c.minTier), set: setName,
        l: argmax(pL), c: tailTier(pC),
      })
    }
  }
}

const firstRun = setName => results.filter(r => r.run === 0 && r.set === setName)
const stateOf = (r, shape) => {
  const tier = shape === 'l' ? r.l : r.c
  if (tier === undefined) return { kind: 'fallback', tier: undefined, distance: Infinity }
  const distance = tier - r.min
  return { kind: distance < 0 ? 'under' : distance === 0 ? 'exact' : 'over', tier, distance }
}

function summarize(setName) {
  const rows = firstRun(setName)
  const per = {}
  for (const domain of ['data', 'coding', 'general']) {
    for (const shape of ['l', 'c']) {
      const sel = rows.filter(r => r.domain === domain)
      let under = 0, exact = 0, fallback = 0, masterplan = 0
      for (const r of sel) {
        const s = stateOf(r, shape)
        if (s.kind === 'fallback') fallback++
        else {
          if (s.kind === 'under') under++
          if (s.kind === 'exact') exact++
          if (s.tier === 3) masterplan++
        }
      }
      per[`${domain}/${shape}`] = { n: sel.length, under, exact, fallback, masterplan }
    }
  }
  return per
}

const exposedDataEligible = c => !EXPOSED.has(c.id) && c.domain === 'data' && c.minTier !== 'sketch'
const unexposedEligible = corpus.cases.filter(exposedDataEligible)
const eligibleSet = new Set(unexposedEligible.map(c => c.id))

function unexposedCounts(setName, shape) {
  const rows = firstRun(setName).filter(r => eligibleSet.has(r.id))
  let under = 0, fallback = 0
  for (const r of rows) {
    const s = stateOf(r, shape)
    if (s.kind === 'under') under++
    if (s.kind === 'fallback') fallback++
  }
  return { under, fallback, n: rows.length }
}

function masterplanCount(setName, shape) {
  return firstRun(setName).filter(r => stateOf(r, shape).tier === 3).length
}

function crossingCount(setName, shape) {
  return firstRun(setName).filter(r => {
    const s = stateOf(r, shape)
    return s.tier !== undefined && s.tier >= 2
  }).length
}

// -------------------------------------------------------------- stability --

const flips = []
{
  const seen = new Map()
  for (const r of results) {
    const k = `${r.id}|${r.set}`
    const prev = seen.get(k)
    if (prev && (prev.l !== r.l || prev.c !== r.c)) flips.push({ id: r.id, set: r.set, l: [prev.l, r.l], c: [prev.c, r.c] })
    seen.set(k, { l: r.l, c: r.c })
  }
}

// ------------------------------------------------------------------ gates --

function gateResult(id, condition, detail) {
  return { id, verdict: condition === undefined ? 'N-A' : condition ? 'PASS' : 'FAIL', detail }
}

const gates = []
if (!newCriteriaLive) {
  gates.push(gateResult('G1-G8', undefined, 'control only (new criteria not applied yet)'))
} else {
  const oldL = unexposedCounts('old', 'l'), newL = unexposedCounts('new', 'l')
  const oldC = unexposedCounts('old', 'c'), newC = unexposedCounts('new', 'c')
  const rowsOld = firstRun('old'), rowsNew = firstRun('new')
  const byId = list => new Map(list.map(r => [r.id, r]))
  const o = byId(rowsOld), n = byId(rowsNew)

  gates.push(gateResult('G1', newL.under < oldL.under && newL.under <= 1,
    `L unexposed-data under ${oldL.under}->${newL.under} (n=${newL.n}), need strict decrease and <=1`))

  gates.push(gateResult('G2', newC.under === 0 && newC.fallback < oldC.fallback && newC.fallback <= 3,
    `C unexposed-data under ${oldC.under}->${newC.under}, fallback ${oldC.fallback}->${newC.fallback}, need under=0, fallback decrease and <=3`))

  let underRegressions = []
  let fallbackRegressions = []
  for (const r of rowsNew) {
    const ro = o.get(r.id)
    if (!ro) continue
    for (const shape of ['l', 'c']) {
      const so = stateOf(ro, shape), sn = stateOf(r, shape)
      if (sn.kind === 'under' && so.kind !== 'under') underRegressions.push(`${r.id}/${shape}`)
      if (sn.kind === 'fallback' && so.kind !== 'fallback') fallbackRegressions.push(`${r.id}/${shape}`)
    }
  }
  gates.push(gateResult('G3', underRegressions.length === 0,
    underRegressions.length ? `new under-tier: ${underRegressions.join(', ')}` : 'no case became under-tier'))
  const totalFallback = setName => firstRun(setName).filter(r => stateOf(r, 'c').kind === 'fallback').length
  const fbOld = totalFallback('old'), fbNew = totalFallback('new')
  gates.push(gateResult('G4', fallbackRegressions.length === 0 && fbNew <= fbOld,
    fallbackRegressions.length
      ? `new fallbacks: ${fallbackRegressions.join(', ')}`
      : `no routed case became a fallback; total C-shape fallbacks ${fbOld}->${fbNew} (all cases)`))

  const mpL = [masterplanCount('old', 'l'), masterplanCount('new', 'l')]
  const mpC = [masterplanCount('old', 'c'), masterplanCount('new', 'c')]
  const crossL = [crossingCount('old', 'l'), crossingCount('new', 'l')]
  const crossC = [crossingCount('old', 'c'), crossingCount('new', 'c')]
  const inflatedL = mpL[1] > mpL[0] + 2, inflatedC = mpC[1] > mpC[0] + 2
  // A "crossing" is a NUMERIC old tier below blueprint that the new criteria
  // push to blueprint-or-above. A fallback has no selected tier, so recovering
  // one into blueprint is not a crossing (the design forbids mixing fallback
  // into tier outcomes) — counting it would let the adversarial recoveries
  // alone exhaust the per-shape cap.
  const crossUpL = [], crossUpC = []
  for (const r of rowsNew) {
    const ro = o.get(r.id)
    if (!ro) continue
    const sl = stateOf(ro, 'l'), nl = stateOf(r, 'l')
    if (nl.tier !== undefined && nl.tier >= 2 && sl.tier !== undefined && sl.tier < 2) crossUpL.push(r.id)
    const sc = stateOf(ro, 'c'), nc = stateOf(r, 'c')
    if (nc.tier !== undefined && nc.tier >= 2 && sc.tier !== undefined && sc.tier < 2) crossUpC.push(r.id)
  }
  gates.push(gateResult('G5', !inflatedL && !inflatedC && crossUpL.length <= 2 && crossUpC.length <= 2,
    `masterplan L ${mpL.join('->')} C ${mpC.join('->')} | into blueprint+ L ${crossL.join('->')} [${crossUpL.join(',') || 'none'}] C ${crossC.join('->')} [${crossUpC.join(',') || 'none'}], need +<=2 and <=2 new crossings`))

  // G6 (design §5): the criterion is DETERMINISM, and the only unambiguous
  // test of it is unanimity. A flip in the base 2 runs triggers a re-sample of
  // the flipped cases (--g6-resamples, default 3 more) and the case passes only
  // if EVERY sample of it agrees. Rationale (r4 divergence, adjudicated):
  // a labelling rule that privileges one of the disagreeing samples is
  // arbitrary — any 3-sample pattern over {A,B} is still instability, so
  // "transient passes" cannot be decided from 3 samples without inventing a
  // tie-break. The design's earlier transient-passes allowance is therefore
  // withdrawn rather than faked: on a deterministic gateway (the design's own
  // premise, baseline: 0 flips) unanimity always holds, and a genuine
  // singleton blip costs one probe re-run rather than shipping an unstable
  // classifier. Non-unanimity is reported with every sample so an operator can
  // see what happened; it is a FAIL, never a silent pass or an N-A.
  const newFlips = flips.filter(f => f.set === 'new')
  let g6Verdict, g6Detail
  if (newFlips.length === 0) {
    g6Verdict = true
    g6Detail = 'no outcome flips across the base runs (deterministic)'
  } else {
    const samples = []
    for (const f of newFlips) {
      const c = corpus.cases.find(x => x.id === f.id)
      if (!c) { samples.push({ id: f.id, error: 'case not found in corpus' }); continue }
      const seen = [{ l: f.l[0], c: f.c[0] }, { l: f.l[1], c: f.c[1] }]
      for (let i = 0; i < G6_RESAMPLES; i++) {
        const pL = await classify(c.text, LEGACY_INSTRUCTIONS, NEW_CRITERIA)
        const cState = {
          version: 1, currentRequest: c.text, priorUserRequests: [], recentToolCalls: [],
          omitted: { user: 0, assistant: false, tools: 0 },
        }
        const pC = await classify(cState, CONTEXT_INSTRUCTIONS, NEW_CRITERIA)
        seen.push({ l: argmax(pL), c: tailTier(pC) })
      }
      const keys = new Set(seen.map(x => `${x.l}/${x.c}`))
      samples.push({ id: f.id, unanimous: keys.size === 1, samples: seen })
    }
    const unstable = samples.filter(x => x.unanimous === false)
    g6Verdict = unstable.length === 0
    g6Detail = unstable.length === 0
      ? `flipped then unanimous over ${2 + G6_RESAMPLES} samples: ${samples.map(x => x.id).join(', ')}`
      : 'NOT deterministic over ' + (2 + G6_RESAMPLES) + ' samples: '
        + unstable.map(x => `${x.id}[${x.samples.map(t => `${t.l ?? 'fb'}/${t.c ?? 'fb'}`).join(' ')}]`).join('; ')
  }
  gates.push(gateResult('G6', g6Verdict, g6Detail))

  const adv = ADVERSARIAL.map(id => {
    const r = n.get(id)
    return `${id} L=${r?.l ?? 'fallback'} C=${r?.c ?? 'fallback'}`
  })
  const advOk = ADVERSARIAL.every(id => {
    const r = n.get(id)
    if (!r) return false
    const sl = stateOf(r, 'l'), sc = stateOf(r, 'c')
    return (sl.tier !== undefined && sl.tier >= 2) && (sc.tier !== undefined && sc.tier >= 2)
  })
  gates.push(gateResult('G7', advOk, `adversarial cases must carry a SELECTED tier >= blueprint on both shapes (a fallback does not satisfy it): ${adv.join('; ')}`))

  const a5 = n.get('A5'), a9 = n.get('A9')
  const g8ok = a5 !== undefined && a5.l !== undefined && a5.l <= 1
    && a9 !== undefined && a9.c !== undefined && a9.c <= 2
  gates.push(gateResult('G8', g8ok,
    `A5 L<=draft (now ${a5?.l ?? 'fallback'}), A9 C<=blueprint (now ${a9?.c ?? 'fallback'})`))
}

// ----------------------------------------------------------------- output --

console.log(`# criteria probe — model=${model} runs=${runs} sets=${Object.keys(criteriaSets).join(',')} newCriteriaLive=${newCriteriaLive}`)
console.log(`# corpus=${corpus.cases.length} cases, exposed=[${[...EXPOSED].join(',')}], adversarial=[${ADVERSARIAL.join(',')}]`)
console.log(`# reported tiers are pre-collapse (argmaxTier / suggestedTier); thresholds min-top 0.60 / max-under-tail 0.10`)
for (const setName of Object.keys(criteriaSets)) {
  const per = summarize(setName)
  for (const key of Object.keys(per)) {
    const x = per[key]
    console.log(`[${setName}] ${key.padEnd(13)} n=${x.n} under=${x.under} exact=${x.exact} over=${x.n - x.under - x.exact - x.fallback} fallback=${x.fallback} masterplan=${x.masterplan}`)
  }
  const l = unexposedCounts(setName, 'l'), c = unexposedCounts(setName, 'c')
  console.log(`[${setName}] unexposed-eligible-data(n=${l.n}): L under=${l.under} | C under=${c.under} fallback=${c.fallback}`)
}
console.log('# gates (design §5):')
for (const g of gates) console.log(`  ${g.id} ${g.verdict} — ${g.detail}`)
console.log(newCriteriaLive
  ? '# transition table (old -> new, both shapes; only cases that moved):'
  : '# case rows (control arm only; apply the new criteria to get the old -> new transition table):')
if (newCriteriaLive) {
  const rowsOld = firstRun('old'), rowsNew = firstRun('new')
  const o = new Map(rowsOld.map(r => [r.id, r]))
  const fmt = s => s.kind === 'fallback' ? 'fallback' : `${LABELS[s.tier]}(${s.distance > 0 ? '+' : ''}${s.distance})`
  for (const r of rowsNew) {
    const ro = o.get(r.id)
    if (!ro) continue
    const parts = []
    for (const shape of ['l', 'c']) {
      const so = stateOf(ro, shape), sn = stateOf(r, shape)
      if (so.tier !== sn.tier || so.kind !== sn.kind) parts.push(`${shape}: ${fmt(so)} -> ${fmt(sn)}`)
    }
    if (parts.length) console.log(`  ${r.id}${r.exposed ? '*' : ' '} min=${LABELS[r.min].padEnd(10)} ${parts.join(' | ')}`)
  }
} else {
  for (const r of firstRun('old')) {
    console.log(`  ${r.id}${r.exposed ? '*' : ' '} ${r.domain.padEnd(7)} min=${LABELS[r.min].padEnd(10)} L=${r.l === undefined ? 'fallback' : LABELS[r.l]} C=${r.c === undefined ? 'fallback' : LABELS[r.c]}`)
  }
}
if (flips.length > 0) {
  console.log('# OUTCOME FLIPS ACROSS RUNS (G6):')
  for (const f of flips) console.log(`  ${f.id} ${f.set}: L ${f.l.join(' vs ')} | C ${f.c.join(' vs ')}`)
}
