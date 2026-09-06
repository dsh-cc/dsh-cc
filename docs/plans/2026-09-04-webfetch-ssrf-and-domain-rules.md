# WebFetch: host-plane HTTP provider, literal SSRF gate, domain permission rules

Status: Staff-approved (nits folded; 2026-09-04 cold review). Constraint: **dsh-cc only** — do not modify deepseek-harness source. This plan supersedes the stock-deploy caveat in `docs/plans/2026-09-02-haiku-worker-stuffs.md` §Feature 3 (the tool replacement stays; the "no fetch provider" / NOTICE-degrade clauses do not).

## Goal

Make CC-mode `web_fetch` a tool that actually fetches, with Claude Code's domain-rule shape and a local SSRF floor that harness deferred:

| Piece | Claude Code | dsh-cc today | This plan |
|---|---|---|---|
| Tool schema | `url` + required `prompt` (lossy extract) | `url` + optional `prompt` | keep optional `prompt` |
| No prompt | n/a (prompt required) | raw converted page | unchanged |
| Prompt + haiku | cheap-lane extract | cheap-lane extract | unchanged |
| Prompt, haiku missing | n/a | **NOTICE + full page** (lies) | **hard fail** (`isError`) |
| Executor | Anthropic-hosted fetch | schema mounted; `WEB_PROVIDER_UNAVAILABLE` | dsh-cc wrapper around `HttpFetchProvider` |
| SSRF | hostname preflight to api.anthropic.com | none; "enable only on egress-restricted deploys" | **literal** private/loopback/metadata block in the wrapper |
| Domain rules | `WebFetch(domain:*.example.com)` | parsed as prefix; `subjectOf` never sees a hostname | real domain matcher + hostname subject |
| Always-allow | persists a domain rule | whole-tool `WebFetch` | `WebFetch(domain:<host>)` |
| Tavily / extract | separate | plugin/skill already loadable | **not** a `WebFetchProvider` |

Success: a CC CLI session can fetch a public URL; `WebFetch(domain:example.com)` allow/deny/ask matches; `http://127.0.0.1/` fails with `WEB_BLOCKED_URL` even after the user Always-allows it.

## Hard constraints

1. **Do not edit deepseek-harness.** No patches to `dsh-web`, `dsh-web-fetch-http`, `dsh-tool-web`, or `dsh-bundle-base`. Consume public exports only.
2. **Do not import unpublished subpaths.** `validateFetchUrl` is **not** re-exported from `@deepseek-ai/dsh-web-fetch-http` (entry exports `HttpFetchProvider`, `LOCAL_FETCH_PROVIDER_ID`, `DEFAULT_USER_AGENT`, `apply`). `files` is `lib/` only — `./src/*` works in a path-link checkout and breaks on npm. Reimplement URL hygiene in dsh-cc.
3. **`HttpFetchProvider` is constructable** from the package entry. The wrapper `new`s it and does **not** call the upstream `apply()` (that would register a second `id: 'http'`).
4. **Same-name replacement stays.** `tool-web fetch: false` + `@dsh-cc/tool-web-fetch` inside `cc-services`. Do not wrap stock `web_fetch`.
5. **Output schema stays `WebFetchResult`.** `{ url, statusCode, body: { kind: 'html'\|'text', content }, truncated }` so `WebFetchResultView` / session replay keep working.
6. **Cheap lane is `ccModelRoutes.resolve('haiku')`.** No second alias, no new settings namespace.
7. **No new `cc-services` isolate keys.** The **six-key** `toEqual` in `packages/preset/cc/tests/composition.spec.ts` (`toolSearch`, `microcompactor`, `ccModelRoutes`, `resumePinStore`, `mcpConnections`, `hookBridgeStatus`) stays. The fetch provider is host-plane (`cc-shell`), not in the isolate group.
8. **Tavily / Firecrawl are not fetch providers.** Harness README: provider-backed page extraction is out of scope of `fetch()`. Users who need JS-rendered extract keep the Tavily MCP/skill.
9. **English** for plan, READMEs, PR title/description, commit messages. Agent/command bodies already English.
10. **Do not ratchet `scripts/check-file-size.baseline.json`.** Extract a module rather than grow `parser.ts` (280 lines) past the gate.

## Why these seams (and not the rejected ones)

### Retrieval lives on `ctx.web`, not in the tool plugin

