/**
 * Deterministic lexical pre-selection for the memory-recall decision arm (issue
 * #363; design docs/plans/2026-11-02-systemone-03-memory-recall.md
 * §"Complete batching and deterministic filtering").
 *
 * The SystemOne arm can only judge a bounded pool: one `noul` question per
 * candidate, so a 475-topic corpus exceeds both `max-candidates` (96) and the
 * route's question ceiling, and the whole run degraded silently before route
 * resolution. This module cuts the judged pool down to a deterministic,
 * recorded top-K instead — the caller's pool is NEVER narrowed, so the legacy
 * fallback and the shadow comparison keep seeing every candidate.
 *
 * Ranking is content-local and pure: the query's `\s+`-split tokens plus its Han
 * bigrams are matched against each candidate's name, description and filename
 * tokens. Single Han codepoints saturate on a Chinese corpus (shared function
 * words), so bigrams carry the relevance signal; a run of two or more Han
 * codepoints contributes its bigrams, an isolated one backs off to a unigram.
 *
 * The total order is score desc, then INDEX MEMBERSHIP for the topic's own
 * layer (indexed first, when a membership map is provided), then the UTF-8
 * byte order of filename, scope and path. The scope/path legs are LOCAL
 * tie-breaks only (note: scope order ranks `global` before `workspace`, the
 * opposite of the canonical scope-then-path ID assignment) and never cross
 * the wire.
 *
 * @module @dsh-cc/memory/recall-preselect
 */

import { compareUtf8 } from './recall-decision.ts'
import type { RecallTopic } from './recall-decision.ts'

/** A run of Han codepoints in a query or in a filename. */
const HAN_RUN = /\p{Script=Han}+/gu

/** Token separator of a filename: any non-alphanumeric, non-Han run. */
const TOKEN_SEPARATOR = /[^\p{L}\p{N}]+/u

/**
 * The query's match units: `\s+`-split tokens (lowercased) plus Han bigrams.
 *
 * A Han run of two or more codepoints contributes its overlapping bigrams; a
 * single-codepoint run contributes itself (unigram backoff). Duplicates count
 * once, so a repeated token never doubles a candidate's score.
 * @param query - the recall query.
 * @returns the deduplicated units.
 */
function queryUnits(query: string): string[] {
  const lowered = query.toLowerCase()
  const units = new Set<string>()
  for (const token of lowered.split(/\s+/u)) {
    if (token.length > 0) units.add(token)
  }
  for (const run of lowered.match(HAN_RUN) ?? []) {
    const codepoints = [...run]
    if (codepoints.length === 1) units.add(codepoints[0]!)
    for (let index = 0; index + 1 < codepoints.length; index += 1) {
      units.add(`${codepoints[index]}${codepoints[index + 1]}`)
    }
  }
  return [...units]
}

/** A filename's tokens (lowercased, split on non-alphanumeric/non-Han runs). */
function filenameTokens(filename: string): Set<string> {
  return new Set(filename.toLowerCase().split(TOKEN_SEPARATOR).filter(token => token.length > 0))
}

/**
 * Per-layer membership of the memory index (MEMORY.md): the basenames the
 * index of each layer's own directory currently references. The index is the
 * memory system's maintained view of currently-tracked memories, so
 * "indexed" is the principled tie-break between lexically-tied candidates —
 * never a score, and never crossing layers (a workspace index entry never
 * promotes a global namesake).
 */
export interface RecallIndexedLayers {
  /** Basenames referenced by the workspace layer's MEMORY.md. */
  workspace?: ReadonlySet<string>
  /** Basenames referenced by the global layer's MEMORY.md. */
  global?: ReadonlySet<string>
}

