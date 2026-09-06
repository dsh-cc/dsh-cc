/**
 * Literal SSRF gate and http→https rewrite for the CC fetch provider. Pure URL
 * inspection only — no DNS lookup, no network I/O — so it can run before the
 * inner provider opens a socket.
 *
 * Residual: a public hostname that resolves to a private address (DNS
 * rebinding) is NOT detected here; see the package README "Known limits".
 * @module @dsh-cc/web-fetch-http/ssrf
 */

import { WebError } from '@deepseek-ai/dsh-web'

/** Policy inputs the gate needs, resolved from the plugin Config. */
export interface GatePolicy {
  /** Maximum accepted request URL length; longer URLs are `WEB_INVALID_URL`. */
  readonly maxUrlLength: number
  /** When true, private/loopback/link-local destinations are `WEB_BLOCKED_URL`. */
  readonly blockPrivateNetwork: boolean
  /** When true, public `http:` URLs are rewritten to `https:`. */
  readonly upgradeInsecure: boolean
}

/**
 * Inspect the parsed URL's hostname / IP against the literal private-network
 * table: loopback names and IPs (127/8, `::1`, IPv4-mapped `:ffff:127.0.0.1`),
 * link-local (169.254/16, `fe80::/10`), RFC1918 (10/8, 172.16/12, 192.168/16),
 * CGNAT (100.64/10), IPv6 ULA (`fc00::/7`), unspecified, and multicast
 * (224.0.0.0/4, `ff00::/8`). The WHATWG URL parser has already folded decimal
 * IPv4 hosts (`http://2130706433/` has hostname `127.0.0.1`), so plain textual
 * inspection cannot be bypassed with an integer host. NO DNS lookup: a public
 * name that resolves privately is a documented residual.
 * @param url - the already-parsed URL to classify.
 * @returns true when the destination must not be fetched.
 */
export function isBlockedDestination(url: URL): boolean {
  // WHATWG lowercases hostnames; strip the trailing dot and IPv6 brackets.
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true

  if (host.includes(':')) return isBlockedIpv6(host)
  return isBlockedIpv4(host)
}

/** True when the dotted (WHATWG-normalized) IPv4 host is private/non-public. */
function isBlockedIpv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4 || parts.some(p => p === '' || !/^\d+$/.test(p))) return false
  const octets = parts.map(p => Number(p))
  if (octets.some(o => o > 255)) return false
  const [a, b] = octets as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true // 224.0.0.0/4 multicast through 255.255.255.255
  return false
}

/**
 * Parse an IPv6 literal (WHATWG-normalized to lowercase hex groups, no zone
 * id) into 16-bit groups, or return undefined for anything unparseable.
 */
function ipv6Groups(host: string): number[] | undefined {
  const halves = host.split('::')
  if (halves.length > 2) return undefined
  const parseSide = (side: string): number[] | undefined => {
    if (side === '') return []
    const groups: number[] = []
    for (const piece of side.split(':')) {
      if (piece.includes('.')) {
        // Embedded IPv4 (e.g. ::ffff:1.2.3.4): fold into two groups.
        const v4 = piece.split('.')
        if (v4.length !== 4) return undefined
        const nums = v4.map(Number)
        if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return undefined
        groups.push(((nums[0] ?? 0) << 8) | (nums[1] ?? 0), ((nums[2] ?? 0) << 8) | (nums[3] ?? 0))
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return undefined
      groups.push(Number.parseInt(piece, 16))
    }
    return groups
  }
  const head = parseSide(halves[0] ?? '')
  const tail = parseSide(halves[1] ?? '')
  if (head === undefined || tail === undefined) return undefined
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length
    if (fill < 0) return undefined
    return [...head, ...Array<number>(fill).fill(0), ...tail]
  }
  return head.length === 8 ? head : undefined
}

/** True when the (bracket-stripped) IPv6 host is loopback/link-local/ULA/etc. */
function isBlockedIpv6(host: string): boolean {
  const groups = ipv6Groups(host)
  if (groups === undefined) return true // unparseable literals fail closed
  const head = groups[0] ?? 0
  if (groups.every(g => g === 0)) return true // :: unspecified
  const zeroPrefix = groups.slice(0, 5).every(g => g === 0)
  if (zeroPrefix && (groups[5] ?? 0) === 0 && (groups[6] ?? 0) === 0) {
    if ((groups[7] ?? 0) === 1) return true // ::1 loopback
  }
  if (zeroPrefix && (groups[5] ?? 0) === 0xffff) {
    return isBlockedIpv4(embeddedIpv4(groups)) // ::ffff:a.b.c.d IPv4-mapped
  }
  if ((head & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((head & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
  if ((head & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

/** Rebuild the dotted quad from the last two 16-bit groups (IPv4-mapped form). */
function embeddedIpv4(groups: number[]): string {
  const hi = groups[6] ?? 0
  const lo = groups[7] ?? 0
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].map(o => `${o & 0xff}`).join('.')
}

/**
 * Validate a fetch URL against the gate policy and optionally rewrite it to
 * `https:`. Throws {@link WebError} `WEB_INVALID_URL` for empty, unparsable,
 * non-http(s), or over-long URLs and `WEB_BLOCKED_URL` for credentialed URLs
 * and (when `blockPrivateNetwork`) private/non-public destinations. Public
 * `http:` URLs are upgraded to `https:` when `upgradeInsecure` is set — never
 * for private hosts (useless, and it would break loopback test servers when
 * the gate is off). No DNS resolution is performed.
 * @param input - the raw request URL string.
 * @param policy - the resolved gate policy.
 * @returns the gated (possibly upgraded) URL string.
 */
export function gateAndRewrite(input: string, policy: GatePolicy): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new WebError('web fetch URL is empty', 'WEB_INVALID_URL')
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new WebError(`invalid fetch URL: ${input.slice(0, 100)}`, 'WEB_INVALID_URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(`unsupported fetch URL scheme: ${url.protocol}`, 'WEB_INVALID_URL')
  }
  if (url.username !== '' || url.password !== '') {
    throw new WebError('credentialed fetch URLs are not allowed', 'WEB_BLOCKED_URL')
  }
  if (input.length > policy.maxUrlLength) {
    throw new WebError(`fetch URL exceeds the maximum length of ${policy.maxUrlLength}`, 'WEB_INVALID_URL')
  }
  const blocked = isBlockedDestination(url)
  if (policy.blockPrivateNetwork && blocked) {
    throw new WebError('blocked: private or non-public destination', 'WEB_BLOCKED_URL')
  }
  if (policy.upgradeInsecure && url.protocol === 'http:' && !blocked) {
    url.protocol = 'https:'
  }
  return url.toString()
}
