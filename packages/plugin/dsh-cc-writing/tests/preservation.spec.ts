/** Deterministic Markdown scanner and preservation compare (plan §8, §8.1, §13). */
import { describe, expect, it } from 'vitest'
import {
  adjacentBlocks,
  inlineCodeSpans,
  linkDestinations,
  numberTokens,
  quoteTokensForLine,
  scanBlocks,
  sourceMarkers,
} from '../skills/writing-workflow/scripts/markdown.lib.mjs'
import {
  checkSpans,
  compareBodies,
  validateCoverage,
} from '../skills/writing-workflow/scripts/preservation.lib.mjs'

const tokens = (body: string) => numberTokens(body).map((t: { token: string }) => t.token)
const region = (body: string, scan: { protectedRegions: { start: number; end: number; kind: string }[] }, kind: string) =>
  scan.protectedRegions.filter((r) => r.kind === kind).map((r) => body.slice(r.start, r.end))
const blockText = (body: string, scan: { blocks: { start: number; end: number }[] }) =>
  scan.blocks.map((b) => body.slice(b.start, b.end))

describe('scanBlocks: frontmatter', () => {
  it('protects --- ... --- frontmatter and keeps body prose', () => {
    const body = '---\ntitle: x\n---\n\nFirst para\n'
    const scan = scanBlocks(body)
    expect(region(body, scan, 'frontmatter')).toEqual(['---\ntitle: x\n---'])
    expect(blockText(body, scan)).toEqual(['First para'])
  })

  it('accepts ... as the closing line', () => {
    const body = '---\ntitle: x\n...\n\nBody\n'
    expect(region(body, scanBlocks(body), 'frontmatter')).toEqual(['---\ntitle: x\n...'])
  })

  it('does not treat an unterminated first line as frontmatter', () => {
    const body = '---\nnot frontmatter\n'
    const scan = scanBlocks(body)
    expect(region(body, scan, 'frontmatter')).toEqual([])
  })
})

describe('scanBlocks: fences and inline code', () => {
  it('protects backtick and tilde fences, including fence lines', () => {
    const body = 'a\n\n```js\ncode\n```\n\n~~~\ntilde\n~~~\n\nb\n'
    const scan = scanBlocks(body)
    expect(region(body, scan, 'fenced-code')).toEqual(['```js\ncode\n```', '~~~\ntilde\n~~~'])
    expect(blockText(body, scan)).toEqual(['a', 'b'])
  })

  it('accepts up to three leading spaces on fences', () => {
    const body = '   ```\nx\n   ```\n'
    expect(region(body, scanBlocks(body), 'fenced-code')).toEqual(['   ```\nx\n   ```'])
  })

  it('reports an unclosed fence as a limitation extending to EOF', () => {
    const body = 'intro\n\n```\ncode to the end\n'
    const scan = scanBlocks(body)
    expect(region(body, scan, 'fenced-code')).toEqual(['```\ncode to the end\n'])
    expect(scan.limitations.map((l) => l.code)).toContain('UNCLOSED_FENCE')
    expect(blockText(body, scan)).toEqual(['intro'])
  })

  it('protects matched inline backtick runs only', () => {
    const body = 'Use `a # b` and `code` here\n'
    const scan = scanBlocks(body)
    expect(region(body, scan, 'inline-code')).toEqual(['`a # b`', '`code`'])
    expect(inlineCodeSpans('a ```x``` b')).toEqual([{ start: 2, end: 9 }])
    expect(inlineCodeSpans('unmatched ` tick')).toEqual([])
  })
})

