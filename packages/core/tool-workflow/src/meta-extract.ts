/**
 * Strict literal parser for the CC-style `export const meta = {...}` block
 * that begins a workflow script (plan §3.3). Meta is model-authored text, so
 * this parser is dependency-free and never evaluates the script: `new
 * Function`/eval is forbidden — the wrapper runs in the harness host process,
 * a privilege upgrade over the worker VM that executes the body.
 *
 * Accepted: strings (single/double quoted, standard escapes), numbers,
 * `true`/`false`/`null`, arrays, objects with identifier or string keys, plus
 * trailing commas and line/block comments. Template
 * literals, identifiers, spreads, computed keys, and function values are
 * rejected with an error naming the construct so the model can repair in one
 * step. Shape validation is delegated to the engine's `validateMeta`.
 * @module @dsh-cc/tool-workflow/meta-extract
 */

/** The leading meta-block contract quoted verbatim in refusals. */
export const META_FORM = `export const meta = { name, description }`

export type ExtractedMeta =
  | { ok: true; body: string; meta: unknown }
  | { ok: false; missing: boolean; error: string }

class MetaLiteralError extends Error {}

/** Skip whitespace and `//`/`/* *`/` comments from `i`; never returns out of range for well-formed input. */
function skipTrivia(script: string, i: number): number {
  for (;;) {
    while (i < script.length && /\s/.test(script[i]!)) i += 1
    if (script.startsWith('//', i)) {
      const nl = script.indexOf('\n', i)
      if (nl === -1) return script.length
      i = nl + 1
      continue
    }
    if (script.startsWith('/*', i)) {
      const end = script.indexOf('*/', i + 2)
      if (end === -1) throw new MetaLiteralError('meta block: unterminated /* comment')
      i = end + 2
      continue
    }
    return i
  }
}

