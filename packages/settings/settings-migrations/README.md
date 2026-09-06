# @dsh-cc/settings-migrations

English | [中文](README.zh.md)

Claude Code-style settings migration mechanism for the DeepSeek Harness. A versioned `defineMigration` list is applied by `runMigrations()` against an atomically-written `settings.json`, mirroring CC's run-at-startup migrations. The bundled plugin auto-runs pending migrations on mount without ever taking down the host.

## Status: mechanism ready, no real migrations yet

This batch ships the machinery but **no concrete migrations** — neither cc nor dsh has a legacy settings format to migrate. The first real migration will land with the first settings-shape change (for example a renamed or removed key). Until then the registry is empty and mounting the plugin is a no-op.

## Mechanism

```ts
import { defineMigration, runMigrations, readMigrationState } from '@dsh-cc/settings-migrations'

defineMigration({
  version: 1,
  name: 'rename-field',
  migrate: (ctx) => {
    ctx.settings.theme = ctx.settings['ui-theme']   // mutate the raw settings doc
    delete ctx.settings['ui-theme']
  },
})

await runMigrations()   // applies every registered migration
```

- **`defineMigration({ version, name, migrate(ctx) })`** registers a migration into the module registry (deduplicated by `version` + `name`). `ctx.settings` is the mutable raw JSON document; a migration rewrites it in place.
- **`runMigrations(migrations?, options?)`** applies every migration whose `version` exceeds the recorded `migrationVersion`, in ascending version order. Pass an explicit list for tests/direct invocation, or omit it to use the registry. Options: `home` (harness home), `settingsPath`, `statePath`.
- **`readMigrationState(statePath)`** returns `{ migrationVersion }`, defaulting to `0` when the state file is absent.

## Version storage

The recorded version lives in a **dedicated state file** in the harness home (resolved via the harness home-paths tooling — `$DSH_HOME` or `~/.dsh`), defaulting to `<home>/migrations.json`; the settings document defaults to `<home>/settings.json`. The state shape is `{ "migrationVersion": N }`. Both locations are overridable per run / per plugin config for tests and constrained deployments.

## Semantics (the contract)

- **Ascending version order.** pending = migrations with `version > migrationVersion`, sorted low to high.
- **Whole-batch atomicity.** The batch succeeds only when every pending migration completes; the version then advances to the latest pending version. A single throw aborts the run: nothing is written and the version stays put, so the next run re-attempts the failing survivors.
- **Migrations must be idempotent.** Because a mid-batch failure leaves the version behind, earlier migrations in the batch may run again on the next attempt (and CC's startup runner re-runs the whole set). Write your migration so running it twice is harmless — CC's own migrations encode a self-guard on the source data for exactly this reason.
- **`guard` skips without blocking.** A `guard(ctx)` returning `false` skips that migration but still counts as success for version advancement (CC treats a skipped run as completing the set). A `guard` returning `true` runs the migration.
- **Atomic write path.** Settings and state are written via a sibling temp file then `rename`, so a reader never observes a partially-written document and no temp files are left behind.

## Plugin

`name`, `Config`, `apply(ctx, config)`:

```ts
await ctx.plugin(SettingsMigrations, { dshHome, autoRunOnMount: true })
```

| Config | Meaning | Default |
|---|---|---|
| `dshHome` | Harness home for the default paths | `$DSH_HOME` or `~/.dsh` |
| `settingsPath` | `settings.json` override | `<home>/settings.json` |
| `statePath` | migration state file override | `<home>/migrations.json` |
| `autoRunOnMount` | run pending migrations on mount | `true` |

Mounting runs pending registered migrations (equivalent to CC running migrations at startup). A failed batch never takes down the host: the error is logged as a warning and the recorded version is retained so the next mount re-attempts the survivors.

## Install / registration

```ts
import * as SettingsMigrations from '@dsh-cc/settings-migrations'
await ctx.plugin(SettingsMigrations)
```

## Build order

`settings-migrations` depends on the harness base packages (`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-home-paths`, `@deepseek-ai/dsh-invariants`) and no workspace package, so it builds as soon as those are available.

## Known limitations

- **Mechanism only.** No migrations ship yet; seeding them for local verification is the owner's call per environment.
- **Single settings document.** The runner targets the user `settings.json`; project/local/flag layers (see `settings-cascade`) are not yet migration targets.
- **Best-effort failure report.** The plugin warns and retains the version on failure; it does not surface a structured migration report to the seam.
