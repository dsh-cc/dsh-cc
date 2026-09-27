import { describe, expect, it } from 'vitest'
import { splitShellCommand } from '../src/shell-segments.ts'
import { stripLeadingAssignments } from '../src/shell-words.ts'

/** Shorthand: expect a single clean segment with the given raw/subject/first. */
function expectSegment(command: string, raw: string, subject = raw, first = subject.split(/\s+/)[0]!, tainted = false) {
  const result = splitShellCommand(command)
  expect(result, command).toEqual({
    kind: 'segments',
    segments: [{ raw, subject, first, tainted, assignmentOnly: subject === '' }],
  })
}

// NOTE: these two helpers register their own `it()` — call them ONLY at
// describe level, never inside another `it`.
const opaque = (command: string, why: string) =>
  it(`${JSON.stringify(command)} ⇒ opaque:${why}`, () => {
    expect(splitShellCommand(command)).toEqual({ kind: 'opaque', why })
})

const segments = (command: string, raws: string[]) =>
  it(`${JSON.stringify(command)} ⇒ [${raws.map(r => JSON.stringify(r)).join(', ')}]`, () => {
    const result = splitShellCommand(command)
    expect(result.kind, command).toBe('segments')
    if (result.kind !== 'segments') return
    expect(result.segments.map(segment => segment.raw)).toEqual(raws)
})

describe('splitShellCommand — quoting (D1)', () => {
  it("hard quotes never split: `ls 'a && b'`", () => {
    expectSegment("ls 'a && b'", "ls 'a && b'")
  })
  it("soft quotes never split: `ls \"a && b\"`", () => {
    expectSegment('ls "a && b"', 'ls "a && b"')
  })
  it('backslash is literal inside single quotes', () => {
    expectSegment("echo 'a\\nb'", "echo 'a\\nb'")
  })
  it('ANSI-C quoting is its own state and `\\\'` does not close it', () => {
    expectSegment("echo $'a\\'b'", "echo $'a\\'b'")
  })
  opaque("ls 'abc", 'quote')
  opaque('ls "abc', 'quote')
  opaque("echo $'abc", 'quote')
  it('soft-quote escapes: only \\" \\\\ \\` \\$ and newline are escapes', () => {
    expectSegment('echo "a\\$b"', 'echo "a\\$b"')
  })
  it('quoted whitespace joins the token, not splits it', () => {
    const result = splitShellCommand('ls "a b"')
    expect(result.kind).toBe('segments')
    if (result.kind === 'segments') expect(result.segments[0]!.first).toBe('ls')
  })
})

describe('splitShellCommand — escapes (D1)', () => {
  it('escaped operators never split or taint', () => {
    expectSegment('ls \\; rm', 'ls \\; rm')
    expectSegment('ls a\\&b', 'ls a\\&b')
    expectSegment('ls \\|x', 'ls \\|x')
  })
  segments('ls \\\n -la', ['ls  -la'])
  opaque('ls \\', 'quote')
})

describe('splitShellCommand — separators and operand integrity (D1)', () => {
  segments('ls;pwd', ['ls', 'pwd'])
  segments('ls && pwd', ['ls', 'pwd'])
  segments('ls || pwd | wc', ['ls', 'pwd', 'wc'])
  segments('a & b', ['a', 'b'])
  segments('a &\nb', ['a', 'b'])
  segments('ls &&\n pwd', ['ls', 'pwd'])
  segments('producer |\n consumer', ['producer', 'consumer'])
  segments('\n\n  ls', ['ls'])
  segments('ls\n\npwd', ['ls', 'pwd'])
  segments('ls;\npwd', ['ls', 'pwd'])
  segments('ls ;', ['ls'])
  segments('ls &', ['ls'])
  opaque('ls &&', 'grammar')
  opaque('| ls', 'grammar')
  opaque('&& ls', 'grammar')
  opaque('ls ;; ls', 'grammar')
  opaque('; ls', 'grammar')
  opaque('', 'grammar')
  opaque('   \n  # just a comment\n', 'grammar')
})

