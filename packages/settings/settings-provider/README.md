# @dsh-cc/settings-provider

Vendored settings-provider contract for `ctx.settings`: the harness
`@deepseek-ai/dsh-settings` seam as of pin `1ef9c1fa9a` (0.1.5-rc.1),
transplanted verbatim so dsh-cc's Claude Code settings.json cascade stays
decoupled from the rc.2 profile-patch settings model (migration plan Q3,
Option A).

Exports the `SettingsProvider` base class (namespace registration, layering,
validation, serialized writes, the `settings/updated` commit event, watcher
machinery), `SettingsConflictError`, `parseSettingsNamespace`, and the
redaction helpers.

One deliberate addition: a **no-op `configure({ auto }, fiber)` facade**,
signature-compatible with the rc.2 `SettingsForms.configure` call shape used
by the harness base rows (`agent-default-model`, `permission-presets`,
`agent-preset-registry`). dsh-cc settings are the CC JSON cascade, not
profile-patch forms, so a presentation policy has nothing to attach to; the
facade accepts and ignores the policy, returns a disposer, and logs once at
debug.

A second deliberate hardening: `register()` validates that the schema is
callable up front and fails with a readable error, instead of surfacing
"schema is not a function" from deep inside `resolveValue` — duck-typed
impostor schemas once reached this seam through bridged registrations
(bridged namespaces register with the permissive `AnySchema` from
`@dsh-cc/settings-ns`).

Library package: no preset row, no capability-manifest entry. Consumed by
`@dsh-cc/settings-cascade` (extends the base) and by settings-namespace
consumers that re-type against this contract.
