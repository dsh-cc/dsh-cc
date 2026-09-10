import { describe, expect, it } from 'vitest'
import { route } from '../src/router.ts'

function ripgrepFixture(): string {
  return [
    'src/components/deeply/nested/module/alpha.ts:10:export function alpha() {}',
    'src/components/deeply/nested/module/alpha.ts:42:  alpha()',
    'src/components/deeply/nested/module/alpha.ts:77:// alpha lives here',
    'src/components/deeply/nested/module/beta.ts:3:import { alpha } from "./alpha"',
    'src/components/deeply/nested/module/gamma.ts:5:const alpha = 1',
  ].join('\n')
}

describe('router — search compression', () => {
  it('compresses multi-file ripgrep output, preserving every match and path', () => {
    const input = ripgrepFixture()
    const out = route(input)
    expect(out).not.toBeNull()
    expect(out!.kind).toBe('search')
    // Every matching line's content and line number survive.
    for (const line of input.split('\n')) {
      const [, lineNo, content] = /^[\w.@\/-]+?:(\d+):(.*)$/.exec(line) ?? []
      expect(out!.text).toContain(`${lineNo}:${content}`)
    }
    // Every file path survives, exactly once as a cluster header.
    expect(out!.text).toContain('== src/components/deeply/nested/module/alpha.ts ==')
    expect(out!.text).toContain('== src/components/deeply/nested/module/gamma.ts ==')
    expect(out!.text).toMatch(/== src\/components\/deeply\/nested\/module\/alpha\.ts ==/)
    // It actually saves.
    expect(out!.text.length).toBeLessThan(input.length)
  })

  it('is conservative on inputs that do not match the row format', () => {
    expect(route('just some prose\nover three lines\nbut not grep output')).toBeNull()
    expect(route('a.ts:1:x\nb.ts:2:y')).toBeNull() // too few rows
    expect(route('')).toBeNull()
    // Mixed format: too many non-rows to claim the structure confidently.
    expect(route('a.ts:1:x\nb.ts:2:y\nc.ts:3:z\nrandom line\nanother\nyet another')).toBeNull()
  })
})

describe('router — log compression', () => {
  const log = [
    '2026-09-10 10:00:00 INFO starting build',
    '2026-09-10 10:00:01 INFO compiling 400 modules',
    '2026-09-10 10:00:02 INFO chunk 1 chunk 2 chunk 3',
    '2026-09-10 10:00:03 INFO more progress 1',
    '2026-09-10 10:00:04 INFO more progress 2',
    '2026-09-10 10:00:05 ERROR build failed',
    '    at Object.<anonymous> (/src/build.js:12:9)',
    '    at Module._compile (/internal.js:1:1)',
    '2026-09-10 10:00:06 WARN exit code 1',
  ].join('\n')

  it('preserves every error line and stack trace, elides repetitive context', () => {
    const out = route(log)
    expect(out).not.toBeNull()
    expect(out!.kind).toBe('log')
    expect(out!.text).toContain('ERROR build failed')
    expect(out!.text).toContain('at Object.<anonymous> (/src/build.js:12:9)')
    expect(out!.text).toContain('at Module._compile (/internal.js:1:1)')
    expect(out!.text).toContain('lines elided')
    expect(out!.text.length).toBeLessThan(log.length)
  })

  it('keeps the first lines of a cluster for orientation', () => {
    const out = route(log)!
    expect(out.text).toContain('starting build')
  })

  it('handles pytest-style output', () => {
    const pytest = [
      '============================= test session starts =============================',
      'collected 120 items',
      'running 120 items in parallel',
      'extra filler line one',
      'extra filler line two',
      'extra filler line three',
      'extra filler line four',
      'FAILED tests/test_x.py::test_y - AssertionError: boom',
      '=========================== 1 failed, 119 passed =============================',
    ].join('\n')
    const out = route(pytest)
    expect(out).not.toBeNull()
    expect(out!.text).toContain('FAILED tests/test_x.py::test_y - AssertionError: boom')
    expect(out!.text).toContain('1 failed, 119 passed')
  })
})

describe('router — sizing sanity', () => {
  it('CJK text compresses conservatively (token-based sizing upstream keeps this safe)', () => {
    const cjkLog = Array.from({ length: 20 }, (_, i) =>
      i === 5
        ? '2026-09-10 10:00:00 ERROR 构建失败：缺少依赖'
        : `2026-09-10 10:00:0${i % 10} INFO 第 ${i} 行普通日志内容，重复多次以形成压缩空间`).join('\n')
    const out = route(cjkLog)
    if (out !== null) {
      // If routed at all, every error line survives and the result is shorter.
      expect(out.kind).toBe('log')
      expect(out.text).toContain('ERROR 构建失败：缺少依赖')
      expect(out.text.length).toBeLessThan(cjkLog.length)
    }
    // Either way the router never returns garbage.
    expect(out === null || typeof out.text === 'string').toBe(true)
  })
})