`dsh-web` owns safe retrieval. `dsh-tool-web` (and our replacement) own schema/presentation. SSRF is retrieval hygiene — the same layer that already rejects credentialed URLs and non-http(s) schemes. Putting the gate in `tool-web-fetch` would miss any other `ctx.web.fetch` caller (tests, future skills).

The gate cannot go into `HttpFetchProvider` without editing harness. So dsh-cc registers a **wrapper** `WebFetchProvider` with the same id `'http'` (`LOCAL_FETCH_PROVIDER_ID`) that:

1. validates + SSRF-gates + optionally upgrades http→https
2. delegates to an inner `HttpFetchProvider` (same-origin redirects, byte/char caps, charset, binary reject, non-2xx-as-result)

Mount it from **cc-shell** (`cordis.patch.yml` insert list), next to the tools swap. `web` is already a host service from `dsh-bundle-base`. Do **not** mount the stock `web-fetch-http` plugin — duplicate id → `WEB_DUPLICATE_PROVIDER`.

Rejected: mounting `web-fetch-http` from the CC preset `cc-services` group. The seam is host-plane; a provider should share the host fiber. `web` is visible inside the group (not isolated) but skill/non-CC callers on the host would not see a group-scoped registration cleanly, and we would still need a host row.

Rejected: forking `HttpFetchProvider`. Transport policy (redirects, caps, UA) is upstream's job and already matches Claude's "don't follow cross-origin; make the model retry".

### Domain rules are permission content rules, not `tools.restrict()`

`cc-names.stripArgSpec` turning `WebFetch(domain:example.com)` into `web_fetch` is **correct** for `tools.restrict()` (name-level). Do not change it. The permission engine already parses `ToolName(content)`; it just never extracts a hostname subject and never special-cases `domain:`.

Rejected: a parallel allowlist inside the fetch provider. That would ignore user/project/session rule sources and the existing waterfall (whole-tool deny beats content allow, source priority, plan-mode read-only).

Rejected: feeding sandbox `allowedDomains` into WebFetch. Claude keeps those tables separate (Bash egress ≠ model-directed fetch).

### Prompt-without-haiku must fail, not NOTICE

NOTICE + full page tells the model it asked for an extraction and hands it 32k–200k of source. Token budget, approval preview, and the system prompt all lie. Hard-fail is the honest contract: omit `prompt` for the raw page; pass `prompt` only when haiku is a complete `{provider, model}` pair.

This is a **behavior change** for sessions that already pass `prompt` without haiku. Accept it; the current degrade was a Slice C caveat, not a product promise.

### Tavily is the wrong fetch backend

`POST /extract` returns markdown / `failedResults`, not `{statusCode, body.kind, truncated}`. No cookies, no private hosts, `query`≠`prompt` (500-char chunks). Official Tavily plugin already loads through `cc-plugin-loader`. Do not register it as `WebFetchProvider`, do not fallback-to-Tavily on local failure.

## Architecture

```
model  →  web_fetch({url, prompt?})          @dsh-cc/tool-web-fetch
       →  parseFetchArgs                     @deepseek-ai/dsh-tool-web (public)
       →  tools/pre-execute                  @dsh-cc/permission-rules
            subject = canonicalizeHostname(url)
            WebFetch(domain:…) content rules
       →  ctx.web.fetch({url}, signal)       @deepseek-ai/dsh-web (unmodified)
            CcHttpFetchProvider.id = 'http'  @dsh-cc/web-fetch-http  NEW
              gateAndRewrite → WEB_BLOCKED_URL / WEB_INVALID_URL
              inner HttpFetchProvider        @deepseek-ai/dsh-web-fetch-http (unmodified)
       →  no prompt: return seam result
       →  prompt + haiku: one-shot summary
       →  prompt, no haiku: WebFetchError (isError)
       →  output.render = formatFetchOutput  @deepseek-ai/dsh-tool-web (public)
```

Permission runs before the network. The SSRF gate runs before inner GET. An allow rule cannot punch through `WEB_BLOCKED_URL`.

## Slice A — Domain permission rules

### Matcher

Add one arm to `ContentMatcher` in `packages/interaction/permission-rules/src/types.ts`:

```ts
export type ContentMatcher =
  | { kind: 'prefix'; prefix: string }
  | { kind: 'wildcard'; pattern: string }
  | { kind: 'domain'; hostname: string }
```

`hostname` is already canonical (ASCII lowercase, no trailing dot, no brackets). A leading `*.` is stored as part of `hostname` (e.g. `*.example.com`).

### Parsing