describe('splitShellCommand — comments (D1)', () => {
  segments('ls # comment && rm -rf /', ['ls'])
  segments('ls\n# comment\npwd', ['ls', 'pwd'])
  it('# inside a word is literal', () => {
    expectSegment('a#b', 'a#b')
  })
})

describe('splitShellCommand — substitution tainting (D1)', () => {
  it('`$(` taints its segment', () => {
    expectSegment('echo $(date)', 'echo $(date)', 'echo $(date)', 'echo', true)
  })
  it('backquote taints its segment', () => {
    expectSegment('echo `date`', 'echo `date`', 'echo `date`', 'echo', true)
  })
  it('substitution inside double quotes taints', () => {
    expectSegment('echo "x$(date)"', 'echo "x$(date)"', 'echo "x$(date)"', 'echo', true)
    expectSegment('echo "x`date`"', 'echo "x`date`"', 'echo "x`date`"', 'echo', true)
  })
  it('substitution inside `${…}` taints', () => {
    expectSegment('echo ${a:-$(cmd)}', 'echo ${a:-$(cmd)}', 'echo ${a:-$(cmd)}', 'echo', true)
  })
  it('no split inside substitution: separators belong to the inner command', () => {
    const result = splitShellCommand('echo $(a && b)')
    expect(result.kind).toBe('segments')
    if (result.kind === 'segments') expect(result.segments).toHaveLength(1)
  })
  it('quotes inside substitution stay inside', () => {
    const result = splitShellCommand('cmd `echo "a"`')
    expect(result.kind).toBe('segments')
    if (result.kind === 'segments') expect(result.segments[0]!.raw).toBe('cmd `echo "a"`')
  })
  it('a paren inside substitution is not a subshell', () => {
    const result = splitShellCommand("echo $(printf 'a)b')")
    expect(result.kind).toBe('segments')
  })
  opaque('echo $(a', 'quote')
  opaque('echo `a', 'quote')
  opaque('echo ${a', 'quote')
  opaque('(ls)', 'subshell')
  opaque('a; (b)', 'subshell')
  opaque('{ ls; }', 'group')
  opaque('ls a{b,c}', 'group')
  it('`${…}` balanced braces do not split; nested `${}` handled', () => {
    const result = splitShellCommand('echo ${a:-${b}c}')
    expect(result.kind).toBe('segments')
  })
})

describe('splitShellCommand — redirections (D1/R6)', () => {
  it('fd-dup forms are inert (no taint)', () => {
    expectSegment('ls 2>&1', 'ls 2>&1', 'ls 2>&1', 'ls', false)
    expectSegment('ls x2>&1', 'ls x2>&1', 'ls x2>&1', 'ls', false)
    expectSegment('cmd 2>&-', 'cmd 2>&-')
    expectSegment('cmd <&3', 'cmd <&3')
  })
  it('writing redirections taint', () => {
    expectSegment('ls > /tmp/x', 'ls > /tmp/x', 'ls > /tmp/x', 'ls', true)
    expectSegment('ls >> f', 'ls >> f', 'ls >> f', 'ls', true)
    expectSegment('ls >| f', 'ls >| f', 'ls >| f', 'ls', true)
    expectSegment('ls &> f', 'ls &> f', 'ls &> f', 'ls', true)
    expectSegment('ls &>> f', 'ls &>> f', 'ls &>> f', 'ls', true)
    expectSegment('ls >&file', 'ls >&file', 'ls >&file', 'ls', true)
    expectSegment('cat < in', 'cat < in', 'cat < in', 'cat', true)
    expectSegment('cat <> f', 'cat <> f', 'cat <> f', 'cat', true)
    expectSegment('ls 2> err', 'ls 2> err', 'ls 2> err', 'ls', true)
  })
  opaque('cat << EOF', 'heredoc')
  opaque('cat <<- EOF', 'heredoc')
  opaque('cat <<< str', 'heredoc')
})

