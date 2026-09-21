import { describe, expect, it } from 'vitest'
import { diffTodos } from '../src/todo-diff.ts'

describe('todo snapshot differ', () => {
  it('arms on a transition to completed and counts steps', () => {
    const prev = new Map([['a', 'pending'], ['b', 'pending']])
    const out = diffTodos(prev, [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
      { content: 'c', status: 'pending' },
    ])
    expect(out.armed).toBe(true)
    expect(out.newlyCompleted).toEqual(['a'])
    expect(out.completedSteps).toBe(1)
    expect(out.pendingSteps).toBe(2)
    expect(out.snapshot.get('a')).toBe('completed')
  })

  it('does not arm when nothing newly completes (reorder, in_progress, re-write)', () => {
    const prev = new Map([['a', 'completed'], ['b', 'pending']])
    const out = diffTodos(prev, [
      { content: 'b', status: 'in_progress' },
      { content: 'a', status: 'completed' },
    ])
    expect(out.armed).toBe(false)
    expect(out.newlyCompleted).toEqual([])
    expect(out.completedSteps).toBe(1)
    expect(out.pendingSteps).toBe(1)
  })

  it('ignores a todo that was already completed in the previous snapshot', () => {
    const prev = new Map([['a', 'completed']])
    const out = diffTodos(prev, [{ content: 'a', status: 'completed' }])
    expect(out.armed).toBe(false)
  })

  it('treats added todos as pending, removed ones as gone', () => {
    const prev = new Map([['a', 'pending'], ['gone', 'pending']])
    const out = diffTodos(prev, [
      { content: 'a', status: 'pending' },
      { content: 'new', status: 'pending' },
    ])
    expect(out.armed).toBe(false)
    expect(out.snapshot.has('gone')).toBe(false)
    expect(out.snapshot.get('new')).toBe('pending')
    expect(out.pendingSteps).toBe(2)
  })

  it('arms once for a batch where two todos complete in one write', () => {
    const prev = new Map([['a', 'pending'], ['b', 'pending'], ['c', 'pending']])
    const out = diffTodos(prev, [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
      { content: 'c', status: 'in_progress' },
    ])
    expect(out.armed).toBe(true)
    expect(out.newlyCompleted).toEqual(['a', 'b'])
    expect(out.completedSteps).toBe(2)
    expect(out.pendingSteps).toBe(1)
  })

  it('handles an empty first snapshot (cold start)', () => {
    const out = diffTodos(new Map(), [{ content: 'a', status: 'completed' }])
    // A completion observed without a prior snapshot still arms (safe direction).
    expect(out.armed).toBe(true)
    expect(out.completedSteps).toBe(1)
  })
})
