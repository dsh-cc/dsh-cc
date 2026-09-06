/**
 * Domain permission rules for WebFetch: `WebFetch(domain:example.com)`
 * content rules matched against the canonicalized URL hostname. Browser-safe
 * (pure URL/string logic, no harness or alias imports) so the parser and the
 * TUI can both import this module.
 * @module @dsh-cc/permission-rules/domain
 */

import type { ContentMatcher } from './types.ts'

/**
 * Whether a rule tool name governs the WebFetch tool (either its CC spelling
 * or the harness `web_fetch` spelling).
 * @param name - the authored or harness tool name.
 * @returns true for `WebFetch` and `web_fetch`.
 */
export function isWebFetchRuleTool(name: string): boolean {
  return name === 'WebFetch' || name === 'web_fetch'
}

/**
 * Canonicalize the hostname of a URL for domain matching: lowercase, trailing
 * dots stripped, IPv6 `[…]` wrapping removed. The port is ignored (Claude
 * matches hostname only). An invalid URL yields `undefined` so the permission
 * falls through to whole-tool / passthrough instead of inventing a host.
 * @param url - the URL whose host to canonicalize.
 * @returns the canonical hostname, or `undefined` when the URL is invalid.
 */
export function canonicalizeHostname(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  let host = parsed.hostname.toLowerCase()
  while (host.endsWith('.')) host = host.slice(0, -1)
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  return host === '' ? undefined : host
}

/**
 * Parse a `domain:<host>` rule content into a {@link ContentMatcher}. The
 * captured text is treated as a bare hostname (never a URL): schemes, paths,
 * ports, empty hosts, and `*` off a label boundary are rejected by throwing
 * so an invalid rule fails loud at load time. A leading `*.` is stored as
 * part of the hostname.
 * @param content - the rule content, expected to start with `domain:`.
 * @returns the domain matcher with the canonical hostname.
 * @throws a `TypeError` when the content is not a valid domain rule.
 */
export function parseDomainContent(content: string): ContentMatcher {
  const match = /^domain:\s*(.+)$/i.exec(content)
  if (match === null || match[1] === undefined) {
    throw new TypeError(`invalid WebFetch domain rule content "${content}"`)
  }
  let host = match[1].trim().toLowerCase()
  // A hostname is never a URL: reject schemes, paths, ports, and fragments.
  if (host.includes('://') || host.includes('/') || host.includes(':') || host.includes('?') || host.includes('#')) {
    throw new TypeError(`WebFetch domain rule host "${host}" must be a bare hostname`)
  }
  while (host.endsWith('.')) host = host.slice(0, -1)
  if (host === '') {
    throw new TypeError('WebFetch domain rule host cannot be empty')
  }
  const labels = host.split('.')
  for (const label of labels) {
    if (label !== '*' && label.includes('*')) {
      throw new TypeError(`WebFetch domain rule host "${host}" has a "*" off a label boundary`)
    }
  }
  if (labels.every(label => label === '*')) {
    throw new TypeError(`WebFetch domain rule host "${host}" must name a concrete domain`)
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  return { kind: 'domain', hostname: host }
}

/**
 * Whether a call hostname matches a domain pattern, following Claude Code's
 * WebFetch domain semantics: a plain pattern is exact-only; a leading `*.`
 * matches the bare domain and any subdomain depth; a `*` in any other label
 * position matches exactly one dot-separated label.
 * @param pattern - the parsed rule hostname (may carry a leading `*.`).
 * @param hostname - the canonical call hostname.
 * @returns true on a match.
 */
export function domainMatches(pattern: string, hostname: string): boolean {
  const patternHost = pattern.toLowerCase().replace(/\.+$/, '')
  const callHost = hostname.toLowerCase().replace(/\.+$/, '')
  const patternLabels = patternHost.split('.')
  // Leading `*.` (with no other wildcards) matches the bare domain itself
  // and any subdomain depth; a pattern with additional `*` labels falls to
  // the per-label single-label wildcard comparison below.
  if (patternLabels[0] === '*' && patternLabels.length >= 2 && !patternLabels.slice(1).includes('*')) {
    const rest = patternLabels.slice(1).join('.')
    return callHost === rest || callHost.endsWith(`.${rest}`)
  }
  const callLabels = callHost.split('.')
  if (patternLabels.length !== callLabels.length) return false
  return patternLabels.every((label, index) => label === '*' || label === callLabels[index])
}
