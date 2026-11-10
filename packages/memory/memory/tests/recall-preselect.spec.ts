/**
 * Specs for the deterministic lexical pre-selection of the decision arm
 * (issue #363; design docs/plans/2026-11-02-systemone-03-memory-recall.md
 * §"Complete batching and deterministic filtering").
 *
 * The module is pure and content-local: every case here builds an explicit pool
 * and asserts the kept set, the preserved IDs and the total order, so the
 * ranking can never drift with a locale or an input order.
 */
import { describe, expect, it } from 'vitest'
import { preselectRecallTopics } from '../src/recall-preselect.ts'
import type { RecallTopic } from '../src/recall-decision.ts'

/** One candidate with a stable ID and overridable metadata. */
function topic(id: string, overrides: Partial<RecallTopic> = {}): RecallTopic {
  return {
    id,
    scope: 'workspace',
    path: `/repo/.dsh/memory/${id}.md`,
    filename: `${id}.md`,
    name: `Topic ${id}`,
    description: `Description ${id}`,
    contentHash: `sha256:${id}`,
    ...overrides,
  }
}

describe('preselectRecallTopics: identity and preservation', () => {
  it('returns the pool untouched when it already fits the cap', () => {
    const topics = [topic('m0000'), topic('m0001')]
    expect(preselectRecallTopics(topics, 'anything', 2)).toEqual(topics)
    expect(preselectRecallTopics(topics, 'anything', 9)).toEqual(topics)
  })

  it('returns an empty pool as an empty result', () => {
    expect(preselectRecallTopics([], 'anything', 4)).toEqual([])
  })

  it('filters in place: caller IDs survive and the canonical order is kept', () => {
    const topics = Array.from({ length: 6 }, (_, index) =>
      topic(`m${String(index).padStart(4, '0')}`, { filename: `topic-${index}.md` }))
    const kept = preselectRecallTopics(topics, 'unmatched query', 3)
    expect(kept).toHaveLength(3)
    // Every kept entry is the caller's own object — no re-numbering, no copies.
    for (const entry of kept) expect(topics).toContain(entry)
    const keptIds = kept.map(entry => entry.id)
    expect(keptIds).toEqual(topics.map(entry => entry.id).filter(id => keptIds.includes(id)))
  })

  it('keeps the same set for the same pool and query', () => {
    const topics = [
      topic('m0000', { name: '记忆召回策略', description: '按需注入相关记忆' }),
      topic('m0001', { name: '构建流水线', description: '编译与部署步骤' }),
      topic('m0002', { filename: 'memory-recall.md', name: 'Recall notes', description: 'Selection pipeline' }),
      topic('m0003', { name: 'Cooking', description: 'pasta' }),
    ]
    const first = preselectRecallTopics(topics, 'memory 记忆召回', 2).map(entry => entry.id)
    const second = preselectRecallTopics(topics, 'memory 记忆召回', 2).map(entry => entry.id)
    expect(second).toEqual(first)
  })
})

describe('preselectRecallTopics: ranking', () => {
  it('ranks a topic sharing Han bigrams with the query above an unrelated Chinese topic', () => {
    const relevant = topic('m0000', { name: '记忆召回策略', description: '按需注入相关记忆' })
    const irrelevant = topic('m0001', { name: '构建流水线', description: '编译与部署步骤' })
    // Chinese vs Chinese: single-codepoint units would saturate on shared
    // function words, the bigrams are what separate these two.
    expect(preselectRecallTopics([irrelevant, relevant], '记忆召回', 1)).toEqual([relevant])
  })

  it('counts a query unit that equals a filename token', () => {
    const byFilename = topic('m0000', { filename: 'vitest.md', name: 'Retry limit', description: 'random failures' })
    // Sorts BEFORE `vitest.md`, so it only loses on the filename-token bonus.
    const earlierName = topic('m0001', { filename: 'aaa.md', name: 'Cooking', description: 'pasta' })
    expect(preselectRecallTopics([byFilename, earlierName], 'vitest', 1)).toEqual([byFilename])
  })

  it('counts a query unit contained in name or description', () => {
    const inDescription = topic('m0000', { filename: 'zzz.md', name: 'Notes', description: 'Flaky retries on CI' })
    const unrelated = topic('m0001', { filename: 'aaa.md', name: 'Cooking', description: 'pasta' })
    expect(preselectRecallTopics([inDescription, unrelated], 'flaky', 1)).toEqual([inDescription])
  })
})

describe('preselectRecallTopics: tie-break chain', () => {
  it('breaks a filename tie by scope, and ranks global before workspace', () => {
    const workspace = topic('m0000', { scope: 'workspace', filename: 'rules.md', path: '/w/rules.md' })
    const global = topic('m0001', { scope: 'global', filename: 'rules.md', path: '/g/rules.md' })
    expect(preselectRecallTopics([workspace, global], 'unmatched', 1)).toEqual([global])
  })

  it('breaks a filename-and-scope tie by the canonical path', () => {
    const later = topic('m0000', { filename: 'rules.md', path: '/b/rules.md' })
    const earlier = topic('m0001', { filename: 'rules.md', path: '/a/rules.md' })
    expect(preselectRecallTopics([later, earlier], 'unmatched', 1)).toEqual([earlier])
  })

  it('breaks a zero-score tie by filename before scope', () => {
    const zed = topic('m0000', { scope: 'global', filename: 'zed.md' })
    const alpha = topic('m0001', { scope: 'workspace', filename: 'alpha.md' })
    expect(preselectRecallTopics([zed, alpha], 'unmatched', 1)).toEqual([alpha])
  })

  it('drops the lowest-ranked candidates deterministically when no unit matches', () => {
    const topics = [
      topic('m0000', { filename: 'c.md' }),
      topic('m0001', { filename: 'a.md' }),
      topic('m0002', { filename: 'b.md' }),
    ]
    // Equal scores: the kept set is the UTF-8 filename order, the array itself
    // stays canonical.
    expect(preselectRecallTopics(topics, 'zzz', 2).map(entry => entry.id)).toEqual(['m0001', 'm0002'])
  })
})
