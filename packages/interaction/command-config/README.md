# @dsh-cc/command-config

English | [中文](README.zh.md)

Human-facing `/config` slash command for the settings service: render the effective configuration namespaces, or write an allowlisted key/value into a namespace scope. Invalid keys or scopes produce a friendly message, never a thrown error.

## Usage

```ts
import { apply } from '@dsh-cc/command-config'

apply(ctx, {
  defaultScope: 'ui-theme',
  allowlist: ['ui-theme.theme', 'ui-theme.fontSize'],
})
```

## What it provides

- `/config` — with no arguments, lists every registered settings namespace as `namespace = value (applies)`.
- `/config [key] [value] [scope]` — parses the update, defaults the scope to `defaultScope` (default `ui-theme`), parses the value as JSON when it looks structured (else a string), and writes it through the settings service.
- Writes are gated by a restricted allowlist of `namespace` or `namespace.key` entries; the default allowlist is `ui-theme.theme` and `ui-theme.fontSize`. Everything else is refused with a hint of the writable keys.

## Notes

- Injects the `commands` and `settings` services; wraps the command with `@dsh-cc/command-usage` so `help`/`-h`/`--help` render deterministic help.
- Errors from the settings update are reported as text, not thrown.
