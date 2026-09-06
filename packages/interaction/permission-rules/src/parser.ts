/**
 * Rule-string syntax: `ToolName` or `ToolName(content)`, where `content` may
 * escape `(`/`)`/`\` with a backslash, use `*` as a wildcard, or end in `:*`
 * to declare a prefix rule. Parsing failures THROW so an invalid rule is
 * reported at load time rather than silently mis-matching.
 *
 * Matching follows Claude Code shell-rule semantics on the CALL subject:
 * `Bash(npm install)` is a prefix rule (any command starting with the text);
 * `Bash(npm publish:*)` declares the prefix `npm publish:`; a `*` anywhere
 * makes the content a wildcard glob. `\*` matches a literal asterisk.
 *
 * The module is browser-safe (pure string logic) so the host UI that previews
 * rule hits can import it directly.
 * @module @dsh-cc/permission-rules/parser
 */

import type { ContentMatcher, PermissionBehavior, PermissionRule, PermissionRuleSource } from './types.ts'
import { domainMatches, isWebFetchRuleTool, parseDomainContent } from './domain.ts'

/**
 * Parse one rule string into a {@link ContentMatcher} for the given content.
 * A content ending in `:*` yields a `prefix` matcher on the stem; otherwise
 * an unescaped `*` yields a `wildcard` matcher; otherwise a `prefix` matcher
 * on the whole content (the shell-rule convention).
 * @param content - the unescaped rule content (may be empty for a whole-tool rule).
 * @returns the matcher, or `undefined` for empty content (whole-tool rule).
 */
export function matchContent(content: string): ContentMatcher | undefined {
  if (content === '') return undefined
  if (content.endsWith(':*')) {
    // Legacy Claude Code prefix form: "npm publish:*" matches any command
    // starting with "npm publish:" (the colon is part of the prefix).
    return { kind: 'prefix', prefix: content.slice(0, -1) }
  }
  if (!hasUnescapedWildcard(content)) {
    return { kind: 'prefix', prefix: content }
  }
  return { kind: 'wildcard', pattern: content }
}

/**
 * Whether a content string holds an unescaped `*` (not `\*`).
 * @param content - the string to inspect.
 * @returns true when an asterisk is preceded by an even number of backslashes.
 */
export function hasUnescapedWildcard(content: string): boolean {
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== '*') continue
    let backslashes = 0
    for (let j = index - 1; j >= 0 && content[j] === '\\'; j -= 1) backslashes += 1
    if (backslashes % 2 === 0) return true
  }
  return false
}

/** Whether an index is an unescaped occurrence of `char` (preceded by an even number of backslashes). */
function isUnescapedAt(content: string, index: number, char: string): boolean {
  if (content[index] !== char) return false
  let backslashes = 0
  for (let j = index - 1; j >= 0 && content[j] === '\\'; j -= 1) backslashes += 1
  return backslashes % 2 === 0
}

/** The first unescaped index of `char`, or -1. */
function firstUnescaped(content: string, char: string): number {
  for (let index = 0; index < content.length; index += 1) {
    if (isUnescapedAt(content, index, char)) return index
  }
  return -1
}

/** The last unescaped index of `char`, or -1. */
function lastUnescaped(content: string, char: string): number {
  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (isUnescapedAt(content, index, char)) return index
  }
  return -1
}

/**
 * Unescape rule content after parsing: `\(`→`(`, `\)`→`)`, then `\\`→`\`.
 * Reverse of {@link escapeRuleContent}.
 * @param content - escaped content, possibly containing `\(`, `\)`, `\\`.
 * @returns the literal content.
 */
export function unescapeRuleContent(content: string): string {
  return content
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
}

/**
 * Escape rule content for safe storage in a `ToolName(content)` rule:
 * `\`→`\\` first, then `(`→`\(` and `)`→`\)`.
 * @param content - the literal content.
 * @returns content with its parens and backslashes escaped.
 */
export function escapeRuleContent(content: string): string {
  return content
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
}

/**
 * Parse one rule string into a {@link RuleString}. Accepts `ToolName` or
 * `ToolName(content)`. Rejects malformed input (empty tool name, unbalanced
 * parens, trailing text after the closing paren) by throwing — the engine's
 * fail-loud contract.
 * @param rule - the rule string to parse.
 * @returns the parsed tool name, optional content (unescaped), and optional matcher.
 * @throws a `TypeError` describing the malformed rule.
 */
export function parseRuleString(rule: string): { toolName: string; content?: string; matcher?: ContentMatcher } {
  if (rule.trim() === '') throw new TypeError('permission rule cannot be empty')
  const open = firstUnescaped(rule, '(')
  if (open === -1) {
    return { toolName: rule.trim() }
  }
  const close = lastUnescaped(rule, ')')
  if (close === -1) {
    throw new TypeError(`permission rule "${rule}" has an opening "(" with no unescaped ")"`)
  }
  if (close !== rule.length - 1) {
    throw new TypeError(`permission rule "${rule}" has content after its closing ")"`)
  }
  const toolName = rule.slice(0, open).trim()
  if (toolName === '') {
    throw new TypeError(`permission rule "${rule}" has content but no tool name`)
  }
  const rawContent = rule.slice(open + 1, close)
  const content = unescapeRuleContent(rawContent)
  if (content === '' || content === '*') {
    // Empty or single-wildcard content is a whole-tool rule, as in Claude Code.
    return { toolName }
  }
  // WebFetch domain rules take their own matcher shape; other tools (e.g.
  // `Bash(domain:example.com)`) keep the plain prefix convention.
  if (isWebFetchRuleTool(toolName) && /^domain:/i.test(content)) {
    const matcher = parseDomainContent(content)
    return { toolName, content, matcher }
  }
  const matcher = matchContent(content)
  // Content is non-empty and not a bare `*`, so a matcher is always derived.
  if (matcher === undefined) return { toolName }
  return { toolName, content, matcher }
}

