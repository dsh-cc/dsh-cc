import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { interpolateEnvVars, runHttpHook } from '@dsh-cc/hook-protocol/src/http.ts'
import type { HttpHook } from '@dsh-cc/hook-protocol/src/types.ts'

/**
 * HTTP-executor protocol tests. The response→exit-code contract and the
 * $VAR-allowedEnvVars interpolation and allowedHttpHookUrls allowlist guard are
 * exercised against a REAL local mock HTTP server (the "prefer the real
 * implementation" rule) plus unit tests of the pure helpers.
 */

const servers: Server[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

/** Start a local mock HTTP server; respond per the given handler, capturing the request. */
function mockServer(
  handler: (req: { url?: string; headers: Record<string, unknown>; body: string }) => { status: number; body: string },
): Promise<{ port: number; requests: Array<{ method?: string; url?: string; headers: Record<string, unknown>; body: string }> }> {
  const requests: Array<{ method?: string; url?: string; headers: Record<string, unknown>; body: string }> = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const entry: { method?: string; url?: string; headers: Record<string, unknown>; body: string } = { headers: req.headers as Record<string, unknown>, body }
      if (req.method !== undefined) entry.method = req.method
      if (req.url !== undefined) entry.url = req.url
      requests.push(entry)
      const { status, body: resp } = handler(entry)
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(resp)
    })
  })
  servers.push(server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as AddressInfo).port, requests })
    })
  })
}

function hook(url: string, extra: Partial<HttpHook> = {}): HttpHook {
  return { type: 'http', url, ...extra }
}

const signal = new AbortController().signal

describe('interpolateEnvVars', () => {
  const env = { TOKEN: 'tok', EMPTY: '' } as Record<string, string | undefined>

  it('resolves allowlisted names and leaves non-allowlisted ones empty', () => {
    expect(interpolateEnvVars('Bearer $TOKEN', new Set(['TOKEN']), env)).toBe('Bearer tok')
    expect(interpolateEnvVars('Bearer $SECRET', new Set(['TOKEN']), env)).toBe('Bearer ')
  })
  it('supports the ${VAR} braced form and a missing env value resolves to empty', () => {
    expect(interpolateEnvVars('${TOKEN}', new Set(['TOKEN']), env)).toBe('tok')
    expect(interpolateEnvVars('$NOPE', new Set(['NOPE']), env)).toBe('')
  })
  it('strips CR, LF, and NUL bytes to prevent header injection', () => {
    const out = interpolateEnvVars('a\r\nb\x00c', new Set([]), env)
    expect(out).toBe('abc')
  })
  it('defaults the env source to process.env', () => {
    process.env.DSH_HTTP_DEFAULT_SRC = 'from-process-env'
    // With the default env source, an allowlisted name resolves from process.env.
    expect(interpolateEnvVars('x $DSH_HTTP_DEFAULT_SRC', new Set(['DSH_HTTP_DEFAULT_SRC']))).toBe('x from-process-env')
    delete process.env.DSH_HTTP_DEFAULT_SRC
  })
})

describe('runHttpHook', () => {
  it('POSTs the payload JSON and maps a 200 body as structured stdout (exit 0)', async () => {
    const { port, requests } = await mockServer(() => ({
      status: 200,
      body: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } }),
    }))
    const out = await runHttpHook(hook(`http://127.0.0.1:${port}/h`, { allowedEnvVars: ['TOKEN'] }), {
      payload: { tool_name: 'Bash' },
      allowedEnvVars: new Set(['TOKEN']),
      defaultTimeoutMs: 5000,
      signal,
      now: () => 0,
    })
    expect(out.output.exitCode).toBe(0)
    expect(out.output.decision).toBe('deny')
    const req = requests[0]!
    expect(req.method).toBe('POST')
    expect(req.headers['content-type']).toBe('application/json')
    expect(JSON.parse(req.body)).toEqual({ tool_name: 'Bash' })
  })

  it('maps a non-200 status as the exit code (non-blocking) and parses its body as stdout', async () => {
    const { port } = await mockServer(() => ({ status: 418, body: 'teapot' }))
    const out = await runHttpHook(hook(`http://127.0.0.1:${port}/h`), {
      payload: {}, allowedEnvVars: new Set(), defaultTimeoutMs: 5000, signal, now: () => 0,
    })
    expect(out.output.exitCode).toBe(418)
    expect(out.output.stdout).toBe('teapot')
    expect(out.output.decision).toBeUndefined()
  })

  it('treats a 200-with-block-JSON body as a blocking decision (deny with reason)', async () => {
    // The reference CC http hook maps a 200 response body through the SAME
    // structured-stdout parser as a command hook, so a permissionDecision:deny
    // body blocks even on HTTP success. status 2 is not a real HTTP code, so
    // blocking flows through the body, not the status.
    const { port } = await mockServer(() => ({
      status: 200,
      body: JSON.stringify({ decision: 'block', reason: 'no' }),
    }))
    const out = await runHttpHook(hook(`http://127.0.0.1:${port}/h`), {
      payload: {}, allowedEnvVars: new Set(), defaultTimeoutMs: 5000, signal, now: () => 0,
    })
    expect(out.output.exitCode).toBe(0)
    expect(out.output.decision).toBe('block')
    expect(out.output.reason).toBe('no')
  })

  it('interpolates header values against the effective allowlist (hook ∩ policy)', async () => {
    process.env.DSH_TEST_HOOK_TOKEN = 'tokval'
    const { port, requests } = await mockServer(() => ({ status: 200, body: '' }))
    const out = await runHttpHook(hook(`http://127.0.0.1:${port}/h`, {
      headers: { Authorization: 'Bearer $DSH_TEST_HOOK_TOKEN', X: '$NOPE' },
      allowedEnvVars: ['DSH_TEST_HOOK_TOKEN'],
    }), {
      payload: {}, allowedEnvVars: new Set(['DSH_TEST_HOOK_TOKEN']), defaultTimeoutMs: 5000, signal, now: () => 0,
    })
    expect(out.output.exitCode).toBe(0)
    expect(requests[0]!.headers['authorization']).toBe('Bearer tokval')
    expect(requests[0]!.headers['x']).toBe('')
    delete process.env.DSH_TEST_HOOK_TOKEN
  })

  it('returns a non-blocking error (no exit code) when the URL is not in the allowlist', async () => {
    const out = await runHttpHook(hook('http://127.0.0.1:1/x'), {
      payload: {}, allowedEnvVars: new Set(), allowedHttpHookUrls: ['http://127.0.0.1:9/*'], defaultTimeoutMs: 5000, signal, now: () => 0,
    })
    expect(out.output.exitCode).toBeUndefined()
    expect(out.output.stderr).toContain('allowedHttpHookUrls')
  })

  it('allows loopback/local URLs when no pattern blocks them (undefined → unrestricted)', async () => {
    const { port } = await mockServer(() => ({ status: 200, body: '' }))
    const out = await runHttpHook(hook(`http://127.0.0.1:${port}/h`), {
      payload: {}, allowedEnvVars: new Set(), defaultTimeoutMs: 5000, signal, now: () => 0,
    })
    expect(out.output.exitCode).toBe(0)
  })

  it('treats an EMPTY allowlist as unrestricted (unset config cannot block hooks)', async () => {
    // Loaders materialize an unset optional array as `[]`, so empty == unset:
    // it must NOT block the hook. Blocking only happens with a NON-empty,
    // non-matching allowlist (covered above by the `allowedHttpHookUrls: […]`
    // test).
    const { port } = await mockServer(() => ({ status: 200, body: '' }))
    const out = await runHttpHook(hook(`http://127.0.0.1:${port}/x`), {
      payload: {}, allowedEnvVars: new Set(), allowedHttpHookUrls: [], defaultTimeoutMs: 5000, signal, now: () => 0,
    })
    expect(out.output.exitCode).toBe(0)
  })

  it('surfaces a fetch failure as a non-blocking error (no exit code)', async () => {
    const { port } = await mockServer(() => ({ status: 200, body: '' }))
    const out = await runHttpHook(hook(`http://127.0.0.1:${port}/h`), {
      payload: {}, allowedEnvVars: new Set(), defaultTimeoutMs: 5, signal, now: () => 0,
      fetchImpl: (() => Promise.reject(new Error('net down'))) as typeof fetch,
    })
    expect(out.output.exitCode).toBeUndefined()
    expect(out.output.stderr).toBe('net down')
  })

  it('uses the hook timeoutSec as an override (default timeout branch aside)', async () => {
    const { port } = await mockServer(() => ({ status: 200, body: '' }))
    const out = await runHttpHook(hook(`http://127.0.0.1:${port}/h`, { timeoutSec: 60 }), {
      payload: {}, allowedEnvVars: new Set(), defaultTimeoutMs: 5000, signal, now: () => 0,
    })
    expect(out.output.exitCode).toBe(0)
  })

  it('surfaces a NON-Error fetch throw as a non-blocking error (String(error) arm)', async () => {
    const { port } = await mockServer(() => ({ status: 200, body: '' }))
    const out = await runHttpHook(hook(`http://127.0.0.1:${port}/h`), {
      payload: {}, allowedEnvVars: new Set(), defaultTimeoutMs: 5000, signal, now: () => 0,
      fetchImpl: (() => { throw 'network exploded' }) as unknown as typeof fetch,
    })
    expect(out.output.exitCode).toBeUndefined()
    expect(out.output.stderr).toBe('network exploded')
  })

  it('aborts the request when the owning signal fires (onAbort path)', async () => {
    const controller = new AbortController()
    const { port } = await mockServer(() => ({ status: 200, body: '' }))
    const out = runHttpHook(hook(`http://127.0.0.1:${port}/h`), {
      payload: {}, allowedEnvVars: new Set(), defaultTimeoutMs: 5000, signal: controller.signal, now: () => 0,
      // A fetch that rejects only when its signal aborts — so the outer abort
      // (which calls controller.abort()) rejects the in-flight request.
      fetchImpl: ((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch,
    })
    controller.abort()
    const result = await out
    expect(result.output.exitCode).toBeUndefined()
    expect(result.output.stderr).toBe('aborted')
  })

  it('times out a never-resolving request via the hook timer (timer callback path)', async () => {
    const { port } = await mockServer(() => ({ status: 200, body: '' }))
    const out = await runHttpHook(hook(`http://127.0.0.1:${port}/h`), {
      payload: {}, allowedEnvVars: new Set(), defaultTimeoutMs: 60, signal, now: () => 0,
      // A fetch that never settles on its own; the hook's own 60ms timer aborts
      // the request controller, whose signal the fake fetch rejects on.
      fetchImpl: ((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('timedout')))
      })) as unknown as typeof fetch,
    })
    const result = await out
    expect(result.output.exitCode).toBeUndefined()
    expect(result.output.stderr).toBe('timedout')
  })
})
