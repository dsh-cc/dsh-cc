/**
 * Tests for scripts/audit-subagent-children.mjs (W2b): pure log parsing,
 * parent→child tree rebuild from log headers, --grep filtering, and
 * truncated-tail tolerance. Plain `.jsonl` fixtures; the zstd CLI spawn
 * lives only in the real walk path and is not exercised here.
 */
import { describe, expect, it } from 'vitest'
import {
  buildTree,
  collectSession,
  descendantClosure,
  filterSessions,
  formatChildTimeline,
  notableToolCalls,
} from '../../../../scripts/audit-subagent-children.mjs'

function header(id, extra = {}) {
  return JSON.stringify({ type: 'session', version: 3, isSeeded: false, id, createdAt: 1000, delegationDepth: 0, ...extra })
}

function toolUse(id, name, input = {}) {
  return JSON.stringify({
    type: 'assistant', id: `e-${id}`, timestamp: 2000 + id,
    message: { content: [{ type: 'tool_use', name, input }] },
  })
}

const PARENT_LOG = [header('parent-1'), toolUse(1, 'read'), toolUse(2, 'write', { file_path: '/x' })].join('\n')
const CHILD_LOG = [header('child-1', { parentSession: 'parent-1', seedLength: 3, origin: 'subagent', delegationDepth: 1 }),
  toolUse(3, 'bash', { command: 'git push' }), toolUse(4, 'edit', { file_path: '/y' })].join('\n')

function collectSessionText(id, parent) {
  return [header(id, parent === undefined ? {} : { parentSession: parent, origin: 'subagent', seedLength: 1, delegationDepth: 1 })].join('\n')
}

describe('audit-subagent-children', () => {
  it('case 1: extracts the header line and notable tool calls from a log', () => {
    const session = collectSession(PARENT_LOG)
    expect(session.header.id).toBe('parent-1')
    expect(session.notable).toEqual([{ at: 2002, tool: 'write', detail: '/x' }])
  })

  it('case 2: rebuilds the parent→child tree from headers', () => {
    const sessions = new Map([
      ['parent-1', collectSession(PARENT_LOG)],
      ['child-1', collectSession(CHILD_LOG)],
    ])
    const tree = buildTree(sessions)
    expect(tree.get('parent-1')).toEqual(['child-1'])
    expect(tree.get('child-1')).toEqual([])
  })

  it('case 3: --grep keeps only sessions whose log mentions the substring', () => {
    const sessions = new Map([
      ['parent-1', collectSession(PARENT_LOG)],
      ['child-1', collectSession(CHILD_LOG)],
    ])
    expect(filterSessions(sessions, 'git push')).toEqual(['child-1'])
    expect(filterSessions(sessions, 'zzz')).toEqual([])
  })

  it('case 4: a truncated trailing line is skipped, not a failure', () => {
    const truncated = CHILD_LOG + '\n{"type":"assistant","id":"partial","message":{"content":[{"type":"tool_u'
    const session = collectSession(truncated)
    expect(session.header.id).toBe('child-1')
    expect(session.notable).toHaveLength(2)
  })

  it('case 5: timelines carry wall-clock times and only notable tools', () => {
    const session = collectSession(CHILD_LOG)
    const timeline = formatChildTimeline('child-1', session)
    expect(timeline).toContain('bash')
    expect(timeline).toContain('git push')
    expect(timeline).not.toContain('read')
  })

  it('case 6: descendant closure of one session includes the session itself', () => {
    const sessions = new Map([
      ['parent-1', collectSession(PARENT_LOG)],
      ['child-1', collectSession(CHILD_LOG)],
      ['grand-1', collectSession(collectSessionText('grand-1', 'child-1'))],
    ])
    expect([...descendantClosure(sessions, 'parent-1')].sort()).toEqual(['child-1', 'grand-1', 'parent-1'])
  })
})
