/**
 * Host-side pointer upserts for the extraction write-back (design
 * docs/plans/2026-11-12-extraction-index-coverage-fix.md §A.3): the pointer
 * line is rendered from the batch's OWN frontmatter with sanitized display text,
 * and the upsert only ever consumes a line whose FIRST pointer target is the
 * batch path and which carries no other target.
 */
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { renderExtractionPointer, sanitizePointerText, upsertExtractionPointer } from '../src/extraction-upsert.ts'
import { MAX_DESCRIPTION_CHARS } from '../src/save.ts'
import { MAX_ENTRYPOINT_BYTES, MAX_ENTRYPOINT_LINES } from '../src/truncate.ts'

/** Every `](<name>.md)` target on a line (the pointer target set). */
function targets(line: string): string[] {
  return [...line.matchAll(/\]\(([^()\s]+\.md)\)/g)].map(match => match[1]!)
}

/**
 * An index of `lines` pointer lines whose trimmed size is EXACTLY `bytes` UTF-8
 * bytes (the last line carries the padding).
 */
function sizedIndex(bytes: number, firstLine = '- [batch](batch.md) — old', lines = 5): string {
  const body = [firstLine, ...Array.from({ length: lines - 1 }, (_, i) => `- [pad-${i}](pad-${i}.md) — pad`)].join('\n')
  const missing = bytes - Buffer.byteLength(body, 'utf8')
  return `${body}${'x'.repeat(missing)}\n`
}

describe('renderExtractionPointer', () => {
  it('renders one pointer line with the batch path as the link target', () => {
    const { line, warnings } = renderExtractionPointer('topic-b.md', { name: 'Topic B', description: 'does B' })
    expect(line).toBe('- [Topic B](topic-b.md) — does B')
    expect(warnings).toEqual([])
    expect(targets(line)).toEqual(['topic-b.md'])
  })

  it('links the batch path, never the frontmatter name', () => {
    const { line } = renderExtractionPointer('2026-11-12-odd-file.md', { name: 'Pretty Name', description: 'd' })
    expect(targets(line)).toEqual(['2026-11-12-odd-file.md'])
    expect(line).toContain('- [Pretty Name](2026-11-12-odd-file.md) — d')
  })

  it('neutralizes markdown link syntax and newlines in the display text', () => {
    const { line } = renderExtractionPointer('batch.md', {
      name: 'Evil](foreign.md)',
      description: 'first line\nsecond line with [link](foreign.md)',
    })
    // One line, one pointer target: no manufactured secondary pointer.
    expect(line.split('\n')).toHaveLength(1)
    expect(targets(line)).toEqual(['batch.md'])
    expect(line).toContain('Evilforeign.md')
  })

  it('clamps the description to MAX_DESCRIPTION_CHARS and warns', () => {
    const { line, warnings } = renderExtractionPointer('batch.md', {
      name: 'Name',
      description: 'y'.repeat(MAX_DESCRIPTION_CHARS + 50),
    })
    const rendered = line.slice(line.indexOf(' — ') + 3)
    expect(rendered).toHaveLength(MAX_DESCRIPTION_CHARS)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('truncated')
    expect(warnings[0]).toContain('batch.md')
  })

  it('sanitizePointerText collapses whitespace and strips link syntax', () => {
    expect(sanitizePointerText('  a\n\n b [c](d.md)  ')).toBe('a b cd.md')
  })
})