describe('splitShellCommand — reserved words (D1/R7)', () => {
  opaque('if true; then rm x; fi', 'reserved')
  opaque('while true; do ls; done', 'reserved')
  opaque('case x in a) ;; esac', 'subshell')
  opaque('FOO=1 if true; then x; fi', 'reserved')
  it('a non-reserved command with reserved-looking words later is fine', () => {
    const result = splitShellCommand('ls; echo done')
    expect(result.kind).toBe('segments')
  })
})

describe('splitShellCommand — assignments (D5)', () => {
  it('strips upper- and lower-case assignment words', () => {
    expectSegment('H=/tmp/x', 'H=/tmp/x', '', '', false)
    const result = splitShellCommand('path=/usr/bin ls -la')
    expect(result.kind).toBe('segments')
    if (result.kind === 'segments') {
      expect(result.segments[0]!.subject).toBe('ls -la')
      expect(result.segments[0]!.first).toBe('ls')
      expect(result.segments[0]!.assignmentOnly).toBe(false)
    }
  })
  it('quoted assignment values are lexically complete words', () => {
    const result = splitShellCommand("FOO='a b c' BAR=x ls")
    expect(result.kind).toBe('segments')
    if (result.kind === 'segments') expect(result.segments[0]!.subject).toBe('ls')
  })
  it('repeated assignment stripping', () => {
    const result = splitShellCommand('A=1 B=2 cmd')
    expect(result.kind).toBe('segments')
    if (result.kind === 'segments') expect(result.segments[0]!.subject).toBe('cmd')
  })
  it('a word that merely contains = is not an assignment', () => {
    const result = splitShellCommand('grep =x file')
    expect(result.kind).toBe('segments')
    if (result.kind === 'segments') expect(result.segments[0]!.subject).toBe('grep =x file')
  })
})

describe('splitShellCommand — caps and misc (D1)', () => {
  it('more than 64 segments is opaque', () => {
    const many = Array.from({ length: 65 }, (_, i) => `c${i}`).join(' && ')
    expect(splitShellCommand(many)).toEqual({ kind: 'opaque', why: 'too-many' })
  })
  it('exactly 64 segments stay segments', () => {
    const exact = Array.from({ length: 64 }, (_, i) => `c${i}`).join(';')
    const result = splitShellCommand(exact)
    expect(result.kind).toBe('segments')
    if (result.kind === 'segments') expect(result.segments).toHaveLength(64)
  })
  it('CJK characters pass through', () => {
    const result = splitShellCommand('echo 你好 && echo 世界')
    expect(result.kind).toBe('segments')
    if (result.kind !== 'segments') return
    expect(result.segments.map(segment => segment.raw)).toEqual(['echo 你好', 'echo 世界'])
    expect(result.segments[0]!.first).toBe('echo')
  })
  it('the scanner never throws on pathological input', () => {
    for (const command of ['"', "'", '$(', '${', '`', '\\', '&&&', '||||', '$(', '$\'']) {
      expect(() => splitShellCommand(command)).not.toThrow()
    }
  })
})

describe('stripLeadingAssignments (D5 shared helper)', () => {
  it('strips repeated case-permissive assignment words', () => {
    expect(stripLeadingAssignments('FOO=1 bar=2 ls -la')).toBe('ls -la')
    expect(stripLeadingAssignments('foo=1 LS')).toBe('LS')
  })
  it('respects quoted values', () => {
    expect(stripLeadingAssignments("FOO='a b c' ls")).toBe('ls')
    expect(stripLeadingAssignments('FOO="a b" ls')).toBe('ls')
  })
  it('leaves text without leading assignments untouched', () => {
    expect(stripLeadingAssignments('ls FOO=1')).toBe('ls FOO=1')
    expect(stripLeadingAssignments('ls')).toBe('ls')
  })
})
