/**
 * Execute `http` hooks: POST the hook input JSON to a configured URL with
 * env-var-interpolated headers, then translate the HTTP response onto the same
 * exit-code contract the command codec uses (status → exit code, body →
 * stdout). Header interpolation is gated by an `allowedEnvVars` allowlist and
 * an `allowedHttpHookUrls` pattern allowlist, so a project-configured hook
 * cannot exfiltrate arbitrary secrets or reach arbitrary hosts.
 * @module @dsh-cc/hook-protocol/http
 */

import { parseHookOutput } from './codec.ts'
import type { HookOutput, HttpHook } from './types.ts'

/**
 * The reference default per-http-hook timeout, in ms (10 minutes — the CD
 * reference default; matches {@link DEFAULT_HOOK_TIMEOUT_MS}).
 */
export const DEFAULT_HTTP_HOOK_TIMEOUT_MS = 600_000

/** Everything a single http-hook invocation needs beyond its hook config. */
export interface RunHttpHookOptions {
  /** The JSON payload object POSTed as the request body (the bridge builds it). */
  payload: unknown
  /** Env-var names allowed to interpolate into header values (the policy allowlist). */
  allowedEnvVars: ReadonlySet<string>
  /**
   * URL-pattern allowlist (same `*`-wildcard semantics as the reference guard):
   * `undefined`/empty → no restriction (the safe default, so an unset policy
   * cannot silently block every http hook); non-empty → the URL must match a
   * pattern. `[]` and unset are NOT distinguished because config loaders (e.g.
   * schemastery) materialize an unset optional array as `[]`.
   */
  allowedHttpHookUrls?: string[]
  /** Default timeout applied when the hook sets none. */
  defaultTimeoutMs: number
  /** Explicit owning-operation signal; firing it aborts the request. */
  readonly signal: AbortSignal
  /**
   * The event this hook is firing for (passed to {@link parseHookOutput} to
   * guard event-scoped fields).
   */
  expectedEventName?: string
  /** Millisecond clock for the reported duration. */
  now: () => number
  /**
   * The fetch implementation to use (defaults to the global `fetch`). Injectable
   * so a test may substitute a fake; the default is the real network fetch.
   */
  fetchImpl?: typeof fetch
}

/** The decoded outcome of an http hook plus its wall-clock duration. */
export interface RunHttpHookResult {
  output: HookOutput
  /** Wall-clock duration of the request, from `now` — reported like `runHook`. */
  durationMs: number
}

/** A URL allowlist pattern uses `*` as an any-chars wildcard (the reference guard semantics). */
function urlMatchesPattern(url: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const regexStr = escaped.replace(/\*/g, '.*')
  return new RegExp(`^${regexStr}$`).test(url)
}

/** Strip CR, LF, and NUL bytes from a header value to block header injection. */
function sanitizeHeaderValue(value: string): string {
  // Header-injection guards: CR/LF would terminate the header, NUL is invalid.
  return value.replace(/[\r\n\x00]/g, '')
}

/**
 * Interpolate `$VAR` and `${VAR}` references in a header value, resolving only
 * names present in `allowedEnvVars` (others become empty strings, the
 * exfiltration guard). The result is stripped of CR/LF/NUL bytes.
 * @param value - the raw header value from config.
 * @param allowedEnvVars - the resolver for which names may interpolate (policy ∩ hook allowlists).
 * @param env - the environment to read values from (defaults to `process.env`; injectable for tests).
 * @returns the sanitized, partially-interpolated value.
 */
export function interpolateEnvVars(
  value: string,
  allowedEnvVars: ReadonlySet<string>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const interpolated = value.replace(
    /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g,
    (_match, braced: string | undefined, unbraced: string | undefined): string => {
      // The pattern alternation guarantees exactly one of the two groups bound;
      // a non-null assertion is the documented narrowing of that guarantee.
      const varName = (braced ?? unbraced) as string
      if (!allowedEnvVars.has(varName)) return ''
      return env[varName] ?? ''
    },
  )
  return sanitizeHeaderValue(interpolated)
}

/**
 * Run `hook` by POSTing its payload to its URL and decode the response through
 * the same exit-code contract as command hooks (HTTP status → exit code, body →
 * stdout, so a 200 parses the body as structured JSON and a 4xx/5xx becomes a
 * non-blocking error). Enforcement of the URL allowlist happens before any I/O;
 * an allowlist violation is a non-blocking error with no status code, mirroring
 * {@link runHook}'s infrastructure-rejection handling.
 * @param hook - the configured http hook; its `timeoutSec` overrides the default timeout.
 * @param options - payload, allowlists, timeout, signal, clock, and fetch implementation.
 * @returns the decoded outcome plus the request's wall-clock duration.
 */
export async function runHttpHook(
  hook: HttpHook,
  options: RunHttpHookOptions,
): Promise<RunHttpHookResult> {
  const started = options.now()
  const applyAllowedUrl = (url: string): boolean => {
    if (options.allowedHttpHookUrls === undefined || options.allowedHttpHookUrls.length === 0) return true
    return options.allowedHttpHookUrls.some(pattern => urlMatchesPattern(url, pattern))
  }
  if (!applyAllowedUrl(hook.url)) {
    return {
      output: parseHookOutput(undefined, '', `HTTP hook blocked: ${hook.url} does not match any pattern in allowedHttpHookUrls`, options.expectedEventName),
      durationMs: options.now() - started,
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  for (const [name, value] of Object.entries(hook.headers ?? {})) {
    headers[name] = interpolateEnvVars(value, options.allowedEnvVars)
  }

  const timeoutMs = hook.timeoutSec !== undefined ? hook.timeoutSec * 1000 : options.defaultTimeoutMs
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  options.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()

  const body = JSON.stringify(options.payload)
  try {
    const fetchImpl = options.fetchImpl ?? fetch
    const response = await fetchImpl(hook.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      redirect: 'manual',
    })
    const text = await response.text()
    // The HTTP status maps onto the command exit-code contract (200 → 0, 2 → 2,
    // everything else → the status as a non-blocking "exit"). parseHookOutput
    // only parses structured JSON on a clean (0/200) status.
    const exitCode = response.status === 200 ? 0 : response.status
    return {
      output: parseHookOutput(exitCode, text, '', options.expectedEventName),
      durationMs: options.now() - started,
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      output: parseHookOutput(undefined, '', message, options.expectedEventName),
      durationMs: options.now() - started,
    }
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', onAbort)
  }
}
