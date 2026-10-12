# @dsh-cc/command-preset

English | [中文](README.zh.md)

Human-facing `/preset` command for the agent-preset registry: list the deployment's roster, and switch the running session and/or the persisted default with `/preset <id>`. The plugin registers one global command through `ctx.commands`, so every composed command adapter discovers and executes it without a model turn.

## Command contract

| Input | Result |
|---|---|
| `/preset` | Print the roster as presentation text: each preset's id, name, order, description, and availability; the current default is marked. |
| `/preset <id>` | Switch transaction (pinned order): validate the id against the roster; try hot-activating the zero-turn session via the registry's `select`; write `vwa-preset.selectedDefault` through the settings provider; only after a successful action branch, inject a `command-preset`-sourced announcement to the model. |
| `/preset help` | Render the command help with its argument hint. |

### Partial-success tri-state

- Full success: the session switched and the default was written.
- Locked downgrade: the session has already started (`agent-preset/locked`), so only the default changes — this is not an error.
- Settings write failed: the hot switch (if any) stands, but hot activation of new sessions is NOT achieved; the result text names the failure and the manual fallback (`vwa-preset.selectedDefault` in your user settings).

## Settings namespace

`vwa-preset` with the single key `selectedDefault` (absent ⇒ the deployment default, `cc`). The namespace is registered at mount through the shared `registerNamespaceSafe` helper; the settings-provider `update` semantics perform the write.

## Wiring

The agent-preset registry is read at apply time via `ctx.get('agentPresets')` with a loud throw when absent — deliberately not an `inject` declaration, which would re-compose the registry inside the preset scope (cordis trap). The command row is mounted by both `packages/preset/cc/agent.cordis.yml` and `agent.vwa.cordis.yml`.