describe('upsertExtractionPointer', () => {
  it('appends an unmatched pointer', () => {
    const index = '- [a](a.md) — A\n'
    const result = upsertExtractionPointer(index, 'b.md', '- [b](b.md) — B')
    expect(result.content).toBe('- [a](a.md) — A\n- [b](b.md) — B\n')
    expect(result.action).toBe('appended')
    expect(result.warning).toBeUndefined()
  })

  it('creates the index content when the index is empty', () => {
    const result = upsertExtractionPointer('', 'b.md', '- [b](b.md) — B')
    expect(result.content).toBe('- [b](b.md) — B\n')
    expect(result.action).toBe('appended')
  })

  it('replaces the owned line in place, keeping its neighbours', () => {
    const index = '- [a](a.md) — A\n- [b](b.md) — old\n- [c](c.md) — C\n'
    const result = upsertExtractionPointer(index, 'b.md', '- [b](b.md) — new')
    expect(result.content).toBe('- [a](a.md) — A\n- [b](b.md) — new\n- [c](c.md) — C\n')
    expect(result.action).toBe('replaced')
  })

  it('never matches by full-text contains', () => {
    const index = '- [a](a.md) — about batch.md, not a pointer\n'
    const result = upsertExtractionPointer(index, 'batch.md', '- [batch](batch.md) — B')
    expect(result.action).toBe('appended')
    expect(result.content.startsWith(index)).toBe(true)
  })

  it('ownership, description-link ordering: a line whose FIRST target is foreign is not matched', () => {
    // `- [foreign](foreign.md) — see [batch](batch.md)`: the batch path appears
    // only as a description link, so the line belongs to `foreign.md`.
    const index = '- [foreign](foreign.md) — see [batch](batch.md)\n'
    const result = upsertExtractionPointer(index, 'batch.md', '- [batch](batch.md) — B')
    expect(result.action).toBe('appended')
    expect(result.content.startsWith(index)).toBe(true)
    expect(targets(result.content.split('\n')[0]!)).toEqual(['foreign.md', 'batch.md'])
  })

  it('ownership, grouped-first-target ordering: a multi-target line is preserved byte-identical and the refresh skipped with a warn', () => {
    // `- [batch](batch.md), [foreign](foreign.md)`: the first target IS the batch
    // path, but replacing the line would erase the foreign pointer.
    const index = '- [batch](batch.md), [foreign](foreign.md)\n'
    const result = upsertExtractionPointer(index, 'batch.md', '- [batch](batch.md) — B')
    expect(result.action).toBe('skipped')
    expect(result.content).toBe(index)
    expect(result.warning).toContain('also points at another topic')
    expect(result.warning).toContain('batch.md')
  })

  it('cap gate: skips an append over the line cap, leaving the index byte-identical', () => {
    const index = `${Array.from({ length: MAX_ENTRYPOINT_LINES }, (_, i) => `- [t-${i}](t-${i}.md) — d`).join('\n')}\n`
    const result = upsertExtractionPointer(index, 'new.md', '- [new](new.md) — n')
    expect(result.action).toBe('skipped')
    expect(result.content).toBe(index)
    expect(result.warning).toContain('cap')
  })

  it('cap gate: keeps the old line when a replacement would exceed the byte cap', () => {
    const index = sizedIndex(MAX_ENTRYPOINT_BYTES - 100)
    const result = upsertExtractionPointer(index, 'batch.md', `- [batch](batch.md) — ${'n'.repeat(300)}`)
    expect(result.action).toBe('skipped')
    expect(result.content).toBe(index)
    expect(result.warning).toContain('cap')
  })

  it('cap gate: a shrinking replacement lands even from an over-cap index', () => {
    const index = sizedIndex(26_000, `- [batch](batch.md) — ${'o'.repeat(800)}`)
    expect(Buffer.byteLength(index.trim(), 'utf8')).toBeGreaterThan(MAX_ENTRYPOINT_BYTES)
    const result = upsertExtractionPointer(index, 'batch.md', `- [batch](batch.md) — ${'n'.repeat(400)}`)
    expect(result.action).toBe('replaced')
    // Still over the cap, but the index shrank: the only repair direction the
    // extraction path may ever take.
    expect(Buffer.byteLength(result.content.trim(), 'utf8')).toBeGreaterThan(MAX_ENTRYPOINT_BYTES)
    expect(Buffer.byteLength(result.content.trim(), 'utf8')).toBe(Buffer.byteLength(index.trim(), 'utf8') - 400)
    expect(result.content).toContain(`- [batch](batch.md) — ${'n'.repeat(400)}`)
  })

  it('cap gate: an at-cap index accepts a same-line replacement that stays within the caps', () => {
    const index = `${Array.from({ length: MAX_ENTRYPOINT_LINES }, (_, i) => `- [t-${i}](t-${i}.md) — d`).join('\n')}\n`
    const result = upsertExtractionPointer(index, 't-3.md', '- [t-3](t-3.md) — refreshed')
    expect(result.action).toBe('replaced')
    expect(result.content.split('\n')).toHaveLength(MAX_ENTRYPOINT_LINES + 1)
    expect(result.content).toContain('- [t-3](t-3.md) — refreshed')
  })
})

describe('upsertExtractionPointer (grok r4 folds)', () => {
  it('titled sibling: a foreign link with a title on the owned line is seen and the refresh is skipped', () => {
    const index = '- [batch](batch.md) — see [foreign](foreign.md "kept")\n'
    const result = upsertExtractionPointer(index, 'batch.md', '- [batch](batch.md) — new\n')
    expect(result.action).toBe('skipped')
    expect(result.content).toBe(index)
    expect(result.warning).toBeDefined()
  })

  it('duplicate same-path links on one line do not over-skip: the refresh still lands', () => {
    const index = '- [batch](batch.md) and again [batch](batch.md) — old\n'
    const result = upsertExtractionPointer(index, 'batch.md', '- [batch](batch.md) — new')
    expect(result.action).toBe('replaced')
    expect(result.content).toBe('- [batch](batch.md) — new\n')
  })

  it('byte-preserving append: a body ending mid-line keeps its bytes and only gains the separator', () => {
    const index = '- [a](a.md) — d'
    const result = upsertExtractionPointer(index, 'b.md', '- [b](b.md) — e\n'.trimEnd())
    expect(result.content).toBe('- [a](a.md) — d\n- [b](b.md) — e\n')
  })

  it('byte-preserving append: trailing blank lines and the last line\'s trailing spaces survive untouched', () => {
    const index = '- [a](a.md) — d  \n\n'
    const result = upsertExtractionPointer(index, 'b.md', '- [b](b.md) — e')
    expect(result.content).toBe('- [a](a.md) — d  \n\n- [b](b.md) — e\n')
  })
})
