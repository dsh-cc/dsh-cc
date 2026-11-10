/**
 * Denylist membership pin (plan docs/plans/2026-10-09-runtime-verified-completion.md
 * §5.5): the completion-gate injected source kind must be added to ALL
 * THREE copies of the INJECTED_SOURCE_DENYLIST (memory recall — in
 * recall-query.ts since the S1-03 coordinator split,
 * turn-rules/matcher.ts, advisor-watchdog/delta.ts) — the copies are
 * deliberately not shared, so a text-level pin is the guard. KNOW YOUR
 * INJECTOR. Since the issue #359 fix, memory recall's list is a non-operative
 * inventory (its genuine test is the structural allowlist in
 * recall-query.ts); the operative filters are the turn-rules and
 * advisor-watchdog copies.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..', '..', '..')

const denylistSources = [
  join(ROOT, 'packages', 'memory', 'memory', 'src', 'recall-query.ts'),
  join(ROOT, 'packages', 'interaction', 'turn-rules', 'src', 'matcher.ts'),
  join(ROOT, 'packages', 'interaction', 'advisor-watchdog', 'src', 'delta.ts'),
]

describe('injected-source denylist membership', () => {
  for (const file of denylistSources) {
    it(`includes 'completion-gate' in ${file.split('/').slice(-3).join('/')}`, () => {
      const text = readFileSync(file, 'utf8')
      expect(text).toContain("'completion-gate'")
    })
  }
})