describe('scanBlocks: prose blocks', () => {
  it('makes every ATX heading its own block', () => {
    const body = '# Title\npara one\npara two\n## Sub\n'
    const scan = scanBlocks(body)
    expect(blockText(body, scan)).toEqual(['# Title', 'para one\npara two', '## Sub'])
    expect(scan.blocks.map((b) => b.kind)).toEqual(['heading', 'prose', 'heading'])
  })

  it('keeps list and table lines in contiguous blocks', () => {
    const body = '- a\n- b\n\n| x | y |\n| - | - |\n'
    expect(blockText(body, scanBlocks(body))).toEqual(['- a\n- b', '| x | y |\n| - | - |'])
  })

  it('treats blockquote lines as prose', () => {
    const body = '> quoted line\n> second line\n'
    const scan = scanBlocks(body)
    expect(blockText(body, scan)).toEqual(['> quoted line\n> second line'])
    expect(scan.protectedRegions).toEqual([])
  })

  it('protects reference link and footnote definition lines', () => {
    const body = '[foo]: https://example.com/a "t"\n[^1]: note\n\nBody [foo] and [^1]\n'
    const scan = scanBlocks(body)
    expect(region(body, scan, 'reference-definition')).toEqual(['[foo]: https://example.com/a "t"', '[^1]: note'])
    expect(blockText(body, scan)).toEqual(['Body [foo] and [^1]'])
  })

  it('records limitations for setext headings and indented code', () => {
    const scan = scanBlocks('title\n=====\n\n    indented\n')
    const codes = scan.limitations.map((l) => l.code)
    expect(codes).toContain('SETEXT_HEADING_AS_PROSE')
    expect(codes).toContain('INDENTED_CODE_AS_PROSE')
  })
})

describe('number tokens', () => {
  it('accepts the fixed §8.1 fixtures', () => {
    expect(tokens('1,000.5GB')).toEqual(['1,000.5GB'])
    expect(tokens('Value 5.')).toEqual(['5'])
    expect(tokens('1..2')).toEqual(['1..2'])
    expect(tokens('2nd')).toEqual(['2nd'])
    expect(tokens('1e10')).toEqual(['1e', '10'])
    expect(tokens('2026-10-25')).toEqual(['2026', '10', '25'])
  })

  it('only takes a sign at a non-alphanumeric boundary', () => {
    expect(tokens('-3')).toEqual(['-3'])
    expect(tokens('a-3')).toEqual(['3'])
    expect(tokens('50%')).toEqual(['50%'])
  })
})

describe('quotation pairing', () => {
  it('pairs each delimiter family separately, left to right', () => {
    expect(quoteTokensForLine('「双」 『单』 “curly” "straight"').tokens).toEqual([
      '「双」',
      '『单』',
      '“curly”',
      '"straight"',
    ])
  })

  it('skips the blockquote marker and escaped straight quotes', () => {
    expect(quoteTokensForLine('> "a"').tokens).toEqual(['"a"'])
    expect(quoteTokensForLine('he said \\"no\\"').tokens).toEqual([])
  })

  it('reports unmatched delimiters without inventing a pair', () => {
    expect(quoteTokensForLine('“open only').tokens).toEqual(['“'])
    expect(quoteTokensForLine('two “open').unmatched).toBe(1)
  })
})

describe('citations and links', () => {
  it('extracts exact source markers and joins them by ;', () => {
    expect(sourceMarkers('see 〔src:ws:docs/a.md#L1-L2〕')).toEqual(['〔src:ws:docs/a.md#L1-L2〕'])
    expect(sourceMarkers('〔src:ws:a.md#L1-L2;src:ws:b.md#L3-L4〕')).toEqual([
      '〔src:ws:a.md#L1-L2〕',
      '〔src:ws:b.md#L3-L4〕',
    ])
    expect(sourceMarkers('〔claim:c1〕 and 〔src:bad〕')).toEqual([])
  })

  it('extracts link destinations with balanced parens and escapes', () => {
    expect(linkDestinations('[a](https://x.test/a_(b))')).toEqual(['https://x.test/a_(b)'])
    expect(linkDestinations('![img](p\\(x\\).png)')).toEqual(['p\\(x\\).png'])
  })
})

