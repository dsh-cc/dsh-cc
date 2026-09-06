/**
 * `@dsh-cc/web-fetch-http`: the CC host-plane HTTP(S) fetch provider.
 * A function/namespace plugin (NOT a default-export service) that registers a
 * `CcHttpFetchProvider` into the `ctx.web` fetch registry under the id `'http'`
 * (`LOCAL_FETCH_PROVIDER_ID`). The wrapper applies the literal SSRF gate
 * ({@link gateAndRewrite}) before delegating to the harness `HttpFetchProvider`
 * — this package never calls the stock `web-fetch-http` `apply()`, so only one
 * provider with that id may be mounted per context.
 *
 * Residual: the gate does no DNS lookup — a public hostname that resolves to a
 * private address (DNS rebinding) is not detected; see the README.
 * @module @dsh-cc/web-fetch-http
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { HttpFetchProvider, LOCAL_FETCH_PROVIDER_ID } from '@deepseek-ai/dsh-web-fetch-http'
import { CcHttpFetchProvider } from './provider.ts'
import { gateAndRewrite, isBlockedDestination } from './ssrf.ts'
import type { GatePolicy } from './ssrf.ts'

export { LOCAL_FETCH_PROVIDER_ID, CcHttpFetchProvider, gateAndRewrite, isBlockedDestination }
export type { GatePolicy }

/** Default `User-Agent`: an explicit product agent, never a browser disguise. */
export const DEFAULT_USER_AGENT = 'dsh-cc/0.4.1 (+https://github.com/dsh-cc/dsh-cc)'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-fetch-http-cc'

/** The web seam this provider registers into. */
export const inject = ['web']

/**
 * Plugin config: transport limits (mirroring the harness `web-fetch-http`
 * config with CC defaults) plus the CC gate policy flags.
 */
export interface Config {
  /** Maximum accepted request URL length. */
  maxUrlLength?: number
  /** Maximum response body size in bytes. */
  maxResponseBytes?: number
  /** Maximum decoded body length in characters. */
  maxBodyChars?: number
  /** Default fetch timeout in milliseconds, within Node's timer range. */
  timeoutMs?: number
  /** Maximum number of same-origin redirect hops to follow. */
  maxRedirects?: number
  /** `User-Agent` header sent on every request. */
  userAgent?: string
  /** Rewrite public `http:` URLs to `https:`. Defaults to true. */
  upgradeInsecure?: boolean
  /** Block private/loopback/link-local destinations. Defaults to true. */
  blockPrivateNetwork?: boolean
}

export const Config: z<Config> = z.object({
  maxUrlLength: z.number().default(2048),
  maxResponseBytes: z.number().default(2_000_000),
  maxBodyChars: z.number().default(100_000),
  timeoutMs: z.number().default(20_000),
  maxRedirects: z.number().default(3),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
  upgradeInsecure: z.boolean().default(true),
  blockPrivateNetwork: z.boolean().default(true),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** A resource limit (byte/char/length/timeout cap) must be a positive finite number. */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`web-fetch-http-cc: ${name} must be a positive finite number`)
  }
}

/** Node coerces larger timer delays to 1 ms, so reject them at configuration time. */
function assertTimeoutMs(value: number): void {
  assertPositiveFinite('timeoutMs', value)
  const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647
  if (value > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(`web-fetch-http-cc: timeoutMs must be no greater than ${MAX_NODE_TIMER_DELAY_MS}`)
  }
}

/** The redirect hop cap must be a non-negative integer (0 follows no redirects). */
function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`web-fetch-http-cc: ${name} must be a non-negative integer`)
  }
}

/**
 * Register the SSRF-gated HTTP(S) fetch provider with `ctx.web`. Constructs
 * the harness `HttpFetchProvider` directly (the stock `web-fetch-http`
 * `apply()` is never called, so no second `id: 'http'` registration exists).
 * @param ctx - Cordis context carrying the web seam.
 * @param config - plugin config; schemastery has filled every field default.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite('maxUrlLength', resolved.maxUrlLength)
  assertPositiveFinite('maxResponseBytes', resolved.maxResponseBytes)
  assertPositiveFinite('maxBodyChars', resolved.maxBodyChars)
  assertTimeoutMs(resolved.timeoutMs)
  assertNonNegativeInteger('maxRedirects', resolved.maxRedirects)
  const inner = new HttpFetchProvider({
    maxUrlLength: resolved.maxUrlLength,
    maxResponseBytes: resolved.maxResponseBytes,
    maxBodyChars: resolved.maxBodyChars,
    timeoutMs: resolved.timeoutMs,
    maxRedirects: resolved.maxRedirects,
    userAgent: resolved.userAgent,
  })
  const policy: GatePolicy = {
    maxUrlLength: resolved.maxUrlLength,
    blockPrivateNetwork: resolved.blockPrivateNetwork,
    upgradeInsecure: resolved.upgradeInsecure,
  }
  ctx.web.registerFetchProvider(new CcHttpFetchProvider(inner, policy))
}
