#!/usr/bin/env node
// Build the humanities gold manifest (§22.2) from the cases directory.
// Reads every packages/evaluation/vwa-eval/humanities/cases/*.json, computes
// SHA-256 per case, and emits humanities/gold-manifest.json with the domain
// stratum and the frozen dev/holdout split (sorted by id; every third case
// is holdout → 20/20 on a 60-case set).
//
// Usage: node scripts/build-humanities-manifest.mjs [--check]
//   --check  recompute and diff against the committed manifest (CI gate).

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const casesDir = join(pkg, 'humanities', 'cases')
const manifestPath = join(pkg, 'humanities', 'gold-manifest.json')

function build() {
  const files = readdirSync(casesDir).filter((f) => f.endsWith('.json')).sort()
  const cases = files.map((file) => {
    const raw = readFileSync(join(casesDir, file), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed.id || !['historical', 'literary', 'research-argumentative'].includes(parsed.domain)) {
      throw new Error(`${file}: missing id or invalid domain`)
    }
    if (parsed.id !== file.replace(/\.json$/, '')) {
      throw new Error(`${file}: case id must match the file name`)
    }
    return {
      id: parsed.id,
      domain: parsed.domain,
      synthetic: parsed.synthetic === true,
      split: 'dev',
      clean: parsed.clean === true,
      sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
      ...(parsed.adjudicated === true ? { adjudicated: true } : {}),
      claims: parsed.claims ?? [],
      support: parsed.support ?? [],
    }
  })
  // Frozen split: sorted by id, every third is holdout (deterministic, strata-preserving
  // within a sorted, interleaved naming scheme; §22.2 target 40 dev / 20 holdout).
  cases.forEach((c, i) => {
    c.split = i % 3 === 2 ? 'holdout' : 'dev'
  })
  return {
    schema: 'vwa-eval/humanities-gold-manifest@1',
    scorer: 'humanities-scorer@1',
    frozenAt: '2026-10-16',
    cases,
  }
}

const manifest = build()
const json = JSON.stringify(manifest, null, 2) + '\n'
if (process.argv.includes('--check')) {
  let existing
  try {
    existing = readFileSync(manifestPath, 'utf8')
  } catch {
    console.error('check FAIL: gold-manifest.json missing')
    process.exit(1)
  }
  if (existing !== json) {
    console.error('check FAIL: gold-manifest.json is stale — rerun without --check to regenerate')
    process.exit(1)
  }
  console.log(`check OK: ${manifest.cases.length} cases (${manifest.cases.filter((c) => c.split === 'dev').length} dev / ${manifest.cases.filter((c) => c.split === 'holdout').length} holdout)`)
} else {
  writeFileSync(manifestPath, json)
  console.log(`wrote ${manifestPath}: ${manifest.cases.length} cases`)
}
