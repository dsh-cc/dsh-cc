# @dsh-cc/command-cost

English | [中文](README.zh.md)

Human-facing `/cost` command over the session usage log. The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md), so every composed command adapter discovers and executes it without a model turn. It folds each logged `assistant/message` usage record against the latest `request/header` model route and the deployment price table from Config.

## Command contract

| Input | Result |
|---|---|
| `/cost` | Show per-model token usage (uncached input, cache-read input, cache-write input, output) and the estimated USD cost for the whole session, plus a grand total. A model without a matching price column reports its usage with an explicit "no price configured" marker instead of a zero cost. A session with no recorded usage says so directly. |

Usage is always reported when a usage record logged; cost is only estimated when the deployment configures a price for the model. No model call is made and no token is consumed to answer.

## Configuration

All prices live in the plugin `Config` in your `cordis.yml`; nothing is hardcoded in the plugin. Prices are USD per one million tokens. A column whose `model` is `'*'` is the wildcard default applied to any model without an exact column.

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

Without a `modelTable`, every model is reported as unpriced — token usage still shows, but no cost estimate does.

## Model Experience

The slash input and the direct token/cost output are absent from model requests and consume no model tokens. The fold reads the session's durable log; presentation text is never logged.

## Known Limitations and Deferred Work

- **Exact-match pricing only** — a `'*'` wildcard column covers unmatched models; more flexible per-prefix pricing is deferred.
- **No live totals during a turn** — `/cost` reports the durable log up to the last checkpoint; in-flight usage is not included.
