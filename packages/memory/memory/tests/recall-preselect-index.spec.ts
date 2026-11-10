/**
 * Pins for the pre-selection index-membership tie-break (PR-A).
 *
 * On CJK-heavy corpora the lexical score is dominated by function-word
 * bigrams that nearly every description contains: the useful topics TIE
 * with masses of legacy topics, and the shipped tie-break (filename UTF-8
 * byte order) is an alphabetical accident that starves later-alphabet
 * recent memories. The memory index (MEMORY.md) is the memory system's own
 * maintained view of currently-tracked memories, so "indexed" is the
 * principled tie-break: score stays primary, indexed outranks unindexed
 * AT EQUAL SCORE, and the rest of the deterministic chain is unchanged.
 */

import { describe, expect, it } from 'vitest'
import {
  parseIndexedBasenames,
  preselectRecallTopics,
  rankRecallTopics,
  type RecallIndexedLayers,
} from '../src/recall-preselect.ts'
import type { RecallTopic } from '../src/recall-decision.ts'
import { recallManifestHash } from '../src/recall-dispatch-key.ts'
import { planJudgedRecallBatches } from '../src/recall-decision-plan.ts'

/** A minimal topic at a chosen scope. */
function topic(filename: string, scope: 'workspace' | 'global' = 'workspace', score = 0): RecallTopic {
  return {
    id: filename,
    scope,
    path: `/${scope}/${filename}`,
    filename,
    name: `name ${filename}`,
    description: `desc ${filename}`,
    contentHash: '',
  } as unknown as RecallTopic
}

const NO_MATCH_QUERY = 'zzqqxx yywwvv' // matches no name/description below

describe('rankRecallTopics — index-membership tie-break', () => {
  it('breaks score ties indexed-first, keeping the existing chain inside groups', () => {
    const pool = [
      topic('a-legacy.md'),
      topic('m-recent.md'),
      topic('z-recent.md'),
    ]
    const indexed: RecallIndexedLayers = { workspace: new Set(['m-recent.md', 'z-recent.md']) }
    // Without the map: the shipped chain (filename byte order).
    expect(rankRecallTopics(pool, NO_MATCH_QUERY).map(t => t.filename))
      .toEqual(['a-legacy.md', 'm-recent.md', 'z-recent.md'])
    // With the map: the indexed pair outranks the unindexed one at equal
    // score; their internal order still follows the existing chain.
    expect(rankRecallTopics(pool, NO_MATCH_QUERY, indexed).map(t => t.filename))
      .toEqual(['m-recent.md', 'z-recent.md', 'a-legacy.md'])
  })

  it('lexical score outranks membership: unindexed 2 beats indexed 1', () => {
    // 'strong' hits a's haystack AND a's filename token (2 points);
    // 'weak' hits b's haystack only — its filename token is 'idxweak' (1 point).
    const a = { ...topic('a-unindexed-strong.md'), name: 'strong', description: 'strong' } as RecallTopic
    const b = { ...topic('b-idxweak.md'), name: 'weak', description: 'weak' } as RecallTopic
    const indexed: RecallIndexedLayers = { workspace: new Set(['b-idxweak.md']) }
    expect(rankRecallTopics([b, a], 'strong weak', indexed).map(t => t.filename))
      .toEqual(['a-unindexed-strong.md', 'b-idxweak.md'])
  })

  it('membership is per-layer: a global namesake is not promoted by the workspace index', () => {
    const pool = [
      topic('rules.md', 'global'),
      topic('rules.md', 'workspace'),
    ]
    const indexed: RecallIndexedLayers = { workspace: new Set(['rules.md']) }
    const order = rankRecallTopics(pool, NO_MATCH_QUERY, indexed)
    // The workspace namesake is indexed (member=1) and ranks first; the
    // global namesake was NOT promoted by the workspace index (member=0)
    // and keeps the shipped chain position.
    expect(order[0]!.filename).toBe('rules.md')
    expect(order[0]!.scope).toBe('workspace')
    expect(order[1]!.scope).toBe('global')
  })

  it('no map provided is exactly the shipped order', () => {
    const pool = [topic('b.md'), topic('a.md'), topic('c.md', 'global')]
    expect(rankRecallTopics(pool, NO_MATCH_QUERY)).toEqual(rankRecallTopics(pool, NO_MATCH_QUERY, undefined))
  })
})

describe('parseIndexedBasenames', () => {
  it('parses the production link format, including titles and multiple refs per line', () => {
    const text = [
      '# Memory index',
      '- [one](one.md) — desc',
      '- [two](two.md "with title") desc',
      'prose with [three](three.md) and [four](four.md) refs',
    ].join('\n')
    expect(parseIndexedBasenames(text)).toEqual(new Set(['one.md', 'two.md', 'three.md', 'four.md']))
  })

  it('parses the fixture trailing-paren format and drops directory prefixes', () => {
    const text = '- Label: description (projects/x/name.md)\n- Other: d (plain.md)'
    expect(parseIndexedBasenames(text)).toEqual(new Set(['name.md', 'plain.md']))
  })

  it('rejects external URLs and non-.md targets; no matches yields an empty set', () => {
    const text = [
      '- [ext](https://example.org/rules.md) external',
      '- [doc](doc.txt) not markdown',
      '- []() empty',
      'nothing here',
    ].join('\n')
    expect(parseIndexedBasenames(text)).toEqual(new Set())
    expect(parseIndexedBasenames('')).toEqual(new Set())
  })
})

