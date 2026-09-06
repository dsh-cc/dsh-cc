/**
 * The Python type-expression renderer: {@link renderType}, the explicit-stack
 * walker that maps one validated JSON-Schema node to a Python type expression
 * while threading a {@link RenderState} to collect the `TypedDict` class
 * declarations and `typing` symbols a full render needs. Split out of
 * `py-types.ts` for the line budget; `jsonSchemaToPy` and `renderToolsSdkPy`
 * remain the public entries, re-exported from `py-types.ts`.
 * @module @dsh-cc/tools/src/py-render
 */

import { assertSupportedJsonSchema } from './json-schema.ts'
import type { JsonSchemaNode, JsonSchemaScalar } from './json-schema.ts'
import { describe, camelCase, isBareIdentifier, pad, RESERVED } from './py-names.ts'
import type { RenderState } from './py-names.ts'

/** Class-name base cap keeping each emitted name — and total text — linear in schema depth. */
const MAX_CLASS_NAME_BASE = 120

/**
 * Deepest `list[…]` nesting emitted into one annotation before the item type
 * degrades to `Any`. CPython's tokenizer rejects a logical line holding more
 * than 200 simultaneously-open brackets (`MAXLEVEL`, `SyntaxError: too many
 * nested parentheses`), so an array chain deeper than that would render an SDK
 * block that is not valid Python at all — the same failure the docstring
 * escaping in the SDK doc renderer exists to prevent. 180 leaves headroom for
 * the few brackets an annotation can add around the chain, all of which count
 * toward the same limit. Per emission site, counting brackets open at the
 * chain's innermost point:
 *
 * - Return annotation, `async def f(self, args: X) -> chain:` — 180 `list[`
 *   plus an innermost `Literal[`. The parameter list's `(` closed at the `)`
 *   before the `->`, so it is NOT open here: 181.
 * - TypedDict field, `field: NotRequired[chain]` — a class-body line with no
 *   other open bracket, and its children start at `listDepth: 1` to reserve
 *   the `NotRequired[`, so 179 `list[` plus `Literal[`: 181. Required fields
 *   share that start for uniformity, spending one level of representable depth
 *   on a bracket they never emit.
 * - Argument annotation, `async def f(self, args: chain) -> Y:` — the `(` IS
 *   still open around it: 180 `list[` plus `Literal[` plus the paren, 182, the
 *   worst case. Reachable only through a raw `register()` whose `parameters`
 *   is an array reached from the root through `oneOf` arms alone — the root
 *   array itself, or one nested under any depth of unions, since an arm
 *   inherits the enclosing depth unchanged (`A | B` opens no bracket). An
 *   object ancestor takes it out of this case: its fields restart the chain at
 *   the 181 site. `defineTool` compiles an object root, so the annotation is a
 *   bare TypedDict class name or a one-bracket `dict[str, Any]` when that
 *   object degrades — never a chain.
 *
 * A CPython grammar limit, not a deployment choice, so it is fixed rather than
 * configurable. The sibling `ts-types` renderer needs no counterpart: nothing
 * in the TypeScript grammar bounds nesting, and its SDK block is never type-
 * checked. Only bracket nesting counts — a `oneOf` renders as a flat `A | B`
 * chain and nested objects render as separate `class` statements, so neither
 * accumulates open brackets at any depth. The invariant this cap serves is
 * grammatical validity; see the `oneOf` arm in {@link renderType} for the one
 * interpreter limit deliberately left uncapped.
 */
const MAX_LIST_NESTING = 180

/**
 * Cap a class-name base at {@link MAX_CLASS_NAME_BASE} (see the callers for
 * why capping keeps the render linear). `slice` counts UTF-16 code units, so
 * an astral character straddling the boundary would be cut in half and leave a
 * lone surrogate — not an identifier character, and not even well-formed text;
 * drop it rather than emit it.
 */
function capClassNameBase(base: string): string {
  if (base.length <= MAX_CLASS_NAME_BASE) return base
  const capped = base.slice(0, MAX_CLASS_NAME_BASE)
  return /[\uD800-\uDBFF]$/.test(capped) ? capped.slice(0, -1) : capped
}

/**
 * Reserve a unique class name from a base, suffixing `2`, `3`, … on collision.
 * The base is capped at {@link MAX_CLASS_NAME_BASE} first: child class names
 * derive from their parent's allocated name (`ParentChild`), so an unbounded
 * schema of single-field objects would otherwise grow each name by one field
 * per level and the sum of all names to Θ(depth²). Capping the base keeps each
 * name — and the total emitted text — linear in depth. Collisions resume from
 * the per-base counter in `state.nextClassCounter` rather than rescanning from
 * `2`, so a deep chain sharing one capped base stays O(1) per allocation
 * (amortized) instead of Θ(depth²) in time.
 */
function allocateClassName(base: string, state: RenderState): string {
  const capped = capClassNameBase(base)
  let name = capped
  if (state.usedClassNames.has(name)) {
    let n = state.nextClassCounter.get(capped) ?? 2
    while (state.usedClassNames.has(`${capped}${n}`)) n++
    name = `${capped}${n}`
    state.nextClassCounter.set(capped, n + 1)
  }
  state.usedClassNames.add(name)
  return name
}

/**
 * Append a child-name segment to a parent class-name base, capping the result
 * at {@link MAX_CLASS_NAME_BASE}. Capping AT PROPAGATION (not only inside
 * {@link allocateClassName}) keeps each level O(1): a deep `oneOf`- or
 * object-chain would otherwise carry an ever-growing ConsString down the tree
 * and re-materialize it (via `.length`/`.slice`) at every level — Θ(depth²).
 * The bounded base plus the collision counter still yields unique names.
 *
 * The join is NFKC-normalized because both sides are separately normalized yet
 * their concatenation need not be: a base ending in a Hangul L jamo or LV
 * syllable composes with a following V or T jamo head (`가` + `ᆨ` gives `각`),
 * so the emitted class name would differ from the symbol CPython compiles, and
 * two byte-distinct names could fold onto one — `usedClassNames` dedupes by the
 * raw bytes, so the collision counter would not see it. Normalizing costs
 * O(cap + segment) per level, the same order as the `slice` it feeds. The other
 * two join points need no counterpart: `Args`/`Output` start with `A`/`O` and
 * {@link allocateClassName}'s suffix is digits, none of which compose backwards.
 */
function childClassName(base: string, segment: string): string {
  return capClassNameBase(`${base}${segment}`.normalize('NFKC'))
}

/**
 * Render one validated scalar as Python literal text (`True`/`False`,
 * JSON-quoted strings, bare numbers). `null` cannot reach here: the `null`
 * type renders directly as `None`, and the unified validator rejects a null
 * `const`/`enum` entry on every other scalar type.
 *
 * A beyond-safe-range integral number takes `BigInt` digits rather than
 * `String`: Python integers are arbitrary-precision, so the emitted digits ARE
 * the value the model programs against, and `String` can give a different
 * integer than the double holds (`2 ** 60` prints the rounded `...847000`, not
 * the exact `...846976`) or no integer literal at all (`1e21` prints `1e+21`).
 * `String`'s rounding is not a bug in it: `Number::toString` emits the shortest
 * decimal string that re-reads to the same double, then pads to the exponent
 * with zeros (1 significant digit for `1e20`, 16 for `2 ** 60`) — and when the
 * shortest string is shorter than the double's exact value, those padded digits
 * name an integer no double holds. Passing one back would have to cross the
 * argument boundary as a JSON number — a double again — so the SDK would
 * document a value no program can pass. `BigInt` needs no case split: where
 * `String` is already exact (`2 ** 53`, `1e20`) the two agree byte for byte,
 * and where it is not, `BigInt` is the exact one. The TS flavor needs no
 * counterpart at all: its literal is re-read by a JS parser back into the same
 * double.
 *
 * `JSON.stringify` is also what keeps this path's output parseable, and it is
 * the only thing that does. It covers both classes of hazard: the two kinds of
 * code point CPython refuses anywhere in source — NUL among the C0 controls,
 * and the whole D800–DFFF unpaired-surrogate block, escaped under ES2019
 * well-formed stringification, which the engines range guarantees — and the
 * ones that break this line in particular, a bare `"` closing the literal
 * early, a trailing odd backslash eating the closing quote, and a bare LF/CR
 * ending it before its terminator. The `description` path carries
 * the unprintable-character and lone-surrogate rules because nothing quotes it,
 * and folds newlines in {@link describe}.
 *
 * That leans on a coincidence worth naming: every escape `JSON.stringify` can
 * emit (`\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, `\uXXXX`) is also a Python
 * escape denoting the same character, so the emitted `Literal[...]` both
 * parses and decodes back to the value the schema declared. DEL, the C1
 * controls (NEL among them), and LS/PS (U+2028/U+2029) do reach it raw —
 * legal but invisible, byte-for-byte as in the TS flavor; escaping them is a
 * both-flavors change. Those last three are legal here for the reason
 * the unprintable rule records: they are `str.splitlines()` boundaries, not
 * tokenizer line terminators. The subscript tool-name comment quotes its name
 * through its own call to the same `JSON.stringify`, never through this
 * function, and inherits both halves — escapes and pass-throughs alike.
 */
function pyScalar(value: JsonSchemaScalar): string {
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return BigInt(value).toString()
  }
  return String(value)
}

/**
 * Render a validated scalar `const`/`enum` as `Literal[...]`, falling back to
 * the broad type. Deliberately deviates from PEP 586, which restricts `Literal`
 * parameters to int/bool/str/bytes/enum/None: a non-integral number
 * `const`/`enum` emits a float literal (`Literal[1.5]`) a strict checker would
 * reject. An integral one does not deviate — {@link pyScalar} emits int digits,
 * including for the beyond-safe-range values it widens through `BigInt`, and
 * PEP 586 admits int parameters. Harmless either way — the stub is advisory
 * prompt text, only required to parse — and keeping the exact value
 * communicates the constraint to the model.
 */
function renderConstrainedScalar(node: JsonSchemaNode, broad: string, state: RenderState): string {
  if (node.const !== undefined) {
    state.typing.add('Literal')
    return `Literal[${pyScalar(node.const)}]`
  }
  if (node.enum !== undefined) {
    state.typing.add('Literal')
    return `Literal[${node.enum.map(pyScalar).join(', ')}]`
  }
  return broad
}

/**
 * Map one JSON-Schema node to a Python type expression, threading `state` to
 * collect the `TypedDict` declarations and `typing` symbols a full render
 * needs. `className` is the name to give an object node with properties (and
 * the prefix for its nested objects). Handles every unified schema construct —
 * `oneOf` (→ `X | Y`), `const`/`enum` (→ `Literal[...]`), `integer` (→ `int`),
 * `null` (→ `None`) — and degrades an unsupported or malformed schema to `Any`
 * without throwing, the same trusted-after-validation stance as the sibling
 * {@link ./ts-types.ts | ts-types} renderer. `jsonSchemaToPy` is the
 * context-free entry point; this is the collecting core.
 */
export function renderType(schema: unknown, className: string, state: RenderState): string {
  interface Frame {
    // A validated JSON-schema node past the root `assertSupportedJsonSchema`
    // (the root frame's schema is asserted before any frame is built), so the
    // walk reads its fields without casts — the same typed-frame shape as the
    // sibling ts-types renderer.
    schema: JsonSchemaNode
    className: string
    phase: 'start' | 'children'
    kind?: 'oneOf' | 'array' | 'typeddict'
    node?: JsonSchemaNode
    /** Open `list[` brackets enclosing this node in the annotation being built ({@link MAX_LIST_NESTING}). */
    listDepth: number
    children: { schema: JsonSchemaNode; className: string; listDepth: number }[]
    childIndex: number
    childTypes: string[]
    entries: [string, JsonSchemaNode][]
    allocated?: string
  }
  const newFrame = (schema: JsonSchemaNode, className: string, listDepth: number): Frame =>
    ({ schema, className, phase: 'start', listDepth, children: [], childIndex: 0, childTypes: [], entries: [] })
  try {
    // Validate the WHOLE tree once, then trust it — the same contract the
    // sibling ts-types renderer follows at a typed same-process boundary. Every
    // node past this point is a validated JSON-schema node, so the walk reads
    // its fields without re-checking. An unsupported or malformed schema throws
    // here (before anything is emitted) and degrades to `Any`, the Python
    // counterpart of the TS flavor's `unknown`.
    assertSupportedJsonSchema(schema)
    const frames: Frame[] = [newFrame(schema, className, 0)]
    let result: string | undefined
    /* jscpd:ignore-start -- the explicit-stack walk skeleton deliberately parallels
       ts-types.ts's renderSupportedSchema; the two sibling renderers keep symmetric shapes. */
    const finish = (type: string): void => {
      frames.pop()
      const parent = frames.at(-1)
      if (parent === undefined) result = type
      else parent.childTypes.push(type)
    }

    while (frames.length > 0) {
      const frame = frames.at(-1)
      /* v8 ignore next -- the loop condition guarantees a current frame. */
      if (frame === undefined) break

      if (frame.phase === 'children') {
        if (frame.childIndex < frame.children.length) {
          const child = frame.children[frame.childIndex]
          /* v8 ignore next -- childIndex is bounded by children.length. */
          if (child === undefined) throw new Error('missing python render child')
          frame.childIndex++
          frames.push(newFrame(child.schema, child.className, child.listDepth))
          continue
        }
        if (frame.kind === 'oneOf') {
          // Concatenate incrementally (template literal, not `Array.join`): V8
          // builds a lazy ConsString, so a deep oneOf chain materializes once
          // at the root instead of re-materializing the accumulated string at
          // every level (which `join` would, making it Θ(depth²)). This matches
          // the array arm's template-literal laziness and ts-types' composable-
          // document approach — the whole walk stays linear in schema depth.
          let union = ''
          for (const [index, childType] of frame.childTypes.entries()) {
            union = index === 0 ? childType : `${union} | ${childType}`
          }
          finish(union)
          continue
        }
        /* jscpd:ignore-end */
        if (frame.kind === 'array') {
          // `list[A | B]` needs no parentheses in Python. Array frames always
          // schedule exactly one child, so its type is present.
          /* v8 ignore next -- the ?? arm needs a childless array frame, which start never builds. */
          finish(`list[${frame.childTypes[0] ?? 'Any'}]`)
          continue
        }
        // typeddict: assemble AFTER the children so any nested class this one
        // references is already declared (declaration order = reference order).
        const node = frame.node
        const name = frame.allocated
        /* v8 ignore next -- typeddict frames always set node and allocated at start. */
        if (node === undefined || name === undefined) throw new Error('missing typeddict frame state')
        const required = new Set(node.required)
        const lines = [`class ${name}(TypedDict):`]
        for (let index = 0; index < frame.entries.length; index++) {
          const entry = frame.entries[index]
          const fieldType = frame.childTypes[index]
          /* v8 ignore next -- entries and childTypes correspond one-to-one. */
          if (entry === undefined || fieldType === undefined) throw new Error('missing typeddict field type')
          const [field, fieldSchema] = entry
          // The parent node passed assertSupportedJsonSchema, so every property
          // value is a validated schema node.
          const description = describe(fieldSchema)
          if (description !== undefined) lines.push(`${pad(1)}# ${description}`)
          if (required.has(field)) {
            lines.push(`${pad(1)}${field}: ${fieldType}`)
          } else {
            state.typing.add('NotRequired')
            lines.push(`${pad(1)}${field}: NotRequired[${fieldType}]`)
          }
        }
        // TypedDict syntax cannot express openness, so an open object states it
        // in-band: the annotation is advisory either way, and `mode: 'code'`
        // omits the native schemas, making this line the model's only signal
        // that extra keys are accepted.
        if (node.additionalProperties !== false) {
          lines.push(`${pad(1)}# Additional keys beyond those declared are allowed.`)
        }
        // A closed empty object still needs a class body (`pass`) to be valid
        // Python; the declared emptiness is the information.
        if (lines.length === 1) lines.push(`${pad(1)}pass`)
        state.classes.push(lines.join('\n'))
        finish(name)
        continue
      }

      frame.phase = 'children'
      const node = frame.schema
      if (node.oneOf !== undefined) {
        frame.kind = 'oneOf'
        // A union renders as `A | B` — no brackets of its own, so the branches
        // inherit the enclosing depth unchanged.
        //
        // Union LENGTH is deliberately uncapped, unlike list nesting. The two
        // limits are different in kind: >200 open brackets is a SyntaxError
        // from the tokenizer, so the text is not Python; a long `A | B | …`
        // chain is grammatically valid at any length and only defeats CPython's
        // C-recursion when `compile()` walks the left-nested BinOp spine
        // (measured: 1,000 branches compile, 5,000 raise RecursionError). This
        // block is prompt text — nothing compiles it — so that limit costs
        // nothing here, while capping would retire the deep-chain tests that
        // pin the walk's linear time and the class-name propagation cap. The
        // standard this renderer holds is grammatical validity, not
        // compilability under one interpreter's stack.
        frame.children = node.oneOf.map((branch, index) => ({ schema: branch, className: childClassName(frame.className, `${index + 1}`), listDepth: frame.listDepth }))
        continue
      }
      if (node.type === undefined) {
        state.typing.add('Any')
        finish('Any')
        continue
      }
      switch (node.type) {
        case 'string': finish(renderConstrainedScalar(node, 'str', state)); break
        case 'number': finish(renderConstrainedScalar(node, 'float', state)); break
        case 'integer': finish(renderConstrainedScalar(node, 'int', state)); break
        case 'boolean': finish(renderConstrainedScalar(node, 'bool', state)); break
        case 'null': finish('None'); break
        case 'array': {
          if (node.items === undefined) {
            state.typing.add('Any')
            finish('list[Any]')
            break
          }
          // Past MAX_LIST_NESTING another `list[` would push the annotation
          // beyond CPython's open-bracket limit and make the whole SDK block
          // unparseable, so the chain degrades here instead — an unusable
          // annotation either way, and this one is valid Python.
          if (frame.listDepth >= MAX_LIST_NESTING) {
            state.typing.add('Any')
            finish('Any')
            break
          }
          // An array of objects names its item type after the array field.
          frame.kind = 'array'
          frame.children = [{ schema: node.items, className: frame.className, listDepth: frame.listDepth + 1 }]
          break
        }
        case 'object': {
          // A missing `properties` is an empty property map, exactly as the
          // unified validator and the TS renderer read it — NOT an unknown
          // shape. The openness of the resulting empty object is decided below,
          // so a closed empty object still declares an empty TypedDict rather
          // than a permissive `dict[str, Any]`.
          const entries = Object.entries(node.properties ?? {})
          // An empty `className` marks the context-free `jsonSchemaToPy` entry:
          // there is no naming context to declare into, so degrade. This reads
          // the CALL's className, not `frame.className`: the marker belongs to
          // the whole walk, and frames propagate a derived name (a `oneOf`
          // branch of the context-free root gets the index-derived name `1` —
          // `childClassName` concatenates and caps, it does not go through
          // `camelCase`), so a per-frame read would declare classes the caller
          // has no way to receive, under a name that is not even a legal
          // identifier: `class 1(TypedDict):`. A field
          // name that is not a legal Python attribute is inexpressible as a
          // class-syntax `TypedDict` field, so such an object degrades whole.
          // A leading-double-underscore non-dunder field (`__token`) would be
          // NAME-MANGLED inside class syntax (`_ClassName__token`), describing a
          // different JSON key than the registered schema — degrade like any
          // other inexpressible field name.
          if (className === '' || !entries.every(([name]) => isBareIdentifier(name) && !RESERVED.has(name) && !(name.startsWith('__') && !name.endsWith('__')))) {
            state.typing.add('Any')
            finish('dict[str, Any]')
            break
          }
          // An OPEN empty object is any dict; a CLOSED empty object declares an
          // empty TypedDict so "no keys accepted" survives into the SDK.
          if (entries.length === 0 && node.additionalProperties !== false) {
            state.typing.add('Any')
            finish('dict[str, Any]')
            break
          }
          frame.kind = 'typeddict'
          frame.node = node
          frame.allocated = allocateClassName(frame.className, state)
          state.typing.add('TypedDict')
          frame.entries = entries
          // A field annotation is its own logical line, so nesting restarts —
          // at 1, reserving the bracket an optional field's `NotRequired[…]`
          // wraps around it. frame.allocated was assigned three statements up;
          // the ?? arm is for the type system only.
          /* v8 ignore next -- allocated is always set before children are built. */
          frame.children = entries.map(([field, child]) => ({ schema: child, className: childClassName(frame.allocated ?? '', camelCase(field)), listDepth: 1 }))
          break
        }
        /* v8 ignore next 4 -- assertSupportedJsonSchema narrowed this closed type union. */
        default: {
          state.typing.add('Any')
          finish('Any')
        }
      }
    }
    /* v8 ignore next -- every root frame produces one expression. */
    return result ?? 'Any'
  } catch {
    // An unsupported or malformed schema failed validation (before any
    // emission), or an unreachable internal invariant tripped. Either degrades
    // the node to `Any` rather than crashing prompt assembly — the Python
    // counterpart of the TS flavor's `unknown` fallback.
    state.typing.add('Any')
    return 'Any'
  }
}
