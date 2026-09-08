# @dsh-cc/tool-web-fetch

CC-style `web_fetch` replacement with an optional `prompt`. This package replaces the
stock `@deepseek-ai/dsh-tool-web` `web_fetch` when the CC preset sets `tool-web` to
`fetch: false` and mounts this row in `cc-services` instead.

## Behavior

- **Without `prompt`** (or with a blank/whitespace one): identical to the stock tool —
  the raw converted page text is returned.
- **With `prompt`** and a configured `haiku` model alias (`ccModelRoutes.resolve('haiku')`):
  the fetched document is converted and passed, together with the prompt, to a one-shot
  summarize call on that cheap lane. The tool returns only the extraction. A string-form
  alias (`haiku: deepseek-v4-flash`, model only) inherits the missing provider from the
  calling agent's request-header; with no calling agent (hence no parent provider) the
  tool fails hard.
- **With `prompt`** but the `haiku` alias unconfigured (no `ccModelRoutes` service or the
  resolver returns nothing): the tool throws
  `web_fetch: prompt requires a configured haiku model alias` **before any fetch is
  performed** — the page is not fetched, streamed, or returned.

The summarize call never carries a `purpose` field: the harness `GenerateOptions.purpose`
union is closed (`'compaction' | 'session-title'`). A summary model that requests a tool
or produces no text fails the call as an `isError` tool result.

## Provider requirement

CC deployments use the stock `@deepseek-ai/dsh-web-fetch-http` executor from
dsh-base (DNS-pinned, public-only per hop), with CC egress caps restated by
the cc-shell bundle. The tool upgrades `http:` URLs to `https:` before the
seam call (CC WebFetch parity); it never registers a provider itself — tests
fake `ctx.web.fetch`.

## Prompt guidance interplay

Setting `tool-web` `fetch: false` also drops the stock "Follow up with web_fetch" clause
from the `web_search` system-prompt section. This package re-registers the
`tool:web_fetch` prompt section (order 111) covering fetch guidance.

## Known limits

- No host allowlist in this package: SSRF policy lives in the executor — the
  stock provider resolves public-only addresses and pins them per hop, so the
  DNS-rebinding window is closed upstream (rc.1). Anything stricter belongs
  there, not here.
- Tavily / Firecrawl are plugins/skills, not fetch backends for this tool.