describe('compareBodies', () => {
  it('returns no changes for equal bodies', () => {
    const body = '# Title\n\nA 1,000.5GB claim 〔src:ws:a.md#L1-L2〕 with “quote”.\n'
    expect(compareBodies(body, body)).toEqual([])
  })

  it('reports changed numbers with multiplicity', () => {
    const changes = compareBodies('A 5 and 5.', 'A 5.')
    expect(changes).toEqual([
      { type: 'number', before: ['5', '5'], after: ['5'], disposition: 'pending', reason: null },
    ])
  })

  it('reports changed quotations', () => {
    const changes = compareBodies('He said “yes”.', 'He said “no”.')
    expect(changes.map((c) => c.type)).toEqual(['quotation'])
    expect(changes[0].before).toEqual(['“yes”'])
  })

  it('treats identical unmatched quotes as a disclosed limitation, differing as pending', () => {
    expect(compareBodies('“open only', '“open only')).toEqual([])
    expect(compareBodies('“a', '“a“b').map((c) => c.type)).toEqual(['quotation'])
  })

  it('reports citation multiplicity and ignores claim markers', () => {
    const one = 'Text 〔src:ws:a.md#L1-L2〕 〔claim:c1〕.'
    const two = 'Text 〔src:ws:a.md#L1-L2〕 〔src:ws:a.md#L1-L2〕 〔claim:c1〕.'
    const changes = compareBodies(one, two)
    expect(changes).toEqual([
      { type: 'citation', before: ['〔src:ws:a.md#L1-L2〕'], after: ['〔src:ws:a.md#L1-L2〕', '〔src:ws:a.md#L1-L2〕'], disposition: 'pending', reason: null },
    ])
  })

  it('reports changed links and footnote references as citations', () => {
    expect(compareBodies('[a](https://x.test/a)', '[a](https://x.test/b)')).toEqual([
      { type: 'link', before: ['https://x.test/a'], after: ['https://x.test/b'], disposition: 'pending', reason: null },
    ])
    expect(compareBodies('Fact[^1].', 'Fact[^2].').map((c) => c.type)).toEqual(['citation'])
  })

  it('reports changed inline code and fenced code byte-wise', () => {
    const changes = compareBodies('Use `a = 1` here.', 'Use `a = 2` here.')
    expect(changes).toEqual([
      { type: 'code', before: ['`a = 1`'], after: ['`a = 2`'], disposition: 'pending', reason: null },
    ])
    const fenced = compareBodies('```js\nx\n```\n', '```js\ny\n```\n')
    expect(fenced.map((c) => c.type)).toEqual(['code'])
  })

  it('does not report numbers or quotes hidden inside protected code', () => {
    expect(compareBodies('`5`', '`5`')).toEqual([])
  })

  it('counts protected terms literally, unioning brief and profile terms', () => {
    const before = 'HTTP/2 and HTTP/2 again.'
    const after = 'HTTP/2 once.'
    const byBrief = compareBodies(before, after, { protectedTerms: ['HTTP/2'] })
    expect(byBrief).toEqual([
      { type: 'term', before: ['HTTP/2', 'HTTP/2'], after: ['HTTP/2'], disposition: 'pending', reason: null },
    ])
    const byProfile = compareBodies('术语 术语', '术语', { profileProtectedTerms: ['术语'] })
    expect(byProfile.map((c) => c.type)).toEqual(['term'])
    expect(compareBodies('x', 'x', { profile: { protectedTerms: ['x'] } })).toEqual([])
  })

  it('keeps numbers, emoji, CRLF, and Chinese punctuation intact', () => {
    const before = '# 标题\r\n\r\n你好「世界」😀 1,000.5GB\r\n'
    const after = '# 标题\r\n\r\n你好「世界」😀 1,000.5GB\r\n'
    expect(compareBodies(before, after)).toEqual([])
    const scan = scanBlocks(before)
    expect(blockText(before, scan)).toEqual(['# 标题', '你好「世界」😀 1,000.5GB'])
  })
})

