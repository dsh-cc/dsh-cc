/**
 * Byte-shape ground-truth fixtures for the plugin manager, mirroring the real
 * Claude Code v2.1.236 state files (plan §2.2).
 *
 * @module @dsh-cc/plugin-manager/test-fixtures
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

export function fixturePath(name: string): string {
  return join(fixtureDir, name)
}

export function fixture(name: string): string {
  return readFileSync(fixturePath(name), 'utf8')
}

export function fixtureJson(name: string): unknown {
  return JSON.parse(fixture(name))
}
