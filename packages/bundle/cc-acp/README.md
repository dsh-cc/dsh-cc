# @dsh-cc/bundle-acp

English | [中文](README.zh.md)

Agent Client Protocol (ACP) profile bundle for dsh, shipped as a single cordis bundle patch: it moves the host agent plane behind the CC preset (same disable roster as the TUI bundle), inserts the cc preset roster, mounts the `@dsh-cc/acp` protocol driver, and swaps out the harness's stock `acp` plugin.

## Usage

The package has no importable API. It is consumed as a bundle patch via its `./cordis.patch.yml` export — normally through the `dsh-cc acp` launcher subcommand, which installs it into the `cc-acp` profile:

```yaml
bundle:
  patch: '@dsh-cc/bundle-acp/cordis.patch.yml'
```

## What it provides

In registration order:

- Host-plane disable roster — the agent-plane rows the host ships by default (tool-bash, tool-fs, tool-web, subagent tools, workflow rows, …) are disabled by ID so the CC preset owns the tool plane. `hmr` is intentionally absent: the retained `@deepseek-ai/dsh-acp-app` bundle already disables it under an active profile.
- Preset roster — `agent-preset-registry` (default `cc`) plus `preset-cc`, whose `cc-composition` include row mounts `@dsh-cc/preset-cc/agent.cordis.yml` from the profile's node_modules.
- `acp-cc` — the `@dsh-cc/acp` plugin with `inject: [acpAppStartup]` (the stdio latch that keeps the plugin from claiming stdout before startup arg parsing) and `presetId: 'cc'`; provider/model route overrides are optional.
- Swaps — the harness `acp` row is disabled (replaced by `acp-cc`; works because the dsh-acp-app bundle stays in the floor), and `session-title-llm-cc` is disabled so sessions pay no title-model calls.

## Notes

- Must NOT touch: `tools` (cc-shell remounts tools-cc), `settings`/`permission-rules` (cc-permissions), `user-questions`, HTTP/webserver rows.
- The `@deepseek-ai/dsh-agent-preset-registry`, `@deepseek-ai/dsh-agent-preset`, and `@deepseek-ai/cordis-plugin-include` rows resolve from this package's dependencies — a packed profile floor installs them with the bundle rather than relying on ambient resolution.
