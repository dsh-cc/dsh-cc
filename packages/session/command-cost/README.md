# @dsh-cc/command-cost

English | [中文](README.zh.md)

Human-facing `/cost` command over the session usage log. The plugin registers one global command through `ctx.commands`, so every composed command adapter discovers and executes it without a model turn. It folds each logged `assistant/message` usage record against the latest `request/header` model route and the deployment price table from Config, then, when the session has one, merges the SystemOne decision-usage ledger into a separate section.

## Command contract

| Input | Result |
|---|---|
| `/cost` | Show per-model token usage (uncached input, cache-read input, cache-write input, output) and the estimated USD cost for the whole session, plus a grand total. A model without a matching price column reports its usage with an explicit "no price configured" marker instead of a zero cost. When the session recorded SystemOne decisions, a `SystemOne decisions` section follows with per-model decision usage priced the same way. A session with no recorded usage says so directly. |

Usage is always reported when a usage record logged; cost is only estimated when the deployment configures a price for the model. No model call is made and no token is consumed to answer.

## SystemOne decisions

The decision runtime (`@dsh-cc/decision-usage`) writes one JSONL ledger per session under the harness home. `/cost` reads this session's ledger when it exists and appends a `SystemOne decisions` section; a session without a ledger (or a host without a harness-home resolver, or a session with no recorded working directory) simply shows no such section — the command never fails over it.

The section reports, per priced model:

- `Attempts` — attempt leases the ledger counts. A durably refunded (`not-dispatched`) attempt does not count.
- `Confirmed: N input + M output` — tokens of attempts that settled with their actual usage. Input and output are priced separately against the same `modelTable`, matched by the attempt's actual model (or its requested model while no response exists) plus provider.
- `Reserved upper bound, unconfirmed` — an unknown or still-unsettled attempt keeps its reservation on its own line. It is never part of the confirmed subtotal, because the provider never confirmed those tokens.
- `Confirmed cost: unpriced (no price column configured)` — a model with no configured price is reported as unpriced, never as `$0`.

The grand total is a single exact figure only when every bucket is priced, no reservation stayed unconfirmed and the ledger is complete. Otherwise the report prints the confirmed subtotal plus the reasons it cannot be exact — a torn ledger tail, corrupt lines, or a durably frozen session quota mark the section `Incomplete` — and never a fabricated total. Ledger rows are deduplicated by event id, so a replayed append is charged once.

## Configuration

All prices live in the plugin `Config` in your `cordis.yml`; nothing is hardcoded in the plugin. Prices are USD per one million tokens. Columns match in three tiers: an exact model id first (first row wins), then a `/`-suffix match for route-prefixed runtime ids (longest row wins; equal length → first row), then a `'*'` wildcard column.

The CC preset (`@dsh-cc/preset-cc`) ships a starter table of official published list prices for common DeepSeek, GLM, and Kimi models, collected from the vendor pricing pages (see the `command-cost` row in its `agent.cordis.yml` for the collection date and sources). Deployment billing often differs from list prices — override the whole `modelTable` when yours does. The starter table deliberately carries no `'*'` wildcard column: unmatched models report usage with a "no price configured" marker instead of a misleading zero cost.

The prices below are illustrative values, not a current vendor quote. Replace them with the prices for your deployment.

```yaml
- id: command-cost
  name: '@dsh-cc/command-cost'
  config:
    modelTable:
      - model: deepseek-chat
        provider: deepseek
        inputPerMTok: 0.27
        outputPerMTok: 1.10
        cacheReadPerMTok: 0.07
        cacheWritePerMTok: 0.07
      - model: '*'
        inputPerMTok: 0
        outputPerMTok: 0
        cacheReadPerMTok: 0
        cacheWritePerMTok: 0
```

## Composition

The producer injects `commands`. A custom app mounts their owners plus this plugin:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-cost
  name: '@dsh-cc/command-cost'
```

`modelTable` is required by the schema; an explicit empty table (`modelTable: []`) prices nothing and reports every model as unpriced — token usage still shows, but no cost estimate does. With the CC preset's starter table, models it covers are priced at official list prices; anything else stays unpriced.

## Model Experience

The slash input and the direct token/cost output are absent from model requests and consume no model tokens. The fold reads the session's durable log; presentation text is never logged.

## Known Limitations and Deferred Work

- **Pricing tiers** — matching is exact first (first row wins), then a route-prefix tail-segment match (longest row wins; equal length → first row), then the `'*'` wildcard. A provider-less row prices every provider's prefixed variant of that model (e.g. a row for `deepseek-chat` also matches `deepseek/deepseek-chat`); deployments that need provider isolation must set `provider` on the row.
- **Starter prices are list prices, not your bill** — the preset table reflects official published prices at collection time and goes stale as vendors adjust; deployments with negotiated or internal-gateway pricing must override it.
- **No live totals during a turn** — `/cost` reports the durable log up to the last checkpoint; in-flight usage is not included.
- **Decision ledger scope** — only the invoking session's decision ledger is read, and only the decision runtime writes it. Legacy permission and MOA SystemOne calls are not in the decision ledger and appear in neither section; no claim of a complete decision total is made for them.