/**
 * Render a rule back to its canonical string form with content escaped.
 * @param toolName - the tool name.
 * @param content - optional content.
 * @returns the round-trippable rule string.
 */
export function ruleString(toolName: string, content?: string): string {
  return content === undefined || content === '' ? toolName : `${toolName}(${escapeRuleContent(content)})`
}

/**
 * Whether a call subject matches a content matcher.
 * @param matcher - the rule's content matcher.
 * @param matcher - subject to test.
 * @returns true on a match.
 */
export function contentMatches(matcher: ContentMatcher, subject: string): boolean {
  if (matcher.kind === 'prefix') return subject.startsWith(matcher.prefix)
  if (matcher.kind === 'domain') return domainMatches(matcher.hostname, subject)
  return wildcardMatches(matcher.pattern, subject)
}

/**
 * Whether a subject matches a `*` wildcard pattern; `\*` matches a literal
 * asterisk and `\\` a literal backslash. `*` matches any run of characters.
 * @param pattern - the wildcard pattern.
 * @param subject - the string to test.
 * @returns true when the pattern matches.
 */
export function wildcardMatches(pattern: string, subject: string): boolean {
  const tokens = tokenizeWildcard(pattern)
  const hasStar = tokens.some(token => token.kind === 'star')
  if (!hasStar) {
    return literalSegments(tokens).reduce((acc, token) => acc + token.value, '') === subject
  }
  const segments = literalSegments(tokens)
  if (segments.length === 0) return true
  const isStart = tokens[0]?.kind === 'literal'
  const isEnd = tokens[tokens.length - 1]?.kind === 'literal'
  let position = 0
  if (isStart) {
    const first = segments[0]
    if (first === undefined) return false
    if (!subject.startsWith(first.value)) return false
    position = first.value.length
  }
  const lastIndex = segments.length - 1
  const firstMiddle = isStart ? 1 : 0
  const lastMiddle = isEnd ? lastIndex - 1 : lastIndex
  for (let index = firstMiddle; index <= lastMiddle; index += 1) {
    const segment = segments[index]
    if (segment === undefined) return false
    const at = subject.indexOf(segment.value, position)
    if (at === -1) return false
    position = at + segment.value.length
  }
  if (isEnd) {
    const endSegment = segments[lastIndex]
    if (endSegment === undefined) return false
    return subject.endsWith(endSegment.value) && position <= subject.length - endSegment.value.length
  }
  return true
}

type WildcardToken = { kind: 'star' } | { kind: 'literal'; value: string }

/** A literal (non-star) wildcard token with its expanded value. */
type LiteralToken = { kind: 'literal'; value: string }

/** The literal tokens of a token array, in order (star gaps removed). */
function literalSegments(tokens: WildcardToken[]): LiteralToken[] {
  return tokens.filter((token): token is LiteralToken => token.kind === 'literal')
}

/** Split a wildcard pattern into star/literal tokens, expanding `\*` and `\\`. */
function tokenizeWildcard(pattern: string): WildcardToken[] {
  const tokens: WildcardToken[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer !== '') {
      tokens.push({ kind: 'literal', value: buffer })
      buffer = ''
    }
  }
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '\\' && index + 1 < pattern.length) {
      const next = pattern[index + 1]
      if (next === '*') {
        buffer += '*'
        index += 1
        continue
      }
      if (next === '\\') {
        buffer += '\\'
        index += 1
        continue
      }
      buffer += char
      continue
    }
    if (char === '*') {
      flush()
      tokens.push({ kind: 'star' })
      continue
    }
    buffer += char
  }
  flush()
  return tokens
}

/**
 * Build a parsed, source-labelled rule from a rule string.
 * @param rule - the rule string (`ToolName` or `ToolName(content)`).
 * @param behavior - the behavior this rule prescribes.
 * @param source - the rule's provenance, used for evaluation priority.
 * @returns the parsed rule.
 * @throws a `TypeError` when the rule string is malformed.
 */
export function parseRule(
  rule: string,
  behavior: PermissionBehavior,
  source: PermissionRuleSource,
): PermissionRule {
  const parsed = parseRuleString(rule)
  if (parsed.content === undefined) {
    return { toolName: parsed.toolName, behavior, source }
  }
  // parseRuleString derives a matcher for every non-empty content, so the
  // optional types are co-present by construction.
  return {
    toolName: parsed.toolName,
    content: parsed.content,
    matcher: parsed.matcher as ContentMatcher,
    behavior,
    source,
  }
}
