# @dsh-cc/bundle-permissions

English | [中文](README.zh.md)

Claude Code permission parity for dsh profiles, shipped as a single cordis bundle patch: it swaps the plain settings provider for the five-level settings cascade (settings.json precedence chain) and mounts the CC permission-rule engine that reads the merged `permissions` section from it.

## Usage

The package has no importable API. It is consumed as a bundle patch via its `./cordis.patch.yml` export:

```yaml
bundle:
  patch: '@dsh-cc/bundle-permissions/cordis.patch.yml'
```

## What it provides

The patch performs three mounts in registration order:

- `settings-cc` — the `@dsh-cc/settings-cascade` provider, honouring `$DSH_HOME/settings.json` and the project's `.claude` settings files. The in-box settings row is disabled by ID to prevent double-mounting.
- `permission-rules` — the `@dsh-cc/permission-rules` allow/deny/ask rule engine, reading the `permissions` settings namespace lazily at call time. Bypass-immune rules ride the monotonic guard layer.
- `command-permissions` — the host-plane mount of the `/permissions` command plus catalog wrap; the empty host fiber is what dsh-client-modules scans for the popupSelect browser half.

The CC preset keeps its own command-permissions row, so a composition without this bundle still registers the `/permissions` command.

## Notes

- The permission engine reads `ctx.settings` lazily at call time, so mount order does not affect correctness; the cascade is kept first only for readable boot logs.