function parseStringLiteral(script: string, i: number): { value: unknown; end: number } {
  const quote = script[i]
  i += 1
  let out = ''
  for (;;) {
    if (i >= script.length) throw new MetaLiteralError(`meta block: unterminated string literal`)
    const c = script[i]!
    if (c === quote) return { value: out, end: i + 1 }
    if (c === '\\') {
      const esc = script[i + 1]
      i += 2
      switch (esc) {
        case '"': case "'": case '\\': case '/': out += esc; break
        case 'b': out += '\b'; break
        case 'f': out += '\f'; break
        case 'n': out += '\n'; break
        case 'r': out += '\r'; break
        case 't': out += '\t'; break
        case 'u': {
          const hex = script.slice(i, i + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new MetaLiteralError('meta block: invalid \\u escape in string literal')
          out += String.fromCharCode(Number.parseInt(hex, 16))
          i += 4
          break
        }
        default: throw new MetaLiteralError(`meta block: unsupported string escape \\${esc ?? ''}`)
      }
      continue
    }
    out += c
    i += 1
  }
}

function parseNumberLiteral(script: string, i: number): { value: unknown; end: number } {
  const match = /^-?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/.exec(script.slice(i))
  if (match === null) throw new MetaLiteralError(`meta block: unexpected character "${script[i]}"`)
  return { value: Number(match[0]), end: i + match[0].length }
}

function parseIdentifier(script: string, i: number): { name: string; end: number } {
  const match = /^[$_a-zA-Z][$_a-zA-Z0-9]*/.exec(script.slice(i))
  return { name: match?.[0] ?? '', end: i + (match?.[0].length ?? 0) }
}

/** Recursive-descent strict-literal parser over one balanced `{...}` slice. */
class LiteralParser {
  constructor(private readonly script: string) {}

  parseValue(i: number): { value: unknown; end: number } {
    i = skipTrivia(this.script, i)
    const c = this.script[i]
    if (c === '"' || c === "'") return parseStringLiteral(this.script, i)
    if (c === '`') throw new MetaLiteralError('meta block: template literals are not allowed (use quoted strings)')
    if (c === '{') return this.parseObject(i)
    if (c === '[') return this.parseArray(i)
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return parseNumberLiteral(this.script, i)
    if (c === '.' || c === '(') throw new MetaLiteralError('meta block: function values are not allowed (meta must be plain data)')
    if (this.script.startsWith('...', i)) throw new MetaLiteralError('meta block: spreads are not allowed (meta must be plain data)')
    const id = parseIdentifier(this.script, i)
    if (id.name === 'true') return { value: true, end: id.end }
    if (id.name === 'false') return { value: false, end: id.end }
    if (id.name === 'null') return { value: null, end: id.end }
    if (id.name === 'function') throw new MetaLiteralError('meta block: function values are not allowed (meta must be plain data)')
    if (id.name !== '') throw new MetaLiteralError(`meta block: identifier "${id.name}" is not allowed (meta must be plain literal data)`)
    throw new MetaLiteralError(`meta block: unexpected character "${c}"`)
  }

  private parseObject(i: number): { value: unknown; end: number } {
    i += 1 // consume '{'
    const out: Record<string, unknown> = {}
    i = skipTrivia(this.script, i)
    if (this.script[i] === '}') return { value: out, end: i + 1 }
    for (;;) {
      i = skipTrivia(this.script, i)
      if (this.script.startsWith('...', i)) throw new MetaLiteralError('meta block: spreads are not allowed (meta must be plain data)')
      if (this.script[i] === '[') throw new MetaLiteralError('meta block: computed keys are not allowed (use identifier or string keys)')
      const c = this.script[i]
      let key: string
      if (c === '"' || c === "'") {
        const parsed = parseStringLiteral(this.script, i)
        key = parsed.value as string
        i = parsed.end
      } else {
        const id = parseIdentifier(this.script, i)
        if (id.name === '') throw new MetaLiteralError(`meta block: expected an object key, found "${c}"`)
        key = id.name
        i = id.end
      }
      const afterKey = skipTrivia(this.script, i)
      if (this.script[afterKey] === ',' || this.script[afterKey] === '}') {
        throw new MetaLiteralError(`meta block: identifier "${key}" is not allowed (meta must be plain literal data; write "${key}: <value>")`)
      }
      if (this.script[afterKey] !== ':') throw new MetaLiteralError(`meta block: expected ":" after key "${key}"`)
      const parsed = this.parseValue(afterKey + 1)
      out[key] = parsed.value
      i = skipTrivia(this.script, parsed.end)
      if (this.script[i] === ',') {
        i += 1
        if (this.script[skipTrivia(this.script, i)] === '}') return { value: out, end: skipTrivia(this.script, i) + 1 }
        continue
      }
      if (this.script[i] === '}') return { value: out, end: i + 1 }
      throw new MetaLiteralError(`meta block: expected "," or "}" in object, found "${this.script[i]}"`)
    }
  }

  private parseArray(i: number): { value: unknown; end: number } {
    i += 1 // consume '['
    const out: unknown[] = []
    i = skipTrivia(this.script, i)
    if (this.script[i] === ']') return { value: out, end: i + 1 }
    for (;;) {
      if (this.script.startsWith('...', skipTrivia(this.script, i))) {
        throw new MetaLiteralError('meta block: spreads are not allowed (meta must be plain data)')
      }
      const parsed = this.parseValue(i)
      out.push(parsed.value)
      i = skipTrivia(this.script, parsed.end)
      if (this.script[i] === ',') {
        i += 1
        if (this.script[skipTrivia(this.script, i)] === ']') return { value: out, end: skipTrivia(this.script, i) + 1 }
        continue
      }
      if (this.script[i] === ']') return { value: out, end: i + 1 }
      throw new MetaLiteralError(`meta block: expected "," or "]" in array, found "${this.script[i]}"`)
    }
  }
}

/**
 * Locate and lift the leading `export const meta = {...}` literal from a
 * workflow script. On success `body` is the remaining script (meta statement
 * stripped) for the engine's own syntax gate. `missing` distinguishes the
 * absent-meta refusal (the caller may fall back to the transitional `meta`
 * parameter) from a malformed-block construct error.
 */
export function extractInlineMeta(script: string): ExtractedMeta {
  try {
    let i = skipTrivia(script, 0)
    for (const word of ['export', 'const', 'meta']) {
      const id = parseIdentifier(script, i)
      if (id.name !== word) {
        return { ok: false, missing: true, error: `workflow: the script must begin with a literal ${META_FORM} block (the CC meta-block form)` }
      }
      i = skipTrivia(script, id.end)
    }
    if (script[i] !== '=') {
      return { ok: false, missing: true, error: `workflow: the script must begin with a literal ${META_FORM} block (the CC meta-block form)` }
    }
    i = skipTrivia(script, i + 1)
    if (script[i] !== '{') {
      return { ok: false, missing: true, error: `workflow: the meta block must be an object literal (${META_FORM})` }
    }
    const parser = new LiteralParser(script)
    const parsed = parser.parseValue(i)
    // The remainder after the meta block is the body; its syntax is the
    // engine's `assertBodyParses` gate, not ours.
    return { ok: true, body: script.slice(parsed.end), meta: parsed.value }
  } catch (error) {
    if (error instanceof MetaLiteralError) return { ok: false, missing: false, error: `workflow: ${error.message}` }
    throw error
  }
}
