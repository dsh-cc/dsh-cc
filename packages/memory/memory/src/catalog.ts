/**
 * The unified memory catalog: ONE scope-tagged enumeration of the memory
 * directories, rendered into the `memory` system-prompt section (design
 * docs/plans/2026-11-13-memory-section-unified-catalog.md §A-§F).
 *
 * Two properties this module owns outright:
 *
 * - **Ordering** (§C): pointers the layer's own entrypoint lists come first, in
 *   that order, interleaved round-robin across the canonical layer order; every
 *   remaining topic follows by filename. The order is total and deterministic —
 *   `localeCompare` with an explicit exact tie-break, never a locale-only sort.
 * - **Budgeting** (§D/§E): per-entry description trimming first, then whole
 *   entries dropped from the BOTTOM of the interleaved order, with a floor that
 *   keeps the header plus the ellipsis line rather than rendering nothing.
 *
 * The catalog keeps no state. It is a pure function of `(layers, options)`; the
 * `MemorySection` owner supplies the live settings and caches the per-directory
 * {@linkcode renderLayerFingerprint} it needs for `system-prompt/change`.
 * @module @dsh-cc/memory/catalog
 */

import { Buffer } from 'node:buffer'
import { firstPointerTarget } from './index-commit.ts'
import type { MemoryDirectoryState } from './scan.ts'
import type { MemoryIndexEntry } from './types.ts'

/** Scope tag a layer contributes to every one of its entries. */
export type MemoryLayerScope = 'workspace' | 'global' | 'team'

/** A memory layer surfaced in the section. */
export interface MemoryLayer {
  /** Scope tag shown in the combined catalog. */
  scope: MemoryLayerScope
  /**
   * Heading label for the layer's entrypoint block.
   * @deprecated Retained for API stability; the catalog no longer renders a
   * per-layer `## MEMORY.md (<label>)` block (design §A).
   */
  label: string
  /** The layer's directory. */
  dir: string
  /** The last scanned state, or `undefined` while the first scan is pending. */
  state: MemoryDirectoryState | undefined
}

/**
 * Budget for the catalog block. Every field resolves independently, so a
 * partially specified budget never forces a caller to infer a default
 * (design §G):
 *
 * - `truncate` omitted ⇒ `true` (passing a budget opts into capping);
 * - `maxBytes` omitted ⇒ the settings default;
 * - `descriptionMaxBytes` omitted ⇒ `0`, i.e. NO trimming — an existing caller
 *   must not silently get shortened descriptions.
 *
 * Omitting the whole budget keeps the historical uncapped, untrimmed render.
 */
export interface CombinedIndexBudget {
  /** Whether entries may be dropped at all (`false` renders the catalog complete). */
  truncate?: boolean
  /** UTF-8 byte ceiling for the whole catalog block; defaults to the settings default. */
  maxBytes?: number
  /** Per-entry description ceiling in UTF-8 bytes; `0` or absent = no trimming. */
  descriptionMaxBytes?: number
}

/** The catalog's fixed heading lines. */
export const MEMORY_CATALOG_HEADER: readonly string[] = ['## Memory index', '']

/** The canonical layer order the catalog interleaves over. */
const CANONICAL_SCOPES: readonly MemoryLayerScope[] = ['workspace', 'team', 'global']

/** One layer's topics, partitioned into the two passes §C defines. */
interface LayerPartition {
  /** The layer the partition came from. */
  layer: MemoryLayer
  /** Topics the layer's entrypoint lists, in entrypoint order, deduped. */
  maintained: MemoryIndexEntry[]
  /** Every other topic of this layer, sorted by {@linkcode compareFilename}. */
  tail: MemoryIndexEntry[]
}

/** One catalog entry plus the scope tag it renders with. */
interface RankedTopic {
  /** The scope tag shown in the rendered line. */
  scope: MemoryLayerScope
  /** The topic itself. */
  topic: MemoryIndexEntry
}

/**
 * The total filename comparator. `localeCompare` alone is NOT total: two
 * distinct filenames can collate equal (`é.md` versus `e` + U+0301 + `.md`), and
 * a locale-only sort would then follow directory enumeration order — a
 * fingerprint built on it would flip between scans and emit
 * `system-prompt/change` on an unchanged disk. The exact tie-break closes that.
 * @param a - left filename.
 * @param b - right filename.
 * @returns negative, zero, or positive per the total order.
 */
