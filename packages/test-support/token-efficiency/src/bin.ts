#!/usr/bin/env node
/**
 * Token-efficiency bin (plan 2026-09-20 §3.4/§3.5): Phase-0 dogfood tool and
 * tier runner. tsx-run, no arg-parser dep:
 *
 *   pnpm exec tsx packages/test-support/token-efficiency/src/bin.ts <cmd> [flags]
 *
 *   sanitize <session.jsonl|.zstd|-> [--out <path>]  raw log → canonical
 *     sanitized JSONL (Phase-0 dogfooding); --out requires exactly one input,
 *     otherwise stdout.
 *   run   [--gate <path>] [--corpus <dir>] [--mock-corpus <dir>]
 *         [--write-baseline <path>]
 *   check [--gate <path>] [--corpus <dir>] [--mock-corpus <dir>]
 *                                                      exits 1 on any failure
 *
 * Corpus fixtures and gate baseline-vector paths are posix-relative to this
 * package dir. Exit codes: 0 ok, 1 check failures, 2 usage error.
 * @module @dsh-cc/token-efficiency/bin
 */
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSessionEvents, type SessionLogEvent } from '@dsh-cc/cache-trajectory'
import { loadCorpusDir, type TaskDescriptor } from './corpus.ts'
import { foldMetricVector, usageCoverage, type MetricVector } from './metrics.ts'
import { loadBaseline, loadGate, runChecks } from './gate.ts'
import { renderCanonicalJsonl, sanitizeSessionEvents } from './redactor.ts'
import { hasMockScenario, runMockTask } from './mock-run.ts'

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_GATE = join(PKG_DIR, 'eval-gate.yaml')
const DEFAULT_CORPUS = join(PKG_DIR, 'corpus/replay')
const DEFAULT_MOCK_CORPUS = join(PKG_DIR, 'corpus/mock')

/** Replay corpus plus (by default) the committed mock-script corpus. */
function loadCorpus(argv: readonly string[]): TaskDescriptor[] {
  const corpus = [...loadCorpusDir(flagValue(argv, '--corpus') ?? DEFAULT_CORPUS)]
  if (existsSync(DEFAULT_MOCK_CORPUS) && flagValue(argv, '--mock-corpus') === undefined) {
    corpus.push(...loadCorpusDir(DEFAULT_MOCK_CORPUS))
  }
  return corpus
}

/** Run every mock-script task that has a registered scenario (wiring tier). */
async function foldMockCorpus(corpus: readonly TaskDescriptor[]): Promise<Record<string, MetricVector>> {
  const vectors: Record<string, MetricVector> = {}
  for (const descriptor of corpus) {
    if (descriptor.kind !== 'mock-script') continue
    if (!hasMockScenario(descriptor)) {
      process.stdout.write(`mock-script ${descriptor.id}: no scenario registered (check will fail on the missing candidate vector)\n`)
      continue
    }
    vectors[descriptor.id] = await runMockTask(descriptor)
  }
  return vectors
}

const FOOTER = 'token-efficiency tiers: replay = metric-definition stability only (a green replay tier is NOT savings evidence)'
  + ' · mock-script = wiring regression · improvement claims belong to the live tier only'

function usageError(message: string): never {
  process.stderr.write(`token-efficiency: ${message}\n`)
  process.exit(2)
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined) usageError(`flag ${flag} expects a value`)
  return value
}

function readEvents(path: string): SessionLogEvent[] {
  try {
    return readSessionEvents(path)
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error))
  }
}

/** Fold every replay-kind fixture into a task → vector map; count deferred (live) kinds. */
function foldReplayCorpus(corpus: readonly TaskDescriptor[]): {
  vectors: Record<string, MetricVector>
  deferred: number
} {
  const vectors: Record<string, MetricVector> = {}
  let deferred = 0
  for (const descriptor of corpus) {
    if (descriptor.kind === 'live') {
      deferred += 1
      continue
    }
    if (descriptor.kind !== 'replay') continue
    const events = readEvents(join(PKG_DIR, descriptor.fixture!))
    vectors[descriptor.id] = foldMetricVector(events, { task: descriptor.id })
  }
  return { vectors, deferred }
}

function printDeferralNotice(deferred: number): void {
  if (deferred > 0) {
    process.stdout.write(`live tier: ${deferred} task(s) deferred (live is manual-only at v1)\n`)
  }
}

