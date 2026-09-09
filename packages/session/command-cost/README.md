# @dsh-cc/command-cost

English | [中文](README.zh.md)

Human-facing `/cost` command over the session usage log. The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md), so every composed command adapter discovers and executes it without a model turn. It folds each logged `assistant/message` usage record against the latest `request/header` model route and the deployment price table from Config.

## Command contract

| Input | Result |
|---|---|
| `/cost` | Show per-model token usage (uncached input, cache-read input, cache-write input, output) and the estimated USD cost for the whole session, plus a grand total. A model without a matching price column reports its usage with an explicit "no price configured" marker instead of a zero cost. A session with no recorded usage says so directly. |

Usage is always reported when a usage record logged; cost is only estimated when the deployment configures a price for the model. No model call is made and no token is consumed to answer.

## Configuration

All prices live in the plugin `Config` in your `cordis.yml`; nothing is hardcoded in the plugin. Prices are USD per one million tokens. Columns match in three tiers: an exact model id first (first row wins), then a `/`-suffix match for route-prefixed runtime ids (longest row wins; equal length → first row), then a `'*'` wildcard column.

The CC preset (`@dsh-cc/preset-cc`) ships a starter table of official published list prices for common DeepSeek, GLM, and Kimi models, collected from the vendor pricing pages (see the `command-cost` row in its `agent.cordis.yml` for the collection date and sources). Deployment billing often differs from list prices — override the whole `modelTable` when yours does. The starter table deliberately carries no `'*'` wildcard column: unmatched models report usage with a "no price configured" marker instead of a misleading zero cost.

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

Without a `modelTable`, every model is reported as unpriced — token usage still shows, but no cost estimate does. With the CC preset's starter table, models it covers are priced at official list prices; anything else stays unpriced.

## Model Experience

The slash input and the direct token/cost output are absent from model requests and consume no model tokens. The fold reads the session's durable log; presentation text is never logged.

## Known Limitations and Deferred Work

- **Pricing tiers** — matching is exact first (first row wins), then a route-prefix tail-segment match (longest row wins; equal length → first row), then the `'*'` wildcard. A provider-less row prices every provider's prefixed variant of that model (e.g. `glm-5.3` prices both `llmbox_ant/glm-5.3` and `routeX/glm-5.3`); deployments that need provider isolation must set `provider` on the row.
- **Starter prices are list prices, not your bill** — the preset table reflects official published prices at collection time and goes stale as vendors adjust; deployments with negotiated or internal-gateway pricing must override it.
- **No live totals during a turn** — `/cost` reports the durable log up to the last checkpoint; in-flight usage is not included.