export function compareFilename(a: string, b: string): number {
  const collated = a.localeCompare(b)
  if (collated !== 0) return collated
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The layers to render, in canonical order, one per scope. When the input
 * repeats a scope, the FIRST occurrence wins — the selection the section always
 * had; this makes it explicit rather than incidental.
 * @param layers - the observed layers.
 * @returns the canonical, de-duplicated layer list.
 */
function canonicalLayers(layers: readonly MemoryLayer[]): MemoryLayer[] {
  const out: MemoryLayer[] = []
  for (const scope of CANONICAL_SCOPES) {
    const found = layers.find(layer => layer.scope === scope)
    if (found !== undefined) out.push(found)
  }
  return out
}

/**
 * Split one layer's topics into the maintained partition (what its entrypoint
 * lists, in entrypoint order) and the tail (everything else, sorted).
 *
 * The match is deliberately narrow (§C): the entrypoint's raw text is walked —
 * never `truncateEntrypointContent`, so pointers past the 25 KB read cap still
 * order the catalog — and a line's first pointer target must be byte-equal to a
 * same-layer topic's `filename`. No path/basename stripping, no URI decoding, no
 * Unicode normalization, no case folding, and no fallback to a second link on
 * the same line: anything that misses falls to the tail.
 * @param layer - the layer to partition.
 * @returns the partition.
 */
function partition(layer: MemoryLayer): LayerPartition {
  const topics = layer.state?.topics ?? []
  const byFilename = new Map(topics.map(topic => [topic.filename, topic]))
  const maintained: MemoryIndexEntry[] = []
  const taken = new Set<string>()
  for (const line of (layer.state?.entrypoint ?? '').split('\n')) {
    const target = firstPointerTarget(line)
    if (target === undefined || taken.has(target)) continue
    const topic = byFilename.get(target)
    if (topic === undefined) continue
    taken.add(target)
    maintained.push(topic)
  }
  const tail = topics
    .filter(topic => !taken.has(topic.filename))
    .sort((a, b) => compareFilename(a.filename, b.filename))
  return { layer, maintained, tail }
}

/** Tag one layer's topic list with its scope, preserving the list order. */
function tagged(part: LayerPartition, topics: readonly MemoryIndexEntry[]): RankedTopic[] {
  return topics.map(topic => ({ scope: part.layer.scope, topic }))
}

/**
 * Round-robin over per-layer buckets: round `i` takes every bucket's `i`-th
 * entry in canonical order. A pass ends when its longest bucket is exhausted;
 * an exhausted or empty bucket contributes nothing and does not shift the other
 * buckets' rounds. Within a bucket the existing order is preserved verbatim.
 * @param buckets - per-layer entry lists in canonical order.
 * @returns the interleaved list.
 */
function interleave(buckets: readonly RankedTopic[][]): RankedTopic[] {
  const out: RankedTopic[] = []
  const rounds = buckets.reduce((most, bucket) => Math.max(most, bucket.length), 0)
  for (let round = 0; round < rounds; round += 1) {
    for (const bucket of buckets) {
      const entry = bucket[round]
      if (entry !== undefined) out.push(entry)
    }
  }
  return out
}

/**
 * Escape the parts of a topic name that would break a Markdown link.
 * @param name - the frontmatter name.
 * @returns the escaped link text.
 */
function escapeLinkText(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
}

/**
 * Trim one description to a UTF-8 byte ceiling (§D). Walks code points, never
 * bytes or UTF-16 units, so a multi-byte character or surrogate pair is never
 * split; the `…` suffix is budgeted inside the ceiling.
 * @param description - the raw frontmatter description.
 * @param maxBytes - the ceiling; `0` disables trimming.
 * @returns the description, possibly shortened and ending in `…`.
 */
export function trimDescription(description: string, maxBytes: number): string {
  if (maxBytes <= 0 || description.length === 0) return description
  if (Buffer.byteLength(description, 'utf8') <= maxBytes) return description
  const ellipsisBytes = Buffer.byteLength('…', 'utf8')
  const budget = maxBytes - ellipsisBytes
  if (budget <= 0) return '…'
  let kept = ''
  let used = 0
  for (const character of description) {
    const cost = Buffer.byteLength(character, 'utf8')
    if (used + cost > budget) break
    kept += character
    used += cost
  }
  return `${kept}…`
}

/**
 * The ellipsis line standing in for the omitted tail of the catalog.
 * @param omitted - how many entries were dropped (entries, not lines).
 * @returns the ellipsis line.
 */
export function ellipsisLine(omitted: number): string {
  return `… (${omitted} more memory topics; grep the memory directory)`
}

/** UTF-8 size of a catalog block, newline-joined exactly as it renders. */
function blockBytes(lines: readonly string[]): number {
  return Buffer.byteLength(lines.join('\n'), 'utf8')
}

/**
 * Fit rendered entry lines into the block budget by dropping whole entries from
 * the BOTTOM of the interleaved order — never a partial line, so multi-byte text
 * is never sliced, and the surviving text is an early prefix of that order.
 *
 * Floor rule: the ellipsis line always survives, so the block can render the
 * header plus the ellipsis with no entries. The budget is a cap above the floor,
 * never below it.
 * @param entries - rendered entry lines, interleaved order.
 * @param maxBytes - the block ceiling in UTF-8 bytes.
 * @returns the entry lines to render (all, an early prefix + ellipsis, or none).
 */
export function fitCatalog(entries: readonly string[], maxBytes: number): string[] {
  if (blockBytes([...MEMORY_CATALOG_HEADER, ...entries]) <= maxBytes) return [...entries]
  for (let kept = entries.length - 1; kept > 0; kept -= 1) {
    const candidate = [
      ...MEMORY_CATALOG_HEADER,
      ...entries.slice(0, kept),
      ellipsisLine(entries.length - kept),
    ]
    if (blockBytes(candidate) <= maxBytes) return candidate.slice(MEMORY_CATALOG_HEADER.length)
  }
  return [ellipsisLine(entries.length)]
}

/**
 * Render one catalog line (§B): the format is byte-compatible with the index it
 * replaces, so only the description CONTENT changes under trimming.
 * @param ranked - the topic and its scope tag.
 * @param descriptionMaxBytes - the trimming ceiling; `0` disables it.
 * @returns the rendered line.
 */
function renderEntry(ranked: RankedTopic, descriptionMaxBytes: number): string {
  const { filename, frontmatter } = ranked.topic
  const type = frontmatter.type === undefined ? '' : ` [${frontmatter.type}]`
  const description = trimDescription(frontmatter.description, descriptionMaxBytes)
  return `- [${escapeLinkText(frontmatter.name)}](${filename}) — ${description} (${ranked.scope})${type}`
}

/**
 * Render the catalog block: the heading, a blank line, and the kept entries.
 * Two passes, both interleaved the same way (§C): the maintained partition, then
 * the tail. Layer index is never a sort key — the round-robin IS the cross-layer
 * order, so a topic's scope only decides which round it takes.
 * @param layers - the observed layers.
 * @param options - the resolved catalog options.
 * @returns the block lines, or `[]` when no layer holds a topic (the caller
 *   then renders its `(no memories yet)` placeholder).
 */
export function renderCatalog(
  layers: readonly MemoryLayer[],
  options: Required<CombinedIndexBudget>,
): string[] {
  const partitions = canonicalLayers(layers).map(layer => partition(layer))
  const entries = [
    ...interleave(partitions.map(part => tagged(part, part.maintained))),
    ...interleave(partitions.map(part => tagged(part, part.tail))),
  ].map(entry => renderEntry(entry, options.descriptionMaxBytes))
  if (entries.length === 0) return []
  const kept = options.truncate ? fitCatalog(entries, options.maxBytes) : entries
  return [...MEMORY_CATALOG_HEADER, ...kept]
}

/**
 * A scope-free fingerprint of everything one directory contributes to the
 * catalog, used ONLY as the `system-prompt/change` comparison key (§F).
 *
 * Three segments: the maintained order, the tail order, and the raw frontmatter
 * of every topic. It is deliberately not rendered text — the catalog's order
 * depends on OTHER layers too, and scope tags are not knowable from a directory
 * path. Including the raw (untrimmed) description means a description edit that
 * trimming hides from the rendered text still emits: over-firing costs one
 * identical reassembly, under-firing serves a stale section.
 * @param state - the scanned directory state, or `undefined` when unscanned.
 * @returns the fingerprint string.
 */
export function renderLayerFingerprint(state: MemoryDirectoryState | undefined): string {
  const layer: MemoryLayer = { scope: 'workspace', label: '', dir: state?.dir ?? '', state }
  const { maintained, tail } = partition(layer)
  const sorted = [...(state?.topics ?? [])].sort((a, b) => compareFilename(a.filename, b.filename))
  const fields = sorted.map(topic => [
    topic.filename,
    topic.frontmatter.name,
    topic.frontmatter.description,
    topic.frontmatter.type ?? null,
  ])
  return [
    `P${JSON.stringify(maintained.map(topic => topic.filename))}`,
    `T${JSON.stringify(tail.map(topic => topic.filename))}`,
    `F${JSON.stringify(fields)}`,
  ].join('\n')
}
