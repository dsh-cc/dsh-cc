/**
 * The CC fetch provider wrapper: an SSRF-gated decorator around the harness
 * `HttpFetchProvider`. The gate runs before the inner provider is handed the
 * URL, so no socket is ever opened for a blocked or invalid destination.
 * @module @dsh-cc/web-fetch-http/provider
 */

import { HttpFetchProvider, LOCAL_FETCH_PROVIDER_ID } from '@deepseek-ai/dsh-web-fetch-http'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { gateAndRewrite } from './ssrf.ts'
import type { GatePolicy } from './ssrf.ts'

/**
 * A `WebFetchProvider` that gates and (optionally) upgrades every request URL
 * with {@link gateAndRewrite}, then delegates to the inner harness
 * `HttpFetchProvider` for transport (same-origin redirects, byte/char caps,
 * charset decoding, binary reject). Registers under the same id `'http'`
 * (`LOCAL_FETCH_PROVIDER_ID`) that the stock `web-fetch-http` plugin would use
 * — only one of the two may be mounted per context.
 */
export class CcHttpFetchProvider implements WebFetchProvider {
  readonly id = LOCAL_FETCH_PROVIDER_ID

  constructor(
    private readonly inner: HttpFetchProvider,
    private readonly policy: GatePolicy,
  ) {}

  /** Delegated: the anonymous public fetcher is always usable. */
  available(): boolean {
    return this.inner.available()
  }

  /**
   * Gate the request URL, then fetch it through the inner provider.
   * @param request - the fetch request (only `url` is meaningful upstream).
   * @param signal - optional cancellation signal forwarded to the inner fetch.
   * @returns the inner provider's result for the gated URL.
   */
  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const url = gateAndRewrite(request.url, this.policy)
    return this.inner.fetch({ url }, signal)
  }
}
