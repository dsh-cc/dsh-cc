/**
 * Claim matcher pins (plan docs/plans/2026-10-09-runtime-verified-completion.md
 * §5.3): matcher-level — claims table fed receipts directly, no transcript.
 * All §5.3 pins, per row, per segment, case-insensitivity included.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { loadClaims, matchPhrases, receiptSatisfies, segmentHead } from '../src/claims.ts'

const claims = loadClaims()
const byId = new Map(claims.map(claim => [claim.id, claim]))

function phrase(text: string): string[] {
  return matchPhrases(claims, text).map(claim => claim.id)
}

function receipt(tool: string, head?: string): { tool: string; head?: string } {
  return { tool, head }
}

function satisfies(id: string, tool: string, head?: string): boolean {
  const claim = byId.get(id)
  expect(claim, `row ${id} must be loaded`).toBeDefined()
  return receiptSatisfies(claim!, receipt(tool, head))
}

describe('claim table load rules (§3.3)', () => {
  it('headless rows are skipped (vague-done never flags)', () => {
    expect(byId.has('vague-done')).toBe(false)
    expect(phrase('it is done, fixed, resolved')).toEqual([])
  })

  it('all compiled regexes are case-insensitive', () => {
    for (const claim of claims) {
      expect(claim.phrase.flags).toContain('i')
      expect(claim.head.flags).toContain('i')
      if (claim.headDeny) expect(claim.headDeny.flags).toContain('i')
    }
  })
})

describe('tests-green row (§5.3)', () => {
  it('future/conditional tense does NOT match', () => {
    expect(phrase('tests will pass')).not.toContain('tests-green')
    expect(phrase('tests should pass')).not.toContain('tests-green')
  })
  it('executed forms match, case-insensitively', () => {
    expect(phrase('tests passed')).toContain('tests-green')
    expect(phrase('TESTS PASSED.')).toContain('tests-green')
    expect(phrase('test passes')).toContain('tests-green')
  })
  it('head pins per segment: git checkout does not satisfy the check token', () => {
    expect(receiptSatisfies(byId.get('tests-green')!, receipt('bash', 'git checkout main'))).toBe(false)
    expect(satisfies('tests-green', 'bash', 'pnpm test')).toBe(true)
    expect(satisfies('tests-green', 'bash', './node_modules/.bin/vitest run x')).toBe(true)
    expect(satisfies('tests-green', 'edit', 'pnpm test')).toBe(false)
    expect(satisfies('tests-green', 'bash', 'pnpm tests')).toBe(false)
  })
})

describe('commit row (§5.3)', () => {
  it('"uncommitted" does not trip the row', () => {
    expect(phrase('the tree is uncommitted')).not.toContain('commit')
  })
  it('segmentation and -C/-c forms', () => {
    expect(satisfies('commit', 'bash', 'cd pkg && git commit -m x')).toBe(true)
    expect(satisfies('commit', 'bash', 'git -C pkg commit -m x')).toBe(true)
    expect(satisfies('commit', 'bash', 'git -c user.email=a@b commit -m x')).toBe(true)
    expect(satisfies('commit', 'bash', 'git push')).toBe(false)
  })
  it('single-verb wrapper without separator does NOT match (false-nudge corner)', () => {
    expect(satisfies('commit', 'bash', "sh -c 'git commit -m x'")).toBe(false)
  })
  it('splinter corner: quoted compound DOES match (suppression class)', () => {
    expect(satisfies('commit', 'bash', "sh -c 'cd pkg && git commit -m x'")).toBe(true)
  })
})

describe('push/pr row', () => {
  it('matches git push and gh pr create', () => {
    expect(satisfies('push-pr', 'bash', 'git push origin main')).toBe(true)
    expect(satisfies('push-pr', 'bash', 'git -C pkg push origin main')).toBe(true)
    expect(satisfies('push-pr', 'bash', 'gh pr create --title x')).toBe(true)
    expect(satisfies('push-pr', 'bash', 'git pull')).toBe(false)
  })
})

describe('build row (§5.3)', () => {
  it('docker/podman build excluded by headDeny per segment', () => {
    expect(satisfies('build', 'bash', 'docker build -t x .')).toBe(false)
    expect(satisfies('build', 'bash', 'podman build -t x .')).toBe(false)
  })
  it('sudo docker build satisfies (suppression corner, accepted §3.3)', () => {
    expect(satisfies('build', 'bash', 'sudo docker build -t x .')).toBe(true)
  })
  it('npm run build satisfies', () => {
    expect(satisfies('build', 'bash', 'npm run build')).toBe(true)
    expect(satisfies('build', 'bash', 'npx tsc --noEmit')).toBe(true)
  })
  it('watch forms do NOT satisfy', () => {
    expect(satisfies('build', 'bash', 'npm run build --watch')).toBe(false)
    expect(satisfies('build', 'bash', 'npm run build -w')).toBe(false)
    expect(satisfies('build', 'bash', 'npm run build:watch')).toBe(false)
    expect(satisfies('build', 'bash', 'tsc --watch')).toBe(false)
  })
  it('rebuild fails the word boundary', () => {
    expect(satisfies('build', 'bash', 'pnpm rebuild')).toBe(false)
  })
})

describe('segmentation primitive', () => {
  it('splits once on two-char forms before bare pipe', () => {
    expect(segmentHead('a && b || c; d | e')).toEqual(['a ', ' b ', ' c', ' d ', ' e'])
  })
})