Extract `packages/interaction/permission-rules/src/domain.ts` (do not grow `parser.ts`). This module is browser-safe — **do not** import `ccToolAliases` here (`parser.ts` is imported by the TUI).

- `isWebFetchRuleTool(name: string)` — `name === 'WebFetch' || name === 'web_fetch'`.
- `canonicalizeHostname(url: string): string | undefined` — `new URL(url)`, lowercase hostname, strip trailing dots, strip `[…]` wrapping. Invalid URL → `undefined` (permission falls through to whole-tool / passthrough; do not invent a host). Port is ignored (Claude matches hostname only).
- `parseDomainContent(content: string): ContentMatcher` — content must match `/^domain:\s*(.+)$/i`. The captured host is canonicalized as a hostname (not a URL). Reject empty, scheme/path/port (`domain:https://x`, `domain:example.com/path`, `domain:example.com:443`), and `*` not on a label boundary. Throw `TypeError` (fail-loud at rule load).
- `domainMatches(pattern: string, hostname: string): boolean` — Claude 2.1.172:
  - `example.com` → exact equality only (`www.example.com` does **not** match).
  - `*.example.com` → `hostname === 'example.com'` **or** `hostname` ends with `.example.com` (any subdomain depth).
  - A `*` in any other label position matches **exactly one dot-separated label** (`foo.*.com` matches `foo.bar.com`, not `foo.bar.baz.com`; `*.*.example.com` matches two labels then `example.com`).
  - `*` is **not** the Bash "any characters" wildcard. `*example.com` (no dot before the name) is a parse error, not a subdomain pattern.

`parseRuleString`: after deriving `toolName` + `content`, if `isWebFetchRuleTool(toolName)` and content starts with `domain:` (case-insensitive), call `parseDomainContent` instead of `matchContent`. `Bash(domain:example.com)` stays a **prefix** matcher on the string `domain:example.com`.

`contentMatches`: add the `kind === 'domain'` arm → `domainMatches(matcher.hostname, subject)`.

`subjectOf` in `matchers.ts`: if the call is WebFetch (`ccToolAliases(exec.name)` includes `WebFetch`, already imported in that file) and `args.url` is a string, return `canonicalizeHostname(args.url)` (possibly `undefined`). Keep bash `command` and `file_path` first so a hypothetical tool with both is unchanged.

### Waterfall

No change to `evaluatePermission` order. Domain rules are content rules:

- Whole-tool `deny: ['WebFetch']` still beats a content allow.
- `userSettings` deny of a domain beats `config` allow of the same domain (existing `SOURCE_PRIORITY`).
- `web_fetch` stays in `DEFAULT_READ_ONLY_TOOLS` — plan mode auto-allows. The SSRF gate still blocks private hosts.
- Classifier stays LOW for WebFetch (only bash/file-edit escalate). Private network is the provider's job.
- No matching rule → `passthrough` → approval seam. Do **not** default-allow WebFetch.

Session-scoped grants (`SessionAllowlist.matches`) already consult content matchers when `subject` is present — once `subjectOf` returns a hostname, "Allow for this session" with a domain rule works.

### Approval UX

`packages/ui/tui/src/harness/approval-preview.ts` `allowRuleOf`:

- The TUI already depends on `@dsh-cc/permission-rules`. Export `canonicalizeHostname` (and `isWebFetchRuleTool` if useful) from `permission-rules/src/index.ts`.
- If `toolName` is `WebFetch` or `web_fetch` (approval payloads use the CC spelling) and `preview.kind === 'args'`, JSON-parse `preview.json`, read `url`, canonicalize hostname; on success return `ruleString('WebFetch', 'domain:' + hostname)` → `WebFetch(domain:example.com)`.
- Persist the **exact host**, not `*.host`.
- If URL/host cannot be parsed, keep today's whole-tool `WebFetch`.

Do **not** add an `ApprovalPreview` union arm in this slice (that forces overlay render changes). Leave the preview as pretty-printed args. Optional follow-up: a `kind: 'fetch'` preview line.

Key 3 (always) and key 4 (session) both go through `allowRuleOf` (`driver-approvals.ts`) — one change covers both.

### Tests (write first)

`packages/interaction/permission-rules/tests/domain.spec.ts` **new**:

