/**
 * Naming, state, and text-escaping machinery shared by the Python SDK renderers
 * (`py-types.ts`, `py-render.ts`, `py-sdk-doc.ts`). Leaf module: imports nothing
 * from its siblings, so any of them may depend on it without creating cycles.
 * Split out of `py-types.ts` for the line budget.
 * @module @dsh-cc/tools/src/py-names
 */

/**
 * The reference grammar's `xid_start xid_continue*` — the set
 * `str.isidentifier()` accepts on a CPython whose Unicode tables match the
 * engine's. See {@link isBareIdentifier} for what a version skew does.
 */
const IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u

/**
 * Whether a name can be emitted as a bare Python identifier rather than
 * routed to the subscript/`dict[str, Any]` path.
 *
 * Python identifiers are not ASCII: `路径` is as legal a field name as `path`,
 * and rejecting it would degrade the whole enclosing object, dropping every
 * field's name, requiredness, and type — information whose only source under
 * `mode: 'code'` is this generated text.
 *
 * NFKC stability is a second and separate condition, because CPython
 * normalizes identifiers at compile time while JSON keys are compared as
 * written: `ﬁeld` would be declared and reachable as `field`, so the SDK would
 * advertise a key under a spelling the harness never accepts, and two keys
 * that normalize together would collapse into one declaration. Those names
 * take the subscript path, which carries their exact bytes.
 *
 * `IDENTIFIER` matches `str.isidentifier()` (measured on Node 22.23.1 vs
 * CPython 3.9.6 tables): the equivalence holds inside the two versions' shared
 * tables, and the skew characters below are exactly where that pair diverges.
 * The predicate as a whole is deliberately stricter than `isidentifier()`,
 * which does not test NFKC stability: `'ﬁeld'.isidentifier()` is True and
 * this returns false.
 *
 * Both conditions are evaluated against the ENGINE's Unicode tables, and the
 * two sides are versioned independently — `\p{XID_Start}`/`\p{XID_Continue}`
 * follow the running engine (Node 22.23.1 reports Unicode 17.0) while CPython
 * follows its own (3.9.6 reports 13.0.0). The skew is not symmetric. A CPython
 * older than the engine is the dangerous direction: a character added to either
 * property since its tables (U+10570 Vithkuqi and U+1E290 Toto, 14.0; U+1E4D0
 * Nag Mundari, 15.0; U+1C89 Cyrillic TJE, 16.0 — ages per `DerivedAge.txt`; all
 * four are NFKC-stable and accepted here, and all four are `Cn` on that 3.9.6,
 * which rejects them) is emitted bare and its tokenizer refuses the character,
 * taking the whole SDK block down — the same parseability invariant
 * {@link UNPRINTABLE}, {@link LONE_SURROGATE} and {@link MAX_LIST_NESTING}
 * exist for. Both properties carry it: a character added only to `XID_Continue`
 * passes the trailing `\p{XID_Continue}*` in a tail position and fails the same
 * way — U+200C ZWNJ and U+200D ZWJ are that case, gaining `XID_Continue` in UCD
 * 15.1 and absent from it in 13.0.0, 14.0.0 and 15.0.0, so `a\u{200C}b` is
 * emitted bare here while `isidentifier()` is False on 3.9.6 and on 3.12.13
 * (15.0.0). A CPython newer than the engine only routes a legal name to the
 * subscript/`dict[str, Any]` path: less readable, still correct. The NFKC
 * condition reduces to the same skew, since normalization stability guarantees
 * an assigned character's normalization never changes afterwards.
 *
 * This predicate is not the only reader of engine tables. {@link camelCase}
 * reads them at three further points — its split set, its head test, and its
 * `toUpperCase()` case mapping — and this predicate's verdict gates none of
 * them: a class name derived there reaches emitted text whenever any object
 * shape in the tool's schema declares a `TypedDict`, including for a tool this
 * predicate rejected. A tool named `zz-\u{1E4D0}x` with such parameters never
 * reaches the skew here (the `-` rejects it outright) yet emits `class
 * Zz\u{1E4D0}xArgs`, which that same 3.9.6 refuses — Nag Mundari arrived two
 * releases after its tables. The case mapping is a separate table rather than
 * an XID membership test, and it fails on names both conditions above accept:
 * `\u{019B}` is XID_Start and NFKC-stable, so this predicate accepts it and
 * `async def \u{019B}` compiles on 3.9.6, but Node uppercases it to
 * `\u{A7DC}` — unassigned in that CPython, whose own `.upper()` is the identity
 * here — and the declared `class \u{A7DC}Args` fails with `invalid
 * non-printable character U+A7DC`. Closing the exposure therefore covers all
 * four read points, not this predicate alone; it needs the target interpreter's
 * version, which the backend reporting `language: 'python'` owns; the
 * language-dispatch Agent Note records the deferral.
 *
 * The `ts-types` sibling keeps its own ASCII rule rather than sharing this
 * one: ECMAScript identifiers are a different set (`$`) and are never
 * normalized, so one predicate cannot be correct for both. ZWJ/ZWNJ are not
 * part of that difference — both sets carry them on the engine's tables; what
 * separates the two there is the CPython table version above.
 * @param name - the raw schema field or tool name.
 * @returns whether the name can be emitted bare.
 */
export function isBareIdentifier(name: string): boolean {
  return IDENTIFIER.test(name) && name.normalize('NFKC') === name
}

/**
 * Python hard keywords: reserved everywhere, so a tool or field named
 * ``class`` or ``lambda`` is legal on the wire but not as an attribute
 * (``tools.class`` would be a SyntaxError in the model program) and not as a
 * class-syntax `TypedDict` field. Such a tool renders under subscript access
 * and such an object degrades to ``dict[str, Any]`` — the model still reaches
 * every tool and field without collisions.
 * Soft keywords (``match``, ``case``, ``type``, ``_`` — the language
 * reference's whole set) are deliberately ABSENT: each is special in exactly
 * one syntactic position — a statement head (``match``, ``type``), a ``match``
 * statement's clause head (``case``), or a pattern (``_``) — so ``match: str``
 * as a field and ``async def match(...)`` as a method are both legal, and
 * including them would needlessly degrade common search/regex tool fields to
 * ``dict[str, Any]``. Underscore-leading names are handled separately, not
 * here: a non-dunder ``__token`` name-mangles, a dunder present on
 * ``object``/``type`` resolves before the proxy hook, and implicit
 * special-method lookup bypasses the hook.
 */
export const RESERVED = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
  'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield',
  // Not a keyword, but CPython refuses to ASSIGN it at compile time
  // (`SyntaxError: cannot assign to __debug__`), which is what a TypedDict
  // field, a parameter name, and a keyword argument all are.
  '__debug__',
])

/** `indent`-deep line prefix (four spaces per level to match PEP 8 output). */
export function pad(indent: number): string {
  return '    '.repeat(indent)
}

/**
 * Collector threaded through the type renderer: the emitted `TypedDict` class
 * declarations (nested classes precede the parent that references them), the
 * class names already taken (for collision suffixing), a per-base collision
 * counter, and the `typing` symbols the render actually used.
 */
export interface RenderState {
  readonly classes: string[]
  readonly usedClassNames: Set<string>
  /** Next collision counter per capped base, so allocation is amortized O(1) instead of rescanning from `2`. */
  readonly nextClassCounter: Map<string, number>
  readonly typing: Set<string>
}

/**
 * The `Cc` code points that survive the whitespace collapse in {@link describe}
 * and have no printable form: the C0 controls, DEL, and the C1 controls. Only
 * U+0009 to U+000D are absent, because ECMAScript `\s` already collapsed them —
 * `\s` is TAB/VT/FF/SP/NBSP/ZWNBSP/Zs plus LF/CR/LS/PS, so no C1 code point is
 * in it and the whole U+0080 to U+009F block reaches this rule intact. Those
 * are not hypothetical input: they are what Windows-1252 bytes 0x80 to 0x9F
 * (smart quotes, em dash) become when decoded as Latin-1.
 * CPython rejects source containing a NUL outright
 * (`SyntaxError: source code string cannot contain null bytes`), whether it
 * sits in a docstring or in a comment, so one such byte anywhere in a schema
 * description would make the whole generated SDK unparseable — under
 * `mode: 'code'`, the model's only declaration of the tools. The rest are
 * legal but invisible; escaping them with the same rule keeps the emitted text
 * readable and the treatment uniform.
 *
 * The boundary is the category, not per-code-point addressability: `\xNN`
 * addresses U+0000 to U+00FF, so one escape form covers `Cc` exactly. The
 * invisible `Cf` formatting characters pass through by design — of them only
 * U+00AD soft hyphen would fit `\xNN` at all, and escaping that one while
 * U+200B ZWSP, U+200E/U+200F bidi marks, and U+2060 word joiner passed through
 * would leave a rule that is neither category- nor addressability-shaped. The
 * whole family is legal in both consumers, since only LF and CR terminate a
 * Python string literal or a `#` comment. That set is the tokenizer's, not
 * `str.splitlines()`': NEL (U+0085), LS (U+2028), and PS (U+2029) split a
 * string at run time but do not end a physical line in source — measured on
 * CPython 3.9.6 and 3.12.13, each accepted in both positions with the value
 * round-tripping — so they are safe raw wherever they reach emitted text
 * unescaped, which for all three is `JSON.stringify`, at two call sites:
 * the scalar literal path, and the subscript tool-name comment's own
 * call, which a name carrying any of them always reaches, none being
 * `XID_Continue`. The `description` path escapes NEL under the class above and
 * folds LS and PS in {@link describe}'s `\s+` collapse, both being `\s`.
 */
const UNPRINTABLE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g

/**
 * Unpaired surrogate code points, escaped by {@link describe} as `\uNNNN` —
 * its own form, since `\xNN` stops at U+00FF. The `u` flag is what makes this
 * the LONE ones: in Unicode mode a well-formed pair is a single astral code
 * point outside D800 to DFFF, so an emoji in a description survives untouched.
 *
 * This is the NUL case from {@link UNPRINTABLE}, not the invisible-character
 * case. Python source must be UTF-8-encodable and a lone surrogate is not, so
 * `compile()` raises `UnicodeEncodeError: surrogates not allowed` for one
 * anywhere in the text — measured on 3.9 for a string literal and for a `#`
 * comment alike. A raw or MCP tool description reaches this: `JSON.parse` on a
 * wire `"\ud800"` escape yields exactly such a code point.
 */
const LONE_SURROGATE = /[\ud800-\udfff]/gu

/**
 * The collapsed one-line `description` of a schema node (byte-stable across
 * formatting churn), or `undefined` when the node carries none. Every caller
 * passes an object — a validated property node, the `ToolSdkSchema` itself, or
 * the `{ description }` wrapper {@link docLines} synthesizes — so only the
 * description field needs guarding. A description that collapses
 * to nothing (empty, or whitespace only) is `undefined` too: it documents the
 * node no better than an absent one, and emitting it would leave an empty
 * `"""` docstring or a bare `#   ` line in the SDK. Only ECMAScript whitespace
 * folds, so a description of whitespace plus one surviving control character is
 * NOT absent: it collapses to that character's visible escape.
 *
 * Control characters left over after the whitespace collapse are rendered as
 * their `\xNN` escapes (see {@link UNPRINTABLE}) and unpaired surrogates as
 * their `\uNNNN` escapes (see {@link LONE_SURROGATE}); the escape's own backslash is
 * emitted literally by both consumers, since {@link docLines} doubles it into a
 * Python source escape and a `#` comment carries it verbatim.
 */
export function describe(schema: object): string | undefined {
  const description = (schema as Record<string, unknown>).description
  if (typeof description !== 'string') return undefined
  const collapsed = description
    .replace(/\s+/g, ' ')
    .replace(UNPRINTABLE, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .replace(LONE_SURROGATE, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .trim()
  return collapsed.length === 0 ? undefined : collapsed
}

/**
 * CamelCase a name into a Python type identifier: non-identifier characters
 * split words, `_` splits too (it is `XID_Continue`, so the split set names it
 * explicitly), and a head that cannot start an identifier takes a `Tool`
 * prefix. Unicode survives, so a `路径` field yields `路径`-based class names
 * instead of collapsing to the bare prefix. A character that is not
 * `XID_Continue` splits even when it is a letter, so a name whose NFKC folding
 * would leave the identifier set is not carried through — the split set is the
 * grammar's, not an ASCII approximation of it.
 *
 * The result is NFKC-normalized: these names are generated, never matched
 * against a JSON key, so normalizing is free here and keeps what CPython
 * compiles identical to what is emitted — unlike {@link isBareIdentifier},
 * which must reject unstable names outright. Normalizing AFTER the prefix
 * decision is what makes that hold at the seam the prefix creates: `Tool` +
 * a combining-mark head composes there (`U+0301` gives `Tooĺ`, U+013A), so
 * normalizing only the un-prefixed part would emit a name CPython compiles to
 * a different symbol. The second call is idempotent on the un-prefixed arm.
 *
 * The split set, the head test, and `toUpperCase()` all read the engine's
 * Unicode tables, so this function carries the same version skew
 * {@link isBareIdentifier} documents, by paths independent of it: a class name
 * derived here reaches emitted text whenever any object shape in the tool's
 * schema declares a `TypedDict`, and the predicate's verdict on the tool name
 * does not gate that. The case mapping is the one that can fail on a name the
 * predicate accepted; the worked example is there.
 * @param raw - the schema field or tool name to derive from.
 * @returns a class-name segment safe to emit.
 */
export function camelCase(raw: string): string {
  const joined = raw
    .split(/[^\p{XID_Continue}]+|_+/u)
    .filter(part => part.length > 0)
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('')
    .normalize('NFKC')
  return (/^\p{XID_Start}/u.test(joined) ? joined : `Tool${joined}`).normalize('NFKC')
}