describe('adjacency', () => {
  const body = '# One\n\nTwo\n\nThree\n'
  const scan = scanBlocks(body)

  it('gives one side only at document boundaries', () => {
    const first = adjacentBlocks(scan.blocks, 0)
    expect(first.before).toBeNull()
    expect(first.after.kind).toBe('prose')
    const last = adjacentBlocks(scan.blocks, scan.blocks.length - 1)
    expect(last.after).toBeNull()
    expect(last.before.kind).toBe('prose')
  })

  it('returns both sides in the middle', () => {
    const middle = adjacentBlocks(scan.blocks, 1)
    expect(middle.before.start).toBe(scan.blocks[0].start)
    expect(middle.after.start).toBe(scan.blocks[2].start)
  })
})

describe('validateCoverage', () => {
  const body = 'One\n\nTwo\n'
  const scan = scanBlocks(body)
  const ranges = scan.blocks.map((b) => ({ start: b.start, end: b.end }))
  const review = (coverage: string, coverageRanges: { start: number; end: number }[]) => ({ coverage, coverageRanges })

  it('accepts ranges that exactly tile every prose block', () => {
    expect(validateCoverage(review('complete', ranges), scan, 'structure').ok).toBe(true)
    expect(validateCoverage(review('complete', ranges), scan, 'language').ok).toBe(true)
  })

  it('rejects missing, extra, unsorted, overlapping, and out-of-snapshot ranges', () => {
    expect(validateCoverage(review('complete', [ranges[0]]), scan, 'structure').ok).toBe(false)
    expect(validateCoverage(review('complete', [...ranges, { start: 0, end: 1 }]), scan, 'structure').ok).toBe(false)
    expect(validateCoverage(review('complete', [...ranges].reverse()), scan, 'structure').ok).toBe(false)
    expect(validateCoverage(review('complete', [{ start: 0, end: 3 }, { start: 2, end: 7 }]), scan, 'structure').ok).toBe(false)
    expect(validateCoverage(review('complete', [{ start: 0, end: body.length + 5 }]), scan, 'structure').ok).toBe(false)
    expect(validateCoverage(review('complete', [{ start: 1, end: 3 }]), scan, 'structure').ok).toBe(false)
  })

  it('rejects partial coverage as incomplete', () => {
    const result = validateCoverage(review('partial', ranges), scan, 'structure')
    expect(result.ok).toBe(false)
    expect((result as { code: string }).code).toBe('REVIEW_INCOMPLETE')
  })

  it('allows the empty zero-edit semantic review and requires edited blocks plus neighbours', () => {
    const zeroEdit = validateCoverage(review('complete', []), { ...scan, editedBlocks: [] }, 'semantics')
    expect(zeroEdit.ok).toBe(true)
    const edited = validateCoverage(review('complete', ranges), { ...scan, editedBlocks: [0] }, 'semantics')
    expect(edited.ok).toBe(true)
    const missingNeighbour = validateCoverage(review('complete', [ranges[0]]), { ...scan, editedBlocks: [0] }, 'semantics')
    expect(missingNeighbour.ok).toBe(false)
  })
})

describe('checkSpans', () => {
  const body = 'ok 😀 done\r\nsecond\n'

  it('round-trips a span and quote over an emoji', () => {
    const start = body.indexOf('😀')
    const result = checkSpans(body, [{ start, end: start + 2, quote: '😀' }])
    expect(result.ok).toBe(true)
    expect((result as { value: { quote: string }[] }).value[0].quote).toBe('😀')
  })

  it('rejects a mid-surrogate boundary and a wrong quote', () => {
    const start = body.indexOf('😀')
    expect(checkSpans(body, [{ start: start + 1, end: start + 2 }]).ok).toBe(false)
    expect(checkSpans(body, [{ start: 0, end: 2, quote: 'nope' }]).ok).toBe(false)
    expect(checkSpans(body, [{ start: 0, end: body.length + 1 }]).ok).toBe(false)
  })

  it('round-trips CRLF offsets exactly', () => {
    const start = body.indexOf('second')
    expect(checkSpans(body, [{ start, end: start + 6 }]).ok).toBe(true)
  })
})
