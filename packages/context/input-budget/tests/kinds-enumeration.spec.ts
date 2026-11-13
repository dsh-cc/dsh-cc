/**
 * Startup kind enumeration (plan doc §"Classes (explicit membership only)",
 * §73): a REPO SCAN of every kind declared in a `MessageSourceMap` augmentation
 * across the dsh-cc packages **and** the pinned harness checkout, asserted
 * against the class map.
 *
 * The scan reads the augmentations themselves — not a doc table — so a new
 * producer kind cannot land without a decision. Two properties are pinned:
 *
 * - every kind a dsh-cc package declares is EXPLICITLY listed in the class map
 *   (the closed membership of the design table);
 * - every harness kind not explicitly listed resolves to `passthrough`, i.e. is
 *   never trimmed and never deferred. A harness kind the map does list keeps its
 *   listed class (the design names `agent-instructions`,
 *   `hooks-claude-code`, `compact-checkpoint` as governance and
 *   `subagent-settled` as task).
 *
 * A missing harness checkout is a HARD FAILURE (upstream-drift precedent): the
 * enumeration must never read as "no harness kinds exist".
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KIND_CLASSES, classifyKind, type InputClass } from '../src/index.ts'

/** The dsh-cc repo root (this spec lives at packages/context/input-budget/tests). */
const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

/** Directories whose `.ts` files never carry a source-kind augmentation. */
const SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', 'tests', 'fixtures'])

/** Marker file that proves a directory is the harness checkout. */
const HARNESS_MARKER = join('packages', 'llm', 'llm', 'src', 'message.ts')

/**
 * The sibling `deepseek-harness` checkout (upstream-drift `findHarnessRoot`
 * idiom): walk up from the repo root, preferring the canonical side-by-side
 * checkout over a `.claude` worktree copy.
 */
function findHarnessRoot(): string {
  const candidates: string[] = []
  let dir = REPO_ROOT
  for (;;) {
    const candidate = join(dir, 'deepseek-harness')
    if (existsSync(join(candidate, HARNESS_MARKER))) {
      if (!candidate.includes('.claude')) return candidate
      candidates.push(candidate)
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const found = candidates[0]
  if (found === undefined) {
    throw new Error(
      'input-budget kind enumeration: no sibling deepseek-harness checkout found next to or above this repository — '
      + 'the guard hard-fails when the checkout is missing, because a missing checkout must never read as "no harness kinds"',
    )
  }
  return found
}

/** Every `.ts` file under `dir`, skipping the directories that cannot declare kinds. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      out.push(...sourceFiles(join(dir, entry.name)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

/**
 * The kinds declared by every `MessageSourceMap` augmentation in one file.
 *
 * Both declaration spellings count, because producers use both: an inline
 * `kind: '<literal>'` in the value type, and a quoted property key whose value
 * type is declared elsewhere (`'skill-invocation': SkillInvocationSource`).
 */
export function kindsInSource(text: string): string[] {
  const kinds: string[] = []
  const opener = /interface\s+MessageSourceMap\s*\{/g
  for (let match = opener.exec(text); match !== null; match = opener.exec(text)) {
    // Balance braces from the opening one: the body may nest object literals.
    let depth = 1
    let index = opener.lastIndex
    while (index < text.length && depth > 0) {
      if (text[index] === '{') depth += 1
      else if (text[index] === '}') depth -= 1
      index += 1
    }
    const body = text.slice(opener.lastIndex, index - 1)
    for (const inline of body.matchAll(/kind:\s*'([^']+)'/g)) {
      const kind = inline[1]
      if (kind !== undefined) kinds.push(kind)
    }
    for (const key of body.matchAll(/^\s*'([^']+)'\s*:/gm)) {
      const kind = key[1]
      if (kind !== undefined) kinds.push(kind)
    }
  }
  return kinds
}

/**
 * Every kind declared under one directory tree, with the declaring file
 * relative to `base` (default: the scanned root).
 */
function scanKinds(root: string, base: string = root): Map<string, string> {
  const found = new Map<string, string>()
  for (const file of sourceFiles(root)) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!text.includes('MessageSourceMap')) continue
    for (const kind of kindsInSource(text)) {
      if (!found.has(kind)) found.set(kind, file.slice(base.length + 1))
    }
  }
  return found
}

