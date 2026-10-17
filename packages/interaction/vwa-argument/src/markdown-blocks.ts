/** CommonMark root blocks shared by source context and review planning. */
import MarkdownIt from 'markdown-it'

// 'zero' preset + block rules only: the AST's line maps drive block
// segmentation (same pattern as vwa-evidence's prose mask).
const blockMd: MarkdownIt = new MarkdownIt('zero', { breaks: false })
blockMd.enable(['paragraph', 'heading', 'fence', 'code', 'html_block', 'blockquote', 'list', 'table'])

/**
 * Root-level block splitter over the CommonMark parser AST (§4/§12): the
 * extraction units are the root-level children of a CommonMark parse. Uses
 * the markdown-it token stream's line maps (its only stable offsets) at
 * depth 0 (nesting +1/-1 accounting), so lists/quotes/fences stay ONE block.
 * Fallback: unparseable/empty input → the whole text as one block.
 */
export function rootBlocks(
  text: string,
): { start: number; end: number; heading: { level: number; text: string } | undefined; body: string }[] {
  const lineStarts: number[] = []
  let offset = 0
  for (const line of text.split('\n')) {
    lineStarts.push(offset)
    offset += line.length + 1
  }
  const lineEnd = (line: number): number => Math.min((lineStarts[line] ?? text.length + 1) - 1, text.length)
  const blocks: { start: number; end: number; heading: { level: number; text: string } | undefined; body: string }[] =
    []
  let depth = 0
  for (const token of blockMd.parse(text, {})) {
    if (token.nesting === 1) {
      if (depth === 0 && token.map) {
        const start = lineStarts[token.map[0]!] ?? 0
        const end = lineEnd(token.map[1]!)
        if (end > start) {
          const body = text.slice(start, end)
          // Heading TEXT comes from the block's first line (the heading_open
          // token itself carries no inline content).
          const heading =
            token.type === 'heading_open'
              ? /^(#{1,6})\s+(.*)$/.exec(body.split('\n', 1)[0] ?? '')
                ? {
                    level: Number(token.tag.slice(1)) || 1,
                    text: /^(#{1,6})\s+(.*)$/.exec(body.split('\n', 1)[0] ?? '')![2]!.trim(),
                  }
                : { level: Number(token.tag.slice(1)) || 1, text: '' }
              : undefined
          blocks.push({ start, end, heading, body })
        }
      }
      depth += 1
    } else if (token.nesting === -1) {
      depth -= 1
    } else if (depth === 0 && token.map) {
      // Self-closing token at depth 0 (fence/html_block/html_self_closing).
      const start = lineStarts[token.map[0]!] ?? 0
      const end = lineEnd(token.map[1]!)
      if (end > start) blocks.push({ start, end, heading: undefined, body: text.slice(start, end) })
    }
  }
  if (blocks.length === 0 && text.length > 0) {
    blocks.push({ start: 0, end: text.length, heading: undefined, body: text })
  }
  return blocks
}