/**
 * Extract the basenames a memory-index text references. Two line shapes
 * exist in the wild and both are accepted, line-anchored:
 * `… [label](name.md) …` (the production format, with or without a link
 * title) and `… (name.md)` at end of line (the eval fixture's
 * `- Label: … (name.md)`).
 *
 * Every `(...)` group on a line contributes each whitespace-separated token
 * that ends in `.md`; tokens containing `://` are rejected (external links);
 * directory prefixes are dropped and the BASENAME is recorded. Pure and
 * bounded: no matches (or empty text) yields an empty set.
 * @param entrypoint - the MEMORY.md text the scan already returned.
 * @returns the referenced basenames.
 */
export function parseIndexedBasenames(entrypoint: string): ReadonlySet<string> {
  const names = new Set<string>()
  for (const group of entrypoint.match(/\(([^)]+)\)/g) ?? []) {
    for (const token of group.slice(1, -1).split(/\s+/u)) {
      if (!token.endsWith('.md') || token.includes('://')) continue
      names.add(token.slice(token.lastIndexOf('/') + 1))
    }
  }
  return names
}

/**
 * One candidate's lexical score against the query units: one point per unit
 * contained in `name + ' ' + description`, plus one point per unit equal to a
 * filename token.
 * @param topic - the candidate.
 * @param units - the query units.
 * @param tokens - the candidate's filename tokens.
 * @returns the score (0 when nothing matches).
 */
function scoreTopic(topic: RecallTopic, units: readonly string[], tokens: ReadonlySet<string>): number {
  const haystack = `${topic.name} ${topic.description}`.toLowerCase()
  let score = 0
  for (const unit of units) {
    if (haystack.includes(unit)) score += 1
    if (tokens.has(unit)) score += 1
  }
  return score
}

/**
 * Rank a pool by the pre-selection total order without cutting it: score
 * descending, then UTF-8 filename, scope and path. The result is a new array
 * (best first) of the caller's own entries; IDs are never touched.
 *
 * The selector's trim loop re-uses this order to drop the lowest-ranked
 * remaining candidate, so ranking exists in exactly one place. BOTH rank
 * consumers (the pre-selection cut and the trim re-rank) must pass the same
 * membership map, or the trim can re-drop exactly the topics the cut
 * rescued.
 * @param topics - the candidate pool.
 * @param query - the recall query.
 * @param indexed - the per-layer index membership (tie-break only; absent
 *   is exactly the shipped order).
 * @returns the pool sorted best-first.
 */
export function rankRecallTopics(
  topics: readonly RecallTopic[],
  query: string,
  indexed?: Readonly<RecallIndexedLayers>,
): RecallTopic[] {
  const units = queryUnits(query)
  return topics
    .map(topic => ({
      topic,
      score: scoreTopic(topic, units, filenameTokens(topic.filename)),
      member: indexed?.[topic.scope]?.has(topic.filename) ? 1 : 0,
    }))
    .sort((a, b) =>
      b.score - a.score ||
      b.member - a.member ||
      compareUtf8(a.topic.filename, b.topic.filename) ||
      compareUtf8(a.topic.scope, b.topic.scope) ||
      compareUtf8(a.topic.path, b.topic.path))
    .map(entry => entry.topic)
}

/**
 * Keep the top `cap` candidates by the pre-selection total order.
 *
 * FILTERS the caller's pool: the returned array holds the caller's own entries
 * with their existing IDs, in the input (canonical) order — never re-numbered,
 * never re-ordered. A pool that already fits the cap is returned as a copy.
 * @param topics - the complete ID-assigned pool.
 * @param query - the recall query.
 * @param cap - how many candidates may be kept.
 * @param indexed - the per-layer index membership (tie-break only; absent
 *   is exactly the shipped behavior).
 * @returns the kept candidates in canonical order.
 */
export function preselectRecallTopics(
  topics: readonly RecallTopic[],
  query: string,
  cap: number,
  indexed?: Readonly<RecallIndexedLayers>,
): RecallTopic[] {
  if (topics.length <= cap) return [...topics]
  const keep = new Set(rankRecallTopics(topics, query, indexed).slice(0, Math.max(cap, 0)))
  return topics.filter(topic => keep.has(topic))
}