/** The dsh-cc packages' declaration sites (`packages/<group>/<pkg>/src`). */
function scanRepoSources(): Map<string, string> {
  const found = new Map<string, string>()
  for (const group of readdirSync(join(REPO_ROOT, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const pkg of readdirSync(join(REPO_ROOT, 'packages', group.name), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const src = join(REPO_ROOT, 'packages', group.name, pkg.name, 'src')
      for (const [kind, where] of scanKinds(src)) {
        if (!found.has(kind)) found.set(kind, `packages/${group.name}/${pkg.name}/src/${where}`)
      }
    }
  }
  return found
}

const harnessRoot = findHarnessRoot()
const repoKinds = scanRepoSources()
const harnessKinds = scanKinds(join(harnessRoot, 'packages'), harnessRoot)

/** Harness kinds the design names, with the class each must resolve to. */
const NAMED_HARNESS_KINDS: Record<string, InputClass> = {
  'agent-instructions': 'governance',
  'hooks-claude-code': 'governance',
  'compact-checkpoint': 'governance',
  'subagent-settled': 'task',
  user: 'task',
  'plan-mode': 'passthrough',
  'runtime-context': 'passthrough',
  'skill-invocation': 'passthrough',
  'system-prompt': 'passthrough',
}

describe('startup kind enumeration — the repo scan itself', () => {
  it('finds declaration sites in both trees (the guard is not vacuous)', () => {
    expect(repoKinds.size).toBeGreaterThan(15)
    expect(harnessKinds.size).toBeGreaterThan(15)
    for (const kind of ['cc-shell-glue', 'memory', 'turn-rules', 'moa-escalation', 'progress-rebuild']) {
      expect(repoKinds.has(kind), kind).toBe(true)
    }
    for (const kind of ['plan-mode', 'skill-invocation', 'runtime-context', 'system-prompt']) {
      expect(harnessKinds.has(kind), kind).toBe(true)
    }
  })
})

describe('startup kind enumeration — dsh-cc packages', () => {
  it('classifies every declared kind explicitly (no producer falls through to passthrough)', () => {
    const unlisted: string[] = []
    for (const [kind, where] of repoKinds) {
      const cls = KIND_CLASSES[kind]
      if (cls === undefined) {
        unlisted.push(`${kind} (${where})`)
        continue
      }
      expect(classifyKind(kind), kind).toBe(cls)
    }
    expect(unlisted, 'dsh-cc kinds missing an explicit class').toEqual([])
  })

  it('keeps the two trimming classes closed to the audited producers', () => {
    // Only memory and advisory content may ever be trimmed or deferred; every
    // other declared dsh-cc kind is counted and left alone.
    const trimmable = [...repoKinds.keys()].filter(kind => classifyKind(kind) === 'memory' || classifyKind(kind) === 'advisory')
    expect(trimmable.sort()).toEqual([
      'advisor',
      'compaction-cost-gate',
      'compaction-micro',
      'memory',
      'retry-attendant',
    ])
  })
})

describe('startup kind enumeration — pinned harness kinds', () => {
  it('resolves each design-named harness kind to its pinned class', () => {
    for (const [kind, expected] of Object.entries(NAMED_HARNESS_KINDS)) {
      expect(harnessKinds.has(kind), `${kind} missing from the harness scan`).toBe(true)
      expect(classifyKind(kind), kind).toBe(expected)
    }
  })

  it('classes every remaining harness kind as passthrough (never trimmed, never deferred)', () => {
    const listed: string[] = []
    for (const [kind, where] of harnessKinds) {
      const cls = classifyKind(kind)
      expect(['governance', 'task', 'memory', 'advisory', 'passthrough'], kind).toContain(cls)
      // The declaring file is a real scanned path, not a synthesized string.
      expect(existsSync(join(harnessRoot, where)), where).toBe(true)
      if (KIND_CLASSES[kind] !== undefined) {
        listed.push(`${kind} → ${cls}`)
        continue
      }
      // Unlisted harness kinds must never land in a trimming class.
      expect(cls, kind).toBe('passthrough')
    }
    // The explicitly listed harness kinds are exactly the kinds the design names.
    expect(listed.sort()).toEqual([
      'agent-instructions → governance',
      'compact-checkpoint → governance',
      'hooks-claude-code → governance',
      'plan-mode → passthrough',
      'runtime-context → passthrough',
      'skill-invocation → passthrough',
      'subagent-settled → task',
      'system-prompt → passthrough',
      'tool-registry → passthrough',
      'user → task',
    ])
  })
})
