# @dsh-cc/web-fetch-http

English | [中文](README.zh.md)

The CC host-plane HTTP(S) fetch provider. It registers a `CcHttpFetchProvider` into the `ctx.web` fetch registry under the id `'http'` (`LOCAL_FETCH_PROVIDER_ID`), wrapping the harness `HttpFetchProvider` with a literal SSRF gate and an optional `http:` → `https:` upgrade. It does not call the stock `web-fetch-http` plugin's `apply()`, so exactly one provider with the id `'http'` may be mounted per context.

## How it works

Every `ctx.web.fetch` request URL passes through the pure gate `gateAndRewrite` before the inner provider sees it — no socket is opened for a rejected URL:

1. Empty, unparsable, or non-`http(s)` URLs → `WEB_INVALID_URL`.
2. Credentialed URLs (`user:pass@`) → `WEB_BLOCKED_URL`.
3. URLs longer than `maxUrlLength` → `WEB_INVALID_URL`.
4. When `blockPrivateNetwork` (default `true`), private/non-public destinations → `WEB_BLOCKED_URL` with the message `blocked: private or non-public destination`.
5. When `upgradeInsecure` (default `true`), public `http:` URLs are rewritten to `https:` (host/path/query/hash preserved). Private hosts are never upgraded.

`isBlockedDestination` inspects the parsed hostname only. The WHATWG URL parser has already folded decimal/octal IPv4 hosts (`http://2130706433/` has hostname `127.0.0.1`), so integer-host obfuscation is covered. Blocked classes:

| Class | Examples |
|---|---|
| Loopback names | `localhost`, `*.localhost`, `localhost.` |
| Loopback IPs | `127.0.0.0/8`, `::1`, IPv4-mapped `:ffff:127.0.0.1` |
| Link-local | `169.254.0.0/16` (incl. `169.254.169.254`), `fe80::/10` |
| RFC1918 | `10/8`, `172.16/12`, `192.168/16` |
| CGNAT | `100.64.0.0/10` |
| IPv6 ULA | `fc00::/7` |
| Unspecified / multicast | `0.0.0.0`, `::`, `224.0.0.0/4`, `ff00::/8` |

## Configuration

```ts
export const Config = z.object({
  maxUrlLength: z.number().default(2048),
  maxResponseBytes: z.number().default(2_000_000),
  maxBodyChars: z.number().default(100_000),
  timeoutMs: z.number().default(20_000),
  maxRedirects: z.number().default(3),
  userAgent: z.string().default('dsh-cc/0.4.1 (+https://github.com/dsh-cc/dsh-cc)'),
  upgradeInsecure: z.boolean().default(true),
  blockPrivateNetwork: z.boolean().default(true),
})
```

Invalid numeric config throws at plugin construction (positive finite caps, `timeoutMs` within Node's timer range, `maxRedirects` a non-negative integer). `blockPrivateNetwork: false` is a deployment escape hatch for air-gapped/internal docs — there is no production `allowTestLoopback` switch; transport tests that need a loopback server set the config in the test fixture only.

## Install / registration

```ts
import * as WebFetchHttpCc from '@dsh-cc/web-fetch-http'

await ctx.plugin(WebRuntime)          // @deepseek-ai/dsh-web
await ctx.plugin(WebFetchHttpCc, {})  // registers the gated provider
```

Do **not** also mount the stock `@deepseek-ai/dsh-web-fetch-http` plugin: duplicate id → `WEB_DUPLICATE_PROVIDER`.

## Known limits

- **No DNS lookup.** The gate is literal-only. A public hostname that resolves to a private address (DNS rebinding, including per-hop rebinding behind a same-origin redirect) is a **residual**: the wrapper never sees inner redirect hops (same-origin redirects keep the hostname, but DNS is re-resolved per connection). Fixing this requires DNS pinning inside the harness `web-fetch-http` provider (`webfetch-ssrf-allowlist` gap); this package documents the gap, it does not claim SSRF protection is complete.
- **Tavily / JS-rendered extraction is not this package.** Tavily is a separate MCP/skill (markdown `POST /extract`), never a `WebFetchProvider` and not a fallback for local fetch failures.
- The wrapper does not re-run the gate on inner redirect hops; the harness provider re-validates transport hygiene (scheme, credentials, length) per hop, and cross-origin redirects are refused.