describe('preselectRecallTopics — keeps the indexed topic the shipped order dropped', () => {
  it('a pool over the cap keeps indexed candidates ahead of tied legacy ones', () => {
    // 5 topics, cap 2, all tied on score: shipped keeps a-legacy + b-legacy
    // (byte order); with the index map it keeps the indexed pair.
    const pool = [
      topic('a-legacy.md'),
      topic('b-legacy.md'),
      topic('c-legacy.md'),
      topic('m-recent.md'),
      topic('n-recent.md'),
    ]
    const indexed: RecallIndexedLayers = { workspace: new Set(['m-recent.md', 'n-recent.md']) }
    expect(preselectRecallTopics(pool, NO_MATCH_QUERY, 2).map(t => t.filename))
      .toEqual(['a-legacy.md', 'b-legacy.md'])
    expect(preselectRecallTopics(pool, NO_MATCH_QUERY, 2, indexed).map(t => t.filename))
      .toEqual(['m-recent.md', 'n-recent.md'])
  })
})

describe('recallManifestHash — index-only edits invalidate the dispatch key', () => {
  it('same topics, different membership maps produce different digests', () => {
    const rows = [
      { scope: 'workspace', path: '/w/a.md', contentHash: 'h1' },
      { scope: 'global', path: '/g/b.md', contentHash: 'h2' },
    ] as const
    const m1 = { workspace: new Set(['a.md']), global: new Set() }
    const m2 = { workspace: new Set(['a.md', 'b.md']), global: new Set() }
    const base = recallManifestHash(rows)
    expect(recallManifestHash(rows, m1)).not.toBe(recallManifestHash(rows, m2))
    expect(recallManifestHash(rows, m1)).not.toBe(base)
  })

  it('membership insertion order does not change the digest', () => {
    const rows = [{ scope: 'workspace', path: '/w/a.md', contentHash: 'h1' }] as const
    const m1 = { workspace: new Set(['x.md', 'a.md']) }
    const m2 = { workspace: new Set(['a.md', 'x.md']) }
    expect(recallManifestHash(rows, m1)).toBe(recallManifestHash(rows, m2))
  })
})

describe('planJudgedRecallBatches — membership threading', () => {
  const identity = {
    provider: 'p', model: 'm', revision: 'r',
    perRequestTokens: 1_000_000, perQuestionTokens: 1_000_000, maxQuestions: 32, maxOutputTokens: 4096,
  } as const

  it('the pre-selection cut keeps the indexed topics the shipped order dropped', async () => {
    const pool = ['a-legacy.md', 'b-legacy.md', 'c-legacy.md', 'd-legacy.md', 'm-recent.md', 'n-recent.md']
      .map(f => topic(f))
    const settings = { mode: 'active', timeoutMs: 1000, maxInputTokens: 6000, maxCandidates: 4, batchSize: 24, includeProbability: 0.75, excludeProbability: 0.25 } as const
    const input = { query: NO_MATCH_QUERY, recentTools: [], topics: pool }
    const plan = planJudgedRecallBatches(pool, input, settings, identity)
    expect(plan!.flat().map(t => t.filename)).toEqual(['a-legacy.md', 'b-legacy.md', 'c-legacy.md', 'd-legacy.md'])
    // maxCandidates=4 keeps FOUR topics: with the map the ranked top-4 are
    // the indexed pair plus the first two legacy files (canonical order).
    const withMap = planJudgedRecallBatches(pool, { ...input, indexedFilenames: { workspace: new Set(['m-recent.md', 'n-recent.md']) } }, settings, identity)
    expect(withMap!.flat().map(t => t.filename)).toEqual(['a-legacy.md', 'b-legacy.md', 'm-recent.md', 'n-recent.md'])
  })

  it('the TRIM re-rank also uses the map: the forced-trim survivor is the indexed topic', async () => {
    // Admission fits one topic per batch (huge descriptions, small
    // maxInputTokens), so a 4-topic pre-selected pool plans 4 batches
    // against a cap of ceil(4/24) = 1: the trim loop must drop survivors
    // until one batch remains. The survivor is the highest-ranked topic —
    // with the map that is the indexed one; without it the byte-order one.
    const big = 'x'.repeat(4_000)
    const pool = ['a-legacy.md', 'b-legacy.md', 'm-recent.md', 'z-recent.md']
      .map(f => ({ ...topic(f), name: big, description: big }) as RecallTopic)
    const settings = { mode: 'active', timeoutMs: 1000, maxInputTokens: 5000, maxCandidates: 4, batchSize: 24, includeProbability: 0.75, excludeProbability: 0.25 } as const
    const input = { query: NO_MATCH_QUERY, recentTools: [], topics: pool }
    const base = planJudgedRecallBatches(pool, input, settings, identity)
    expect(base!.flat().map(t => t.filename)).toEqual(['a-legacy.md', 'b-legacy.md'])
    const withMap = planJudgedRecallBatches(pool, { ...input, indexedFilenames: { workspace: new Set(['m-recent.md', 'z-recent.md']) } }, settings, identity)
    expect(withMap!.flat().map(t => t.filename)).toEqual(['m-recent.md', 'z-recent.md'])
  })
})

describe('eval fixture neutrality', () => {
  it('the fixture corpus ranks identically with and without its own index', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const fixtures = join(import.meta.dirname, '..', 'eval', 'fixture-memory')
    const text = readFileSync(join(fixtures, 'MEMORY.md'), 'utf8')
    const indexed = parseIndexedBasenames(text)
    const files = readdirSync(fixtures).filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
    const pool = files.map(f => topic(f))
    // The fixture index references every topic (checked, not assumed).
    expect(files.every(f => indexed.has(f))).toBe(true)
    expect(pool.length).toBeGreaterThan(0)
    expect(
      rankRecallTopics(pool, 'recall one-shot safety', { workspace: indexed }).map(t => t.filename),
    ).toEqual(
      rankRecallTopics(pool, 'recall one-shot safety').map(t => t.filename),
    )
  })
})
