/**
 * §3.2-a mini POSIX-shell lexer for the codex-rescue-bridge matcher.
 *
 * Grammar (hostile-input constraints, all strict):
 *
 *   command    := word (blank+ word)* EOF-without-operator
 *   word       := segment*                ; segments concatenate into one word
 *   segment    := unquoted | '\'' single-quoted '\'' | '"' double-quoted '"'
 *                 | '\' escape | '$' expansion | '`' | '~' | glob
 *
 * Rejections (fail closed, machine-readable `reason`):
 *   - any UNQUOTED operator: `;` `&&` `||` `|` `>` `<` newline  -> 'unquoted-operator'
 *   - env-assignment prefix on the first word (`FOO=1 cmd`)     -> 'env-assignment-prefix'
 *   - command substitution in UNQUOTED context ($(), backticks) -> 'command-substitution-unquoted'
 *   - command substitution in DOUBLE-QUOTED context             -> 'command-substitution-double-quoted'
 *     (bash evaluates those inside double quotes; SINGLE-QUOTED bytes are pure
 *     data and pass — this is what lets hostile install paths be expressed)
 *   - unclosed quote                                            -> 'unclosed-quote'
 *
 * Expansion-bearing words (tilde at word start, glob `*?[`, `$VAR`/`${...}`,
 * `$` of any kind) are flagged with `expansion: true` so the matcher can
 * require argv[0]/argv[1] to be expansion-free literal bytes.
 *
 * One word may concatenate quoted and unquoted segments ('a'\''b' is the
 * POSIX spelling of a literal `a'b`) — byte equality of the concatenated
 * text is what the matcher pins, never the quoting.
 */

export function lexCommand(raw) {
  const fail = (reason) => ({ ok: false, layer: 'lexer', reason })
  const argv = []
  let word = null // { text, expansion } | null
  const flush = () => {
    if (word !== null) {
      argv.push(word)
      word = null
    }
  }
  let i = 0
  while (i < raw.length) {
    const c = raw[i]
    if (c === ' ' || c === '\t') {
      flush()
      i++
      continue
    }
    if (c === '\n' || c === '\r') {
      flush()
      if (argv.length > 0) return fail('unquoted-operator')
      i++
      continue
    }
    if (';|&<>'.includes(c)) {
      return fail('unquoted-operator')
    }
    if (c === '#' && word === null) {
      // comment: skip to end of line
      while (i < raw.length && raw[i] !== '\n') i++
      continue
    }
    if (word === null) word = { text: '', expansion: false }
    while (i < raw.length) {
      const ch = raw[i]
      if (ch === '\'') {
        // single-quoted segment: pure data, no expansions ever
        i++
        const start = i
        while (i < raw.length && raw[i] !== '\'') i++
        if (i >= raw.length) return fail('unclosed-quote')
        word.text += raw.slice(start, i)
        i++ // closing quote
        continue
      }
      if (ch === '"') {
        // double-quoted segment: bash still evaluates $() and backticks here
        i++
        while (i < raw.length && raw[i] !== '"') {
          const d = raw[i]
          if (d === '\\') {
            if (i + 1 >= raw.length) return fail('unclosed-quote')
            const n = raw[i + 1]
            if (n === '$' || n === '`' || n === '"' || n === '\\') {
              word.text += n
              i += 2
            } else {
              word.text += d
              i++
            }
            continue
          }
          if (d === '`') return fail('command-substitution-double-quoted')
          if (d === '$') {
            if (raw[i + 1] === '(') return fail('command-substitution-double-quoted')
            word.expansion = true
            word.text += d
            i++
            continue
          }
          // quoted newline is data here; the argv grammar rejects it in prompts
          word.text += d
          i++
        }
        if (i >= raw.length) return fail('unclosed-quote')
        i++ // closing quote
        continue
      }
      if (ch === '$') {
        if (raw[i + 1] === '(') return fail('command-substitution-unquoted')
        word.expansion = true
        word.text += ch
        i++
        continue
      }
      if (ch === '`') return fail('command-substitution-unquoted')
      if (ch === '\\' && i + 1 < raw.length) {
        // escape: the next byte is a literal (a backslash-newline is a
        // continuation, not an operator)
        word.text += raw[i + 1]
        i += 2
        continue
      }
      if (ch === '~' && word.text === '') {
        // tilde expansion only at the start of an unquoted word
        word.expansion = true
        word.text += ch
        i++
        continue
      }
      if ('*?['.includes(ch)) {
        word.expansion = true
        word.text += ch
        i++
        continue
      }
      if (' \t\n\r;|&<>'.includes(ch)) break // back to outer loop, which rules on it
      word.text += ch
      i++
    }
  }
  flush()
  if (argv.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0].text)) {
    return fail('env-assignment-prefix')
  }
  return { ok: true, layer: 'lexer', argv }
}
