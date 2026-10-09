/**
 * Denylist lockstep (spec slice 2 / design §3.3 step 3): the three
 * independent injected-source denylists must each contain the
 * `progress-rebuild` kind, or a self-feeding phantom loop re-opens. Pinning
 * membership by test is the KNOW-YOUR-INJECTOR rule (advisor-watchdog
 * delta.ts comment).
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { INJECTED_SOURCE_DENYLIST as MEMORY_DENYLIST } from '@dsh-cc/memory/src/recall.ts'
import { INJECTED_SOURCE_DENYLIST as TURN_RULES_DENYLIST } from '@dsh-cc/turn-rules/src/matcher.ts'
import { INJECTED_SOURCE_DENYLIST as ADVISOR_DENYLIST } from '@dsh-cc/advisor-watchdog/src/delta.ts'

describe('injected-source denylists carry progress-rebuild', () => {
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