function sanitize(argv: string[]): number {
  const out = flagValue(argv, '--out')
  const inputs: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') i += 1
    else inputs.push(argv[i]!)
  }
  if (inputs.length === 0) usageError('sanitize expects at least one <session.jsonl|.zstd|-> input')
  if (out !== undefined && inputs.length !== 1) usageError('--out requires exactly one input')
  const rendered = inputs.map(input => renderCanonicalJsonl(sanitizeSessionEvents(readEvents(input))))
  if (out !== undefined) {
    writeFileSync(out, rendered[0]!)
    process.stdout.write(`wrote ${out}\n`)
  } else {
    for (const text of rendered) process.stdout.write(text)
  }
  return 0
}

function foldLine(vector: MetricVector): string {
  return `${vector.task}: tokens=${vector.tokens.total} `
    + `(in=${vector.tokens.input} out=${vector.tokens.output} cacheRead=${vector.tokens.cacheRead} cacheWrite=${vector.tokens.cacheWrite}) `
    + `${vector.costUsd === undefined ? 'cost=n/a' : `cost=$${vector.costUsd.toFixed(6)}`} `
    + `counters=${JSON.stringify(vector.counters)}`
}

async function run(argv: string[]): Promise<number> {
  const corpus = loadCorpus(argv)
  const { vectors: replayVectors, deferred } = foldReplayCorpus(corpus)
  // Mock vectors are wiring-regression evidence only: reported, never written
  // into the baseline blob (§3.2).
  const mockVectors = await foldMockCorpus(corpus)
  for (const vector of [...Object.values(replayVectors), ...Object.values(mockVectors)]) {
    process.stdout.write(`${foldLine(vector)}${vector.capability === undefined ? '' : ` capability=${JSON.stringify(vector.capability)}`}\n`)
  }
  printDeferralNotice(deferred)
  process.stdout.write(`folded ${Object.keys(replayVectors).length} replay task(s) `
    + `+ ${Object.keys(mockVectors).length} mock task(s)\n${FOOTER}\n`)
  const writeBaseline = flagValue(argv, '--write-baseline')
  if (writeBaseline !== undefined) {
    writeFileSync(writeBaseline, `${JSON.stringify({
      foldedAt: new Date().toISOString(),
      ref: process.env.TOKEN_EFFICIENCY_BASELINE_REF ?? 'unpinned',
      vectors: replayVectors,
    }, null, 2)}\n`)
    process.stdout.write(`baseline written to ${writeBaseline}\n`)
  }
  return 0
}

async function check(argv: string[]): Promise<number> {
  const gatePath = flagValue(argv, '--gate') ?? DEFAULT_GATE
  const corpus = loadCorpus(argv)
  const gate = loadGate(gatePath, corpus)
  const baseline = loadBaseline(join(PKG_DIR, gate.baseline.vector))
  const { vectors: replayVectors, deferred } = foldReplayCorpus(corpus)
  const mockVectors = await foldMockCorpus(corpus)
  const vectors = { ...replayVectors, ...mockVectors }
  const { verdicts, ok } = runChecks({ corpus, candidateVectors: vectors, baseline, gate })
  for (const verdict of verdicts) {
    process.stdout.write(`${verdict.status === 'pass' ? 'PASS' : 'FAIL'} ${verdict.task} (${verdict.kind}): ${verdict.detail}\n`)
  }
  printDeferralNotice(deferred)
  for (const descriptor of corpus) {
    if (descriptor.kind !== 'replay' || replayVectors[descriptor.id] === undefined) continue
    const coverage = usageCoverage(readEvents(join(PKG_DIR, descriptor.fixture!)))
    process.stdout.write(`usage coverage ${descriptor.id}: ${coverage.withUsage}/${coverage.assistantMessages} assistant messages carry usage\n`)
  }
  process.stdout.write(`${FOOTER}\n`)
  return ok ? 0 : 1
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2)
  switch (subcommand) {
    case 'sanitize': process.exitCode = sanitize(rest); break
    case 'run': process.exitCode = await run(rest); break
    case 'check': process.exitCode = await check(rest); break
    default:
      usageError('usage: bin.ts <sanitize|run|check> [flags]')
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`token-efficiency: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
