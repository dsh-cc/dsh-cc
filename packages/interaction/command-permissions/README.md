# @dsh-cc/command-permissions

English | [中文](README.zh.md)

Human-facing `/permissions` slash command for CC rule-engine permission modes: show the effective permission-rule state, or switch the session's permission mode with `/permissions <mode>`. Ships a small browser bundle that hangs a `popupSelect` decoration (and a TUI overlay) on the bare invocation, so mode switching has a picker on every surface — all writing through the one host command.

## Usage

```ts
import { apply } from '@dsh-cc/command-permissions'

apply(ctx) // host plane: registers /permissions and the CC catalog wrap
```

```ts
import { apply as applyClient } from '@dsh-cc/command-permissions/client'

applyClient(ctx) // browser bundle: bare-invocation popupSelect decoration
```

## What it provides

- `/permissions` — with no arguments, renders a read-only report of rule counts per source (`allow`/`deny`/`ask`) plus a total; reports a friendly message when the permission-rules engine is not mounted.
- `/permissions <mode>` — durable mode switch through the engine's `setMode`: `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`. Switching to `plan` dispatches `/plan` (plan-mode's command channel is the only cross-plane seam); switching away from an active plan first dispatches `/plan off`.
- The browser client (`./client` export, bundled by `tsdown` as a ModuleLoader factory) decorates the bare `/permissions` invocation with a mode picker built from the shared `PERMISSION_MODE_OPTIONS`; a pick submits `/permissions <id>`, so the popup and the argued path share one write path. The `bypassPermissions` row carries an explicit risk confirmation.
- The shared mode list, labels, and bypass confirmation text live in `src/modes.ts`, read by the host command, the popup, and the TUI overlay so they cannot drift.

## Notes

- The package is mounted twice: a host-plane row (which wraps `commands.list` so CC sessions hide the host `/permission` row, and non-CC sessions hide `/permissions`) and the CC preset row that registers the command. The host-plane `dsh.client` field lets `dsh-client-modules` discover the browser half.
- Injects only `commands`; the `permissionRules` engine is read optionally via `ctx.get`, so the command loads and reports a friendly message even when the engine is absent.
- Wraps the command with `@dsh-cc/command-usage` (mode ids appear as help subcommands) so `help`/`-h`/`--help` render deterministic help.
