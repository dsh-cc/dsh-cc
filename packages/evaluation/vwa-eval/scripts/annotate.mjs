#!/usr/bin/env node
/**
 * annotate.mjs — gold-set annotation lane (§8: dual annotation with user
 * adjudication). NOT the judge tier (§4.4: not wired at P2) — this only
 * exports sentences for humans and merges their files.
 *
 *   export   — print every gold-set sentence as JSON (path, index, text,
 *              detected) for annotators A and B to mark
 *              {predicate: 'verifiable'|'not', detail?};
 *   merge    — merge annotator-A/B + adjudication JSON into
 *              annotations/gold-annotations.json (agreements pass through,
 *              disagreements must be adjudicated; merge throws on rows
 *              missing one annotator);
 *   recall   — print detector recall (human-verifiable sentences detected
 *              by the frozen four-family detector) against the merged file.
 *
 * Usage: node packages/evaluation/vwa-eval/scripts/annotate.mjs <export|merge|recall>
 *   merge  annotate.mjs merge <A.json> <B.json> <adjudication.json>
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(PKG, '..', '..', '..', '..')
const { exportGoldSentences, mergeAnnotations, detectorRecall } = await import(
  new URL('../src/annotation.ts', import.meta.url)
)
const { loadGoldSet } = await import(new URL('../src/annotation.ts', import.meta.url))

const [cmd, aPath, bPath, adjudPath] = process.argv.slice(2)

if (cmd === 'export') {
  console.log(JSON.stringify(exportGoldSentences(PKG, ROOT), null, 2))
} else if (cmd === 'merge' && aPath && bPath && adjudPath) {
  const load = (p) => JSON.parse(readFileSync(p, 'utf8'))
  const merged = mergeAnnotations(load(aPath), load(bPath), load(adjudPath))
  console.log(JSON.stringify(merged, null, 2))
} else if (cmd === 'recall' && aPath) {
  const annotations = JSON.parse(readFileSync(aPath, 'utf8')).entries
  const stats = detectorRecall(exportGoldSentences(PKG, ROOT), annotations)
  console.log(JSON.stringify(stats, null, 2))
} else {
  console.error('usage: annotate.mjs export | merge <A> <B> <adjudication> | recall <merged>')
  process.exit(2)
}
