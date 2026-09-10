# @dsh-cc/cache-health

English | [中文](README.zh.md)

Passive prompt-cache prefix-stability observer with the `/cache-health` slash command. A `llm/stream` waterfall listener tracks which part of each outbound model request's prefix (system → tools → messages, in order) is volatile across calls within a session; the command joins the observation ledger with provider-metered cache usage (`cacheReadTokens` / `cacheWriteTokens`) from session events. Detector-only: it reports, never rewrites — no request rewriting, no provider-call changes, no harness changes.

## Command contract

| Input | Result |
|---|---|
| `/cache-health` | Show the current stable prefix (segment count, estimated tokens, changed-since-last-call flag), the drift table (only rows whose prefix changed, with redacted excerpts), per-call and session-total cache read/write token ratios, front-loaded suspects (drift at segment ≤ 2: system / tools / first message — where cwd and `DSH_SESSION_*` volatility lives), and tail appends listed explicitly as NOT suspects. |

Cache metering numbers are provider-metered; zero-metered upstreams produce zeros, not evidence of misses.

## Ledger

One JSONL row per model call at `<dshHome>/cache-health/<projectKey>/<sessionId>.jsonl`, where `projectKey` is a short hash of the session cwd (the context-crusher idiom). Rows carry `{ts, seq, provider, model, stableSegments, stablePrefixTokensEst, prefixChanged, driftSegmentIndex?, driftExcerpt?, callPurpose?}`. Appends are fire-and-forget — observation never adds latency to model calls. The file is capped at 2000 rows (oldest trimmed on overflow).

Rows reflect the raw pre-middleware view of `llm/stream` options, not a wire-faithful rendering: a future middleware rewriting options in `llm/stream` would make this ledger under-report churn. Excerpts are whitespace-collapsed, redacted (`sk-…` keys, `Bearer` tokens, opaque runs ≥ 32 chars), and truncated to 80 characters. `stablePrefixTokensEst` (canonical length / 4) is an estimate, not a token count.

## Configuration

```yaml
- id: cache-health
  name: '@dsh-cc/cache-health'
  config:
    enabled: true   # default; set false to disable the listener and the command
```

## Composition

The CC preset (`@dsh-cc/preset-cc`) mounts the plugin as a slash-command row (`cache-health` in its `agent.cordis.yml`). The plugin declares `inject = ['commands', 'sessions']` and reads `dshHomePath` defensively; a host without `dshHomePath` force-disables the observer.
