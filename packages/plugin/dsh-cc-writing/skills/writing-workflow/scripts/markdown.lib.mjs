/**
 * Deterministic Markdown scanner (plan §8, §8.1).
 *
 * Line scanner only: no Markdown dependency. Every offset is a half-open
 * UTF-16 code-unit range into the original text. Protected regions keep their
 * bytes and are excluded from prose coverage; prose blocks are the units used
 * by review coverage and adjacency.
 *
 * v1 limitations (reported, not silent): setext headings and indented code
 * count as prose; unclosed fences extend to EOF; HTML is unsupported.
 */

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^( {0,3})(`+|~+)[ \t]*$/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+|$)/
const REF_DEF = /^ {0,3}\[[^\]]+\]:/
const BLANK = /^[ \t]*$/
const SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/
const INDENTED = /^(?: {4,}|\t)/
const HTML = /^ {0,3}<[A-Za-z!/]/

const NUMBER_RE = /\d(?:[\d,]|\.(?=[\d.]))*(?:[A-Za-z%]*)/g
const SOURCE_GROUP_RE = /〔([^〕]*)〕/g
const SOURCE_MARKER_RE = /^src:ws:([^#;]+)#L(\d+)-L(\d+)$/
const FOOTNOTE_RE = /\[\^([^\]\s]+)\]/g
const LINK_RE = /\[[^\]]*\]\(/g

/** Split text into line records; `end` excludes the newline (and a trailing CR). */
function splitLines(text) {
  const lines = []
  let start = 0
  for (;;) {
    const nl = text.indexOf('\n', start)
    const rawEnd = nl === -1 ? text.length : nl
    let end = rawEnd
    if (end > start && text[end - 1] === '\r') end -= 1
    lines.push({ start, end, content: text.slice(start, end) })
    if (nl === -1) break
    start = nl + 1
  }
  return lines
}

function isAlnum(ch) {
  return ch !== '' && ch !== undefined && /[A-Za-z0-9]/.test(ch)
}

/**
 * Scan a Markdown body.
 *
 * @returns {{
 *   blocks: {start:number,end:number,kind:'heading'|'prose',level?:number}[],
 *   protectedRegions: {start:number,end:number,kind:string}[],
 *   limitations: {code:string,message:string,offset?:number}[],
 *   length:number
 * }}
 */
export function scanBlocks(body) {
  if (typeof body !== 'string') throw new TypeError('scanBlocks: body must be a string')
  const lines = splitLines(body)
  const blocks = []
  const protectedRegions = []
  const limitations = []
  const seenLimitations = new Set()
  const limit = (code, message, offset) => {
    if (seenLimitations.has(code)) return
    seenLimitations.add(code)
    limitations.push({ code, message, offset })
  }

  let i = 0
  if (lines.length > 0 && /^---\s*$/.test(lines[0].content)) {
    for (let j = 1; j < lines.length; j++) {
      if (/^(?:---|\.\.\.)\s*$/.test(lines[j].content)) {
        protectedRegions.push({ start: lines[0].start, end: lines[j].end, kind: 'frontmatter' })
        i = j + 1
        break
      }
    }
  }

  let current = null
  const closeBlock = () => {
    if (current !== null) blocks.push(current)
    current = null
  }

  while (i < lines.length) {
    const line = lines[i]
    const fence = FENCE_OPEN.exec(line.content)
    if (fence) {
      closeBlock()
      const fenceChar = fence[2][0]
      const openLength = fence[2].length
      let end = body.length
      let closed = false
      for (let j = i + 1; j < lines.length; j++) {
        const close = FENCE_CLOSE.exec(lines[j].content)
        if (close && close[2][0] === fenceChar && close[2].length >= openLength) {
          end = lines[j].end
          i = j
          closed = true
          break
        }
      }
      protectedRegions.push({ start: line.start, end, kind: 'fenced-code' })
      if (!closed) {
        limit('UNCLOSED_FENCE', 'unclosed fence extends to EOF', line.start)
        i = lines.length
        continue
      }
      i += 1
      continue
    }
    if (BLANK.test(line.content)) {
      closeBlock()
      i += 1
      continue
    }
    if (REF_DEF.test(line.content)) {
      closeBlock()
      protectedRegions.push({ start: line.start, end: line.end, kind: 'reference-definition' })
      i += 1
      continue
    }
    const heading = HEADING.exec(line.content)
    if (heading) {
      closeBlock()
      blocks.push({ start: line.start, end: line.end, kind: 'heading', level: heading[1].length })
      i += 1
      continue
    }
    if (SETEXT.test(line.content) && i > 0 && !BLANK.test(lines[i - 1].content)) {
      limit('SETEXT_HEADING_AS_PROSE', 'setext headings are treated as prose in v1', line.start)
    }
    if (INDENTED.test(line.content)) limit('INDENTED_CODE_AS_PROSE', 'indented code is treated as prose in v1', line.start)
    if (HTML.test(line.content)) limit('HTML_UNSUPPORTED', 'HTML is preserved but unsupported for prose diagnostics', line.start)
    if (current === null) current = { start: line.start, end: line.end, kind: 'prose' }
    else current.end = line.end
    i += 1
  }
  closeBlock()

  for (const block of blocks) {
    const slice = body.slice(block.start, block.end)
    let base = block.start
    for (const part of slice.split('\n')) {
      const content = part.endsWith('\r') ? part.slice(0, -1) : part
      for (const span of inlineCodeSpans(content)) {
        protectedRegions.push({ start: base + span.start, end: base + span.end, kind: 'inline-code' })
      }
      base += part.length + 1
    }
  }

  protectedRegions.sort((a, b) => a.start - b.start || a.end - b.end)
  return { blocks, protectedRegions, limitations, length: body.length }
}

/** Nearest prose block before and after `index`; null at document boundaries. */
export function adjacentBlocks(blocks, index) {
  return {
    before: index > 0 ? blocks[index - 1] : null,
    after: index >= 0 && index + 1 < blocks.length ? blocks[index + 1] : null,
  }
}

/** Number tokens per the exact §8.1 grammar (lexical, not numerical). */
export function numberTokens(text) {
  if (typeof text !== 'string') throw new TypeError('numberTokens: text must be a string')
  const tokens = []
  NUMBER_RE.lastIndex = 0
  let match
  while ((match = NUMBER_RE.exec(text)) !== null) {
    let start = match.index
    const sign = start > 0 ? text[start - 1] : ''
    if ((sign === '+' || sign === '-') && !isAlnum(text[start - 2])) start -= 1
    tokens.push({ token: text.slice(start, NUMBER_RE.lastIndex), start, end: NUMBER_RE.lastIndex })
  }
  return tokens
}

/** VWA source markers 〔src:ws:<path>#La-Lb〕 with their full group range. */
export function sourceMarkerTokens(text) {
  if (typeof text !== 'string') throw new TypeError('sourceMarkers: text must be a string')
  const tokens = []
  SOURCE_GROUP_RE.lastIndex = 0
  let group
  while ((group = SOURCE_GROUP_RE.exec(text)) !== null) {
    for (const part of group[1].split(';')) {
      const segment = part.trim()
      if (SOURCE_MARKER_RE.test(segment)) {
        tokens.push({ token: `〔${segment}〕`, start: group.index, end: group.index + group[0].length })
      }
    }
  }
  return tokens
}

/** VWA source markers 〔src:ws:<path>#La-Lb〕; `;`-joined groups yield one token each. */
export function sourceMarkers(text) {
  return sourceMarkerTokens(text).map((entry) => entry.token)
}

/** Footnote reference tokens [^id]. */
export function footnoteRefTokens(text) {
  const tokens = []
  FOOTNOTE_RE.lastIndex = 0
  let match
  while ((match = FOOTNOTE_RE.exec(text)) !== null) {
    tokens.push({ token: match[0], start: match.index, end: match.index + match[0].length })
  }
  return tokens
}

/** Footnote references [^id]. */
export function footnoteRefs(text) {
  return footnoteRefTokens(text).map((entry) => entry.token)
}

/** Inline Markdown link/image destination tokens with balanced parens and escapes. */
export function linkDestinationTokens(text) {
  const tokens = []
  LINK_RE.lastIndex = 0
  let match
  while ((match = LINK_RE.exec(text)) !== null) {
    const open = match.index + match[0].length - 1
    let depth = 0
    let buffer = ''
    let index = open
    for (; index < text.length; index++) {
      const ch = text[index]
      if (ch === '\\') {
        buffer += ch
        if (index + 1 < text.length) {
          buffer += text[index + 1]
          index += 1
        }
        continue
      }
      if (ch === '(') {
        depth += 1
        if (depth === 1) continue
      } else if (ch === ')') {
        depth -= 1
        if (depth === 0) break
      }
      buffer += ch
    }
    if (depth !== 0) continue
    tokens.push({ token: buffer.trim(), start: match.index, end: index + 1 })
    LINK_RE.lastIndex = index + 1
  }
  return tokens
}

/** Inline Markdown link/image destinations. */
export function linkDestinations(text) {
  return linkDestinationTokens(text).map((entry) => entry.token)
}

/** Matched inline backtick runs on one line, as ranges relative to the line. */
export function inlineCodeSpans(line) {
  const runs = []
  const re = /`+/g
  let match
  while ((match = re.exec(line)) !== null) runs.push({ start: match.index, length: match[0].length })
  const spans = []
  let i = 0
  while (i < runs.length) {
    let j = i + 1
    while (j < runs.length && runs[j].length !== runs[i].length) j += 1
    if (j < runs.length) {
      spans.push({ start: runs[i].start, end: runs[j].start + runs[j].length })
      i = j + 1
    } else i += 1
  }
  return spans
}