- `parseRuleString('WebFetch(domain:example.com)')` → `{ kind: 'domain', hostname: 'example.com' }`
- `parseRuleString('WebFetch(domain:*.example.com)')` — `a.b.example.com` matches; `example.com` matches; `example.com.evil.com` does not
- `parseRuleString('web_fetch(domain:Example.COM.)')` — canonical host
- `parseRuleString('Bash(domain:example.com)')` → prefix, not domain
- `parseRuleString('WebFetch(domain:https://x)')` throws
- `parseRuleString('WebFetch(domain:)')` throws
- `parseRuleString('WebFetch(domain:*example.com)')` throws
- `canonicalizeHostname('https://WWW.Example.com./path?q=1')` → `www.example.com` (the hostname is `www.example.com`; exact `domain:example.com` does not match it)
- `canonicalizeHostname('https://Example.com./path?q=1')` → `example.com`
- `canonicalizeHostname('https://example.com:8443/')` → `example.com`
- `canonicalizeHostname('not a url')` → `undefined`
- `evaluatePermission`: allow exact host; `www` does not match exact; user deny beats config allow
- `subjectOf({ name: 'web_fetch', arguments: { url: 'https://docs.example.com/a' } })` → `docs.example.com`

`packages/ui/tui/tests/approval-preview.spec.ts`:

- `allowRuleOf('WebFetch', { kind: 'args', json: '{"url":"https://docs.example.com/a"}' })` → `WebFetch(domain:docs.example.com)`
- unparsable args still → `WebFetch`
- existing Bash / Write cases unchanged

`packages/core/tools/tests/cc-names.spec.ts`: `WebFetch(domain:example.com)` → `web_fetch` **stays** (restrict is name-level).

## Slice B — Host-plane fetch provider + literal SSRF gate

### New package

`packages/web/fetch-http` (`@dsh-cc/web-fetch-http`). Copy the `tool-sleep` skeleton (plugin + invariant + README pair + `README.i18n.yaml` + tests). Workspace glob is `packages/*/*`, so this path is a package.

| | |
|---|---|
| `name` | `web-fetch-http-cc` |
| `inject` | `['web']` |
| Role | function/namespace plugin; `registerFetchProvider`; does **not** own `ctx.web` |

Public exports: `apply`, `Config`, `name`, `inject`, `CcHttpFetchProvider`, `LOCAL_FETCH_PROVIDER_ID` re-export (same `'http'` string), plus the pure `gateAndRewrite` / `isBlockedDestination` for unit tests.

`apply` constructs `new HttpFetchProvider(limits)` **without** calling upstream `apply`, wraps it, registers the wrapper.

### Gate (pure, no I/O) — `src/ssrf.ts`

`gateAndRewrite(input: string, policy): string` throws `WebError` from `@deepseek-ai/dsh-web`.

Order:

1. Empty / non-string → `WEB_INVALID_URL`.
2. Parse with `new URL`. Invalid → `WEB_INVALID_URL`.
3. Scheme not `http:` / `https:` → `WEB_INVALID_URL`.
4. `username` or `password` non-empty → `WEB_BLOCKED_URL` (same code as harness).
5. Length > `maxUrlLength` → `WEB_INVALID_URL`.
6. If `policy.blockPrivateNetwork` (default true) and `isBlockedDestination(url)` → `WEB_BLOCKED_URL` with message `blocked: private or non-public destination`.
7. If `policy.upgradeInsecure` (default true) and `protocol === 'http:'` **and** the host is not a blocked destination → rewrite to `https:` (keep host/path/query/hash). Private hosts are not upgraded (useless, and it would break local test servers when the gate is off).
8. Return `url.toString()`.

`isBlockedDestination` inspects the **parsed** hostname / IP (WHATWG already folds decimal/octal IPv4 — `http://2130706433/` has hostname `127.0.0.1`; that **must** have a test):

| Class | Examples |
|---|---|
| Loopback names | `localhost`, `*.localhost`, `localhost.` |
| Loopback IPs | `127.0.0.0/8`, `::1`, IPv4-mapped `:ffff:127.0.0.1` |
| Link-local | `169.254.0.0/16` (incl. `169.254.169.254`), `fe80::/10` |
| RFC1918 | `10/8`, `172.16/12`, `192.168/16` |
| CGNAT | `100.64.0.0/10` |
| IPv6 ULA | `fc00::/7` |
| Unspecified / multicast | `0.0.0.0`, `::`, `224.0.0.0/4`, `ff00::/8` |

**v1 does no DNS lookup.** DNS rebinding (a public name that resolves to `127.0.0.1`) is a **known residual**, documented in the package README and left as the upstream `webfetch-ssrf-allowlist` gap. Do not claim SSRF is complete.

