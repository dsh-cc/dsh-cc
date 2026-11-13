/**
 * Class map (plan §"Classes (explicit membership only)"): the exact table,
 * closed membership, and the two safety properties the inversion buys —
 * unknown kinds and `cc-shell-glue` are passthrough, so never trimmed and never
 * deferred. The repo-scan enumeration assert over every declared kind lives in
 * `kinds-enumeration.spec.ts`; here the map function itself is pinned.
 */

import { describe, expect, it } from 'vitest'
import {
  ADVISORY_KINDS,
  BUDGETED_CLASSES,
  GOVERNANCE_KINDS,
  INPUT_CLASSES,
  KIND_CLASSES,
  MEMORY_KINDS,
  PASSTHROUGH_KINDS,
  TASK_KINDS,
  classifyKind,
  isBudgeted,
  type InputClass,
} from '../src/index.ts'

/** The design table, transcribed kind by kind. */
const TABLE: Record<string, InputClass> = {
  // governance — never trim, never defer; counted
  'turn-rules': 'governance',
  'edit-recovery-hint': 'governance',
  'completion-gate': 'governance',
  'permission-rules': 'governance',
  'agent-instructions': 'governance',
  'hooks-claude-code': 'governance',
  'compact-checkpoint': 'governance',
  'moa-escalation': 'governance',
  // task — never trim, never defer; counted (lifecycle/delivery wakes)
  user: 'task',
  'progress-rebuild': 'task',
  moa: 'task',
  'subagent-settled': 'task',
  'cc-subagent-children': 'task',
  'vwa-evidence': 'task',
  'cc-workflow-completion': 'task',
  // memory — its own budget
  memory: 'memory',
  // advisory — trim/defer under the advisory budget
  advisor: 'advisory',
  'retry-attendant': 'advisory',
  'compaction-micro': 'advisory',
  'compaction-cost-gate': 'advisory',
  // passthrough — never trim, never defer; counted
  'cc-shell-glue': 'passthrough',
  'command-preset': 'passthrough',
  'side-query': 'passthrough',
  'tool-web-fetch': 'passthrough',
  'tool-registry': 'passthrough',
}

/** Harness-side kinds the design names explicitly as passthrough. */
const HARNESS_PASSTHROUGH = [
  'developer',
  'plan-mode',
  'runtime-context',
  'skill-invocation',
  'subagent-instructions',
  'system-prompt',
]

describe('class map', () => {
  it('classifies every kind named in the design table', () => {
    for (const [kind, expected] of Object.entries(TABLE)) {
      expect(classifyKind(kind), kind).toBe(expected)
    }
  })

  it('classifies the explicitly named harness kinds as passthrough', () => {
    for (const kind of HARNESS_PASSTHROUGH) {
      expect(classifyKind(kind), kind).toBe('passthrough')
    }
  })

  it('classifies unknown, empty and absent kinds as passthrough', () => {
    expect(classifyKind('some-future-producer')).toBe('passthrough')
    expect(classifyKind('')).toBe('passthrough')
    expect(classifyKind(undefined)).toBe('passthrough')
  })

  it('keeps cc-shell-glue in passthrough — the v1 hard rule', () => {
    // mcpReadyNotice commits its once-per-session latch before returning the
    // notice, so any enforced trim/defer of a glue notice is a silent miss.
    expect(classifyKind('cc-shell-glue')).toBe('passthrough')
  })

  it('resolves every kind in a per-class list to that class, with no kind in two lists', () => {
    const lists: readonly (readonly string[])[] = [
      GOVERNANCE_KINDS,
      TASK_KINDS,
      MEMORY_KINDS,
      ADVISORY_KINDS,
      PASSTHROUGH_KINDS,
    ]
    const seen = new Set<string>()
    for (const list of lists) {
      for (const kind of list) {
        expect(seen.has(kind), `${kind} listed twice`).toBe(false)
        seen.add(kind)
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(KIND_CLASSES).sort())
    expect(classifyKind('turn-rules')).toBe('governance')
    expect(classifyKind('user')).toBe('task')
    expect(classifyKind('memory')).toBe('memory')
    expect(classifyKind('advisor')).toBe('advisory')
    expect(classifyKind('tool-registry')).toBe('passthrough')
  })

  it('exposes the five classes in the design table order and only two budgeted ones', () => {
    expect(INPUT_CLASSES).toEqual(['governance', 'task', 'memory', 'advisory', 'passthrough'])
    expect(BUDGETED_CLASSES).toEqual(['memory', 'advisory'])
    expect(INPUT_CLASSES.filter(isBudgeted)).toEqual(['memory', 'advisory'])
  })

  it('holds exactly one kind in the memory class', () => {
    expect([...MEMORY_KINDS]).toEqual(['memory'])
  })
})
