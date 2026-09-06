import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as WebFetchHttpCc from '@dsh-cc/web-fetch-http'

describe('cc-shell bundle — web-fetch-http-cc row (SSRF-gated provider over a real seam)', () => {
  it('mounts the CC wrapper (not stock web-fetch-http) and registers exactly one id "http"', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime)
    await ctx.plugin(WebFetchHttpCc, {
      timeoutMs: 20000,
      maxResponseBytes: 2000000,
      maxRedirects: 3,
      upgradeInsecure: true,
      blockPrivateNetwork: true,
    })
    // A provider is present and selected: 'not-a-url' must be gated by the
    // wrapper, not reported as a missing provider.
    await expect(ctx.web.fetch({ url: 'not-a-url' })).rejects.toThrow(
      expect.not.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }),
    )
    expect(WebFetchHttpCc.LOCAL_FETCH_PROVIDER_ID).toBe('http')
    await ctx.fiber.dispose()
  })

  it('blocks a loopback URL with WEB_BLOCKED_URL under the default policy', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime)
    await ctx.plugin(WebFetchHttpCc, {})
    await expect(ctx.web.fetch({ url: 'http://127.0.0.1/' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_BLOCKED_URL', message: 'blocked: private or non-public destination' }),
    )
    await ctx.fiber.dispose()
  })

  it('gates invalid URLs with WEB_INVALID_URL before any network access', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime)
    await ctx.plugin(WebFetchHttpCc, {})
    await expect(ctx.web.fetch({ url: 'not-a-url' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_INVALID_URL' }),
    )
    await ctx.fiber.dispose()
  })
})