Inner still follows **same-origin** redirects only. Same host ⇒ the literal gate does not need to re-run per hop. Cross-origin still `WEB_REDIRECT_BLOCKED` (upstream); the model's retry re-enters permission + gate.

`blockPrivateNetwork: false` is a deployment escape hatch for air-gapped/internal docs. Default true. `/doctor` must **warn** when false (Slice D).

### Config

| Key | Default | Meaning |
|---|---|---|
| `maxUrlLength` | `2048` | same as upstream |
| `maxResponseBytes` | `2_000_000` | slightly under upstream 5 MB |
| `maxBodyChars` | `100_000` | same as upstream |
| `timeoutMs` | `20_000` | inner resource backstop; tool budget stays 30s |
| `maxRedirects` | `3` | same as today's cc-shell test fixture |
| `userAgent` | `dsh-cc/<version> (+https://github.com/dsh-cc/dsh-cc)` | product UA, never a browser disguise |
| `upgradeInsecure` | `true` | public http→https |
| `blockPrivateNetwork` | `true` | SSRF gate |

Numeric validation mirrors upstream (positive finite caps; `maxRedirects` non-negative integer; `timeoutMs` within Node's timer range). Invalid config throws at plugin construction.

### Mount

`packages/bundle/cc-shell/cordis.patch.yml` insert list, after the existing rows:

```yaml
- id: web-fetch-http-cc
  name: '@dsh-cc/web-fetch-http'
  config:
    timeoutMs: 20000
    maxResponseBytes: 2000000
    maxRedirects: 3
    upgradeInsecure: true
    blockPrivateNetwork: true
```

- Add `@dsh-cc/web-fetch-http` as a **runtime `dependencies`** of `@dsh-cc/bundle-shell` (the patch names it; a missing runtime dep is the v0.4.1 dangling-link class of bug).
- The new package's `peerDependencies` include `@deepseek-ai/dsh-web-fetch-http`, `@deepseek-ai/dsh-web`, `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-invariants`.
- `devDependencies` path-link the harness packages the same way `tool-web-fetch` does.
- Do **not** put this row in `packages/preset/cc/agent.cordis.yml`. The preset comment about "web-fetch-http unshipped" is updated to point at the cc-shell wrapper.
- Isolate map unchanged.

`packages/bundle/cc-shell/tests/web-bundle.spec.ts`: switch the fixture from stock `WebFetchHttp` to the CC wrapper (or add a sibling `web-fetch-http-cc.spec.ts`). Assert:

- `ctx.tools` is not this package's job; this is a provider test.
- `ctx.web.fetch({ url: 'not-a-url' })` is **not** `WEB_PROVIDER_UNAVAILABLE`.
- Exactly one fetch provider id (`http`).
- With default policy, `http://127.0.0.1/` → `WEB_BLOCKED_URL`.

Transport tests that need a real loopback server set `blockPrivateNetwork: false` in the plugin config. **Do not** ship a production `allowTestLoopback` switch.

### Wiring a new package

Follow `tool-sleep` / `tool-web-fetch` **including the publish manifest**, not just the source layout:

- `package.json` version `0.4.1`; `publishConfig.access: "public"`; `license: "Apache-2.0"`; `repository.url` `git+https://github.com/dsh-cc/dsh-cc.git` with `directory: "packages/web/fetch-http"`; `files: ["lib"]`; `exports` for `"."`, `"./invariant"`, `"./src/*"`, `"./package.json"` (same shape as tool-sleep). **No `link:` in `dependencies`** (devDeps path-link harness packages; peers are `>=0.1.1-rc.2` / `workspace:^`).
- `tsconfig.json` (`extends` tsconfig.base, `rootDir: src`, `outDir: lib`)
- `tsconfig.packages.json` reference
- `tsconfig.base.json` path: `"@dsh-cc/web-fetch-http": ["./packages/web/fetch-http/src/index.ts"]`
- invariant companion (`./invariant` export) — empty installer, same jscpd-ignore pattern as tool-web-fetch
- README.md + README.zh.md + README.i18n.yaml; after the pair is consistent, `pnpm run verify-translation-pairing --write packages/web/fetch-http/README.md` (and the same for any other README pair this PR edits)
- `pnpm install` in the worktree after adding the workspace package (updates the lockfile). Worktree harness `link:` targets resolve via the existing untracked symlink `.claude/worktrees/deepseek-harness` → `github.com/deepseek-harness`; do not invent a second one.

`HttpFetchProvider`'s constructor takes a complete `HttpFetchLimits` (every field required). The wrapper builds that object from resolved Config — do not pass a partial.

### Tests (write first)

`packages/web/fetch-http/tests/ssrf.spec.ts` — pure, no server:

- blocks `http://127.0.0.1/`, `http://localhost/`, `http://169.254.169.254/`, `http://10.0.0.1/`, `http://192.168.1.1/`, `http://[::1]/`, `http://2130706433/`
- allows `https://example.com/path`
- upgrades `http://example.com/x` → `https://example.com/x` when `upgradeInsecure`
- does **not** upgrade `http://127.0.0.1/` when the gate is off (returns the http URL)
- rejects `ftp://example.com`, `https://user:pass@example.com`
- `blockPrivateNetwork: false` lets `http://127.0.0.1/` through the gate (inner may still fail to connect — that is not this test)

`packages/web/fetch-http/tests/provider.spec.ts` — Context + `dsh-web` + local `http.createServer` on `127.0.0.1`, plugin config `{ blockPrivateNetwork: false, upgradeInsecure: false }`:

- 200 text/plain → `{ statusCode: 200, body.kind: 'text' }`
- cross-origin redirect still `WEB_REDIRECT_BLOCKED`
- binary content-type still `WEB_UNSUPPORTED_CONTENT_TYPE`
- plugin registers id `http`; a second stock `web-fetch-http` `apply` on the same ctx throws duplicate (or we simply never mount stock — still assert one id)

## Slice C — Prompt contract

`packages/core/tool-web-fetch/src/index.ts`:

When `prompt` is non-empty after trim, resolve haiku **before** `ctx.web.fetch`. If `toOneShotRoute(routes?.resolve('haiku'), parent)` is `undefined`, **throw** `WebFetchError('web_fetch: prompt requires a configured haiku model alias')` without hitting the network. Do not return the page. Do not call `llm.stream`. (Today's NOTICE path fetches first — that waste goes away.)

Also update `defineTool` `description` so it no longer implies the prompt is silently ignored.

Delete the `NOTICE` constant and every "prompt ignored" test.

System-prompt `tool:web_fetch` (order 111) becomes:

```
Use the web_fetch tool to retrieve the content of a specific HTTP(S) URL (for example a result from web_search). Omit prompt to receive the page decoded to text (HTML is converted to markdown). If you pass prompt, a configured haiku alias summarizes the page against that instruction on the cheap lane and you receive only the extraction — the call fails if haiku is not configured. Cite the URL as a markdown link when you use its content. Cross-origin redirects are not followed; fetch the Location URL in a new call.
```

Keep: optional `prompt`, output schema, `isConcurrencySafe`, `fetchTimeoutMs` 30s, `fetchMaxOutputChars` 200k, `maxSummaryInputChars` 32k, `maxSummaryTokens` 2048, `purpose` omitted, reject tool-call summary output, `formatFetchOutput` / presenters imported from `@deepseek-ai/dsh-tool-web`.

Package description + README pair: drop "otherwise return the raw converted text" for the prompt-without-haiku path; document the hard fail.

### Tests

Replace the two NOTICE cases in `packages/core/tool-web-fetch/tests/tools.spec.ts`:

- prompt + no routes / resolve undefined / string-form haiku without a calling agent → `isError === true`, `streams.length === 0`, **fetch not called**, text matches `/haiku/`
- existing cheap-lane success, raw passthrough, blank url, seam throw, tool-call summary, `fetch: false` replacement — unchanged

## Slice D — `/doctor` + parity docs

### Doctor

`typeof ctx.web.fetch === 'function'` is **not** "a provider is mounted" — the seam method exists either way. Probe by executing (no real network). Harness `WebRuntime.fetch` calls `resolveProvider` **before** the provider sees the URL, so a missing provider is `WEB_PROVIDER_UNAVAILABLE` even for `not-a-url`; a present provider (ours gates first) yields `WEB_INVALID_URL` / `WEB_BLOCKED_URL` / `WEB_ABORTED`.

```ts
async function probeFetch(ctx): Promise<'missing' | 'present'> {
  try {
    await ctx.web.fetch({ url: 'not-a-url' }, AbortSignal.abort())
    return 'present' // unexpected success
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'WEB_PROVIDER_UNAVAILABLE') return 'missing'
    return 'present' // INVALID_URL / ABORTED / BLOCKED_URL / …
  }
}
```

Skip `web.ssrf-gate` (status `skip`) when the provider probe is `missing` — do not treat a missing executor as "gate off".

`webChecks` becomes async (collect already `await`s). New/updated rows:

| id | When | Status |
|---|---|---|
| `web.seam` | `ctx.web` present | ok / skip (unchanged) |
| `web.fetch-provider` | probe `missing` / `present` | **warn** / ok (was info on missing — too quiet) |
| `web.ssrf-gate` | `present` and a blocked URL (`http://127.0.0.1/`) with `AbortSignal.timeout(200)` throws `WEB_BLOCKED_URL` | ok; if the probe is `present` but the call is **not** blocked (network/abort/other code) → **warn** `SSRF gate off or bypassed` |
| `web.haiku-summarizer` | full haiku route vs inherit | ok / **info** `raw WebFetch OK; prompt summarization unavailable` |

Do not connect to the public internet. The `127.0.0.1` probe is blocked **before** connect when the gate is on; when the gate is off the 200ms abort keeps `/doctor` from hanging.

Add `packages/interaction/command-doctor/tests/collect-web.spec.ts` (or extend an existing collect spec) covering missing-provider warn, blocked-loopback ok, haiku inherit info. Declare any new test imports on the package (`check:spec-deps`).

### Capabilities manifest

Edit `docs/claude-code-capabilities.yaml` (authored SoT), then `pnpm docs:parity` in the same commit:

- `engine.web-fetch` deviation: mounted via `@dsh-cc/tool-web-fetch`; fetch executor is `@dsh-cc/web-fetch-http` wrapping `HttpFetchProvider`; optional prompt hard-fails without haiku; `WebFetch(domain:)` content rules; literal SSRF gate. Residual: no DNS pinning, no Anthropic preflight, no 15‑min cache, no pre-approved docs domains.
- `behavioral` stays **partial** (those residuals).
- `webfetch-ssrf-allowlist` problem text: CLI now mounts a wrapper; the remaining gap is DNS-pin / per-hop re-validation inside harness `web-fetch-http`. `needed_for` still `engine.web-fetch`.

Also update:

- `packages/core/tool-web-fetch/README.md` + `README.zh.md` (provider requirement + prompt fail)
- `packages/preset/cc/README.md` + `README.zh.md` (cc-shell now mounts the wrapper)
- `packages/preset/cc/agent.cordis.yml` comments (no longer "unshipped")

Hand-editing `docs/cc-parity-matrix.md` or the README parity block is a CI failure.

## Non-goals

- Editing deepseek-harness (including teaching `web_fetch` a prompt field, DNS-pin SSRF, widening `WebFetchRequest`).
- Tavily / Firecrawl as a `WebFetchProvider` or fallback.
- A `web_extract` first-class tool.
- Claude `skipWebFetchPreflight`, 15-minute response cache, `Claude-User` UA, `artifactRead`.
- A default pre-approved documentation-domain list (a later empty-default config allow is fine; user deny already wins).
- Merging sandbox `allowedDomains` into WebFetch rules.
- Model-facing timeout / format / multi-URL args.
- Bash+curl as a fetch fallback.
- New settings namespace / `web.fetch.enabled` flag — disable by composition (`disabled: true` on the cc-shell row) if a deploy must turn it off.
- New `ApprovalPreview` discriminant (keep args JSON in v1).
- Shared `oneShot` helper package.
- New `cc-services` isolate keys.

## Files (TDD order)

### Slice A

1. `packages/interaction/permission-rules/tests/domain.spec.ts` **new** (fails: no export)
2. `packages/interaction/permission-rules/src/domain.ts` **new**
3. `packages/interaction/permission-rules/src/types.ts` — matcher arm
4. `packages/interaction/permission-rules/src/parser.ts` — WebFetch `domain:` dispatch; `contentMatches` arm
5. `packages/interaction/permission-rules/src/matchers.ts` — `subjectOf`
6. `packages/interaction/permission-rules/src/index.ts` — re-export `canonicalizeHostname` if the TUI wants it; otherwise TUI may JSON-parse and call a small local helper. Prefer importing from permission-rules (already a tui dependency).
7. `packages/ui/tui/tests/approval-preview.spec.ts` — domain allowRuleOf
8. `packages/ui/tui/src/harness/approval-preview.ts`

### Slice B

9. `packages/web/fetch-http/tests/ssrf.spec.ts` **new**
10. `packages/web/fetch-http/src/ssrf.ts` **new**
11. `packages/web/fetch-http/tests/provider.spec.ts` **new**
12. `packages/web/fetch-http/src/{provider,index,invariant}.ts` + package.json + tsconfig + READMEs + i18n yaml
13. `tsconfig.base.json` path + `tsconfig.packages.json` reference
14. `packages/bundle/cc-shell/cordis.patch.yml` + `package.json` runtime dep
15. `packages/bundle/cc-shell/tests/web-bundle.spec.ts` (or sibling)

### Slice C

16. `packages/core/tool-web-fetch/tests/tools.spec.ts` — fail-not-NOTICE first
17. `packages/core/tool-web-fetch/src/index.ts`
18. `packages/core/tool-web-fetch/README.md` + `README.zh.md` + package.json description

### Slice D

19. `packages/interaction/command-doctor/tests/collect-web.spec.ts` **new**
20. `packages/interaction/command-doctor/src/checks/web.ts`
21. `docs/claude-code-capabilities.yaml` → `pnpm docs:parity`
22. preset + agent.cordis.yml comments

## Verification

Pass =

1. Worktree `pnpm install --frozen-lockfile` once after lockfile change (`pnpm install` to refresh the lockfile when the new workspace package is added; then frozen thereafter).
2. Focused tests, from the worktree, via `node_modules/.bin/vitest run` (do not `pnpm run` if it tries to manage the main checkout):
   - `packages/interaction/permission-rules/tests/domain.spec.ts`
   - `packages/ui/tui/tests/approval-preview.spec.ts`
   - `packages/web/fetch-http/tests/*.spec.ts`
   - `packages/core/tool-web-fetch/tests/tools.spec.ts`
   - `packages/bundle/cc-shell/tests/web-bundle.spec.ts`
   - `packages/interaction/command-doctor/tests/collect-web.spec.ts`
   - `packages/preset/cc/tests/composition.spec.ts` (isolate map still **six** keys; `tool-web-fetch` still group-nested)
3. `node_modules/.bin/tsc -b tsconfig.packages.json`
4. `node scripts/check-spec-deps.mjs`
5. `node scripts/check-file-size.mjs` — no baseline ratchet. If `parser.ts` would exceed its budget, the domain logic **must** live in `domain.ts` (already specified).
6. `node scripts/check-publish-manifests.mjs` and `node scripts/check-export-targets.mjs` — new package must pass both
7. `pnpm check:capabilities` and `pnpm check:parity` after the yaml edit
8. `pnpm docs:parity` output committed alongside the yaml
9. `pnpm run verify-translation-pairing` on every README pair this PR touches

Worktree install: this worktree currently has no `node_modules`. After the lockfile change, `pnpm install --frozen-lockfile` **inside the worktree**. Confirm `@deepseek-ai/dsh-web` resolves (the `.claude/worktrees/deepseek-harness` symlink already exists). Run vitest via `node_modules/.bin/vitest run`, not `pnpm run`, if pnpm tries to manage the main checkout.

Manual (after merge, real session):

1. No allow rule, fetch `https://example.com` → approval → Once → model sees markdown.
2. Always → second fetch same host does not ask; different host asks again.
3. `prompt` without haiku → tool error; with haiku → extraction.
4. `http://127.0.0.1:1/` → blocked even after Always.

Do not boot a full agent-loop to prove registration; fake `ctx.web.fetch` / `ctx.llm.stream` remains the unit seam. Slice B's local http server is the executor proof.

## PR

One PR, four slices in one branch (`worktree-webfetch`). Title/body in English.

Suggested title: `feat(web-fetch): mount SSRF-gated HTTP provider and honor WebFetch(domain:)`

Body must name: wrapper (not harness fork), literal-not-DNS SSRF residual, prompt hard-fail, domain matcher, Tavily non-goal.

Commit message (if squashed): same; observable behavior: CC CLI `web_fetch` reaches the network for public http(s), domain permission rules match hostnames, private literals are blocked, `prompt` without haiku is an error.

## Residuals (document, do not "fix" in this PR)

| Residual | Where it lives |
|---|---|
| DNS rebinding | upstream `webfetch-ssrf-allowlist`; wrapper README Known limits |
| No JS rendering | Tavily plugin/skill; not core |
| No cookies | login pages come back as HTML; model should switch MCP |
| Prompt hard-fail | sessions without haiku can still fetch; they cannot summarize |
| Wrapper does not see inner hops | same-origin ⇒ hostname unchanged; rebinding still residual |
| Loopback test servers | tests set `blockPrivateNetwork: false`; production default on |
| cc-shell mounts the provider for every preset using that bundle | intended; the gate still applies if some other preset enables stock `web_fetch` |
)