/**
 * cc-shell bundle smoke for the settings-migrations row: mounting the plugin
 * against a temporary harness home runs pending registered migrations at startup
 * (CC's runMigrations behavior), writing the migrated settings.json and advancing
 * the harness migration-state file. The migration registry is seeded with a dummy
 * migration because this batch ships no real migrations.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as SettingsMigrations from '@dsh-cc/settings-migrations'

describe('cc-shell bundle — settings-migrations row', () => {
  it('runs a registered migration on mount against a temp home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-shell-migrations-'))
    try {
      const settingsPath = join(home, 'settings.json')
      writeFileSync(settingsPath, JSON.stringify({ legacyFormat: { theme: 'dark' } }))

      // Seed the registry with a dummy migration for this smoke run.
      SettingsMigrations.defineMigration({
        version: 100,
        name: 'bundle-smoke',
        migrate: (ctx) => {
          ctx.settings.migrated = true
          delete ctx.settings.legacyFormat
        },
      })

      const ctx = new Context()
      const fiber = ctx.plugin(SettingsMigrations, { dshHome: home })
      await fiber
      await ctx.fiber.dispose()

      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ migrated: true })
      await expect(SettingsMigrations.readMigrationState(join(home, 'migrations.json')))
        .resolves.toEqual({ migrationVersion: 100 })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
