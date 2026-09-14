#!/usr/bin/env node
/**
 * Copy packages/preset/cc/{agent.cordis.yml,preset.yml} into this package's
 * presets/cc so the published tarball can materialize the user-root preset.
 */
import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const repoPreset = join(pkgRoot, '..', '..', 'preset', 'cc')
const dest = join(pkgRoot, 'presets', 'cc')

if (!existsSync(join(repoPreset, 'agent.cordis.yml'))) {
  console.error(`stage-preset: missing ${join(repoPreset, 'agent.cordis.yml')}`)
  process.exit(1)
}

mkdirSync(dest, { recursive: true })
cpSync(join(repoPreset, 'agent.cordis.yml'), join(dest, 'agent.cordis.yml'))
cpSync(join(repoPreset, 'preset.yml'), join(dest, 'preset.yml'))
// The revision must track this package's version: ensurePackagedPreset
// compares it to decide whether the materialized preset copy in
// $DSH_HOME/.agent-presets/cc is stale. A hardcoded value keeps the copy
// "current" forever and the preset never refreshes across releases.
const version = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version
writeFileSync(
  join(dest, '.dsh-cc-managed.json'),
  `${JSON.stringify({ owner: '@dsh-cc/tui', preset: 'cc', revision: version }, null, 2)}\n`,
)
