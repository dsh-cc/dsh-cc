/**
 * Closed memory-type taxonomy and rationalized frontmatter for `dsh-memory`
 * topic files.
 * @module @dsh-cc/memory/types
 */

/** The four memory types a topic file may declare. */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const

/** One valid memory type; unknown or absent values degrade gracefully. */
export type MemoryType = (typeof MEMORY_TYPES)[number]

/**
 * Parse a raw frontmatter `type` value into a {@link MemoryType}.
 * @param raw - the value read from a topic file's frontmatter.
 * @returns the matching type, or `undefined` for missing or unknown values.
 */
export function parseMemoryType(raw: unknown): MemoryType | undefined {
  return typeof raw === 'string'
    ? MEMORY_TYPES.find(type => type === raw)
    : undefined
}

/** One topic file's rationalized frontmatter header. */
export interface MemoryFrontmatter {
  /** Topic name used as the MEMORY.md index title. */
  name: string
  /** One-line relevance description presented to the recall selector. */
  description: string
  /** Topic type, or `undefined` for legacy files without a `type` field. */
  type?: MemoryType
}

/** A topic file discovered in a memory directory, with its rationalized header. */
export interface MemoryIndexEntry {
  /** Absolute path of the topic file. */
  path: string
  /** Basename used to join a MEMORY.md pointer and to dedupe recall. */
  filename: string
  /** Rationalized frontmatter (name/description/type). */
  frontmatter: MemoryFrontmatter
}