const QUOTE_FAMILIES = [
  { open: '「', close: '」' },
  { open: '『', close: '』' },
  { open: '“', close: '”' },
  { open: '"', close: '"' },
]

/**
 * Pair quotation delimiters within one line, each family separately and left
 * to right without nesting. `skip` holds line-relative [start,end) ranges of
 * protected code. Unmatched delimiters are returned as raw tokens so they can
 * participate in the multiset comparison.
 */
export function quoteTokensForLine(line, skip = []) {
  const marker = /^ {0,3}> ?/.exec(line)
  const lower = marker ? marker[0].length : 0
  const skipped = (i) => i < lower || skip.some(([start, end]) => i >= start && i < end)
  const tokens = []
  let unmatched = 0
  for (const family of QUOTE_FAMILIES) {
    const straight = family.open === family.close
    let pending = -1
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch !== family.open && ch !== family.close) continue
      if (skipped(i)) continue
      if (straight) {
        let backslashes = 0
        for (let k = i - 1; k >= 0 && line[k] === '\\'; k--) backslashes += 1
        if (backslashes % 2 === 1) continue
      }
      if (straight) {
        if (pending === -1) pending = i
        else {
          tokens.push(line.slice(pending, i + 1))
          pending = -1
        }
      } else if (ch === family.open) {
        if (pending !== -1) {
          tokens.push(line[pending])
          unmatched += 1
        }
        pending = i
      } else if (pending !== -1) {
        tokens.push(line.slice(pending, i + 1))
        pending = -1
      } else {
        tokens.push(ch)
        unmatched += 1
      }
    }
    if (pending !== -1) {
      tokens.push(line[pending])
      unmatched += 1
    }
  }
  return { tokens, unmatched }
}

/** Replace protected characters with spaces, preserving length and offsets. */
export function maskProtected(text, regions) {
  if (!regions.length) return text
  const chars = text.split('')
  for (const region of regions) {
    for (let i = region.start; i < region.end && i < chars.length; i++) chars[i] = ' '
  }
  return chars.join('')
}
