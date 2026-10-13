#!/usr/bin/env node
/**
 * baseline.mjs — P0(3) transcript-coverage baseline (VWA plan §9, §8 frozen
 * convention). Runs the P2a pipeline's extractor (@dsh-cc/vwa-evidence
 * extractClaims — the frozen four-family detector, NOT reimplemented) over
 * the pinned gold set and writes the baseline summary JSON to
 * baselines/<date>-P0-coverage-baseline.json.
 *
 * Detected-claim counts per family (a sentence can hit several families):
 *   a = numbers with units/percentages, b = ISO dates,
 *   c = version strings, d = API/identifier shapes.
 * "documents with claims" and "detected claims" together form the
 * candidate coverage denominator (§8: coverage = marked+passing ÷ detected).
 *
 * Usage: node packages/evaluation/vwa-eval/scripts/baseline.mjs [--date YYYY-MM-DD]
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAIM_DETECTORS, IDENTIFIER_DETECTORS, extractClaims, proseMask } from '../../../interaction/vwa-evidence/src/marker.ts'

const PKG = dirname(fileURLToPath(import.meta.url))
const ROOT = join(PKG, '..', '..', '..', '..')

const dateIdx = process.argv.indexOf('--date')
const date = dateIdx > 0 ? process.argv[dateIdx + 1] : '2026-10-12'
const gold = JSON.parse(readFileSync(join(PKG, '..', 'gold-set.json'), 'utf8'))

const families = { numbersWithUnits: 0, isoDate: 0, versionString: 0, identifier: 0 }
let detectedClaims = 0
let docsWithClaims = 0

for (const entry of gold) {
  const text = readFileSync(join(ROOT, entry.path), 'utf8')
  const { claims } = extractClaims(text)
  detectedClaims += claims.length
  if (claims.length > 0) docsWithClaims++
  for (const claim of claims) {
    // Family attribution runs on the MASKED sentence, same as detection.
    const masked = proseMask(text).slice(claim.span[0], claim.span[1])
    if (CLAIM_DETECTORS.numbersWithUnits.test(masked)) families.numbersWithUnits++
    if (CLAIM_DETECTORS.isoDate.test(masked)) families.isoDate++
    if (CLAIM_DETECTORS.versionString.test(masked)) families.versionString++
    if (Object.values(IDENTIFIER_DETECTORS).some((re) => re.test(masked))) families.identifier++
  }
}

const summary = {
  date,
  convention: 'docs/plans/2026-10-12-verifiable-workspace-agent.md §8 (frozen): coverage = marked+read-back-passing ÷ detected claims (four-family detector); threshold ≥ 0.9 first release, recalibrated after one dogfood week',
  goldSet: { entries: gold.length, pinned: 'packages/evaluation/vwa-eval/gold-set.json' },
  detectedClaims,
  documentsWithClaims: docsWithClaims,
  claimsPerFamily: families,
  candidateCoverageDenominator: detectedClaims,
}

const out = join(PKG, '..', 'baselines', `${date}-P0-coverage-baseline.json`)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
console.error(`wrote ${relative(ROOT, out)}`)
