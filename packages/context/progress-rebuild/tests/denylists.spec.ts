/**
 * Denylist lockstep (design §5 item 4): the three independently maintained
 * injected-source denylists must each carry the `progress-rebuild` kind, or
 * a self-feeding phantom loop re-opens (the KNOW-YOUR-INJECTOR rule,
 * advisor-watchdog delta.ts comment). #216 shipped the three denylist rows
 * without the membership regression test its own §5 item 4 requires; this
 * file closes that gap (ported from the #211 branch's denylists.spec.ts).
 *
 * The imports are cross-package RELATIVE specifiers on purpose: the three
 * lists live in packages that expose no subpath face for them, and
 * check-spec-deps deliberately skips relative specifiers (no devDependency
 * needed).
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { INJECTED_SOURCE_DENYLIST as MEMORY_DENYLIST } from '../../../memory/memory/src/recall.ts'
import { INJECTED_SOURCE_DENYLIST as TURN_RULES_DENYLIST } from '../../../interaction/turn-rules/src/matcher.ts'
import { INJECTED_SOURCE_DENYLIST as ADVISOR_DENYLIST } from '../../../interaction/advisor-watchdog/src/delta.ts'

describe('injected-source denylists carry progress-rebuild (§5 item 4)', () => {
  it('memory recall.ts', () => {
    expect(MEMORY_DENYLIST).toContain('progress-rebuild')
  })

  it('turn-rules matcher.ts', () => {
    expect(TURN_RULES_DENYLIST).toContain('progress-rebuild')
  })

  it('advisor-watchdog delta.ts', () => {
    expect(ADVISOR_DENYLIST).toContain('progress-rebuild')
  })
})
