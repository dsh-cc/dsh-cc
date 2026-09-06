/**
 * The Python SDK document renderer: `renderToolsSdkPy`, the `tools:sdk` prompt
 * section rendered under `runtime.language === 'python'` — the fixed usage
 * instructions plus one named `TypedDict` per tool argument or output object
 * and one awaitable method per visible tool on a `Tools` protocol. Split out
 * of `py-types.ts` for the line budget; re-exported from `py-types.ts`.
 * @module @dsh-cc/tools/src/py-sdk-doc
 */

import type { ToolSdkSchema } from './ts-types.ts'
import { describe, camelCase, isBareIdentifier, pad, RESERVED } from './py-names.ts'
import type { RenderState } from './py-names.ts'
import { renderType } from './py-render.ts'

/** `typing` symbols this module may emit, in the deterministic import order. */
const TYPING_ORDER = ['Any', 'Literal', 'NotRequired', 'Protocol', 'TypedDict'] as const

/**
 * One-line docstring for a tool `description`, or no lines when there is none.
 * Backslashes are doubled first, every quote is escaped, and a trailing
 * backslash cannot survive: a description ending in `"` or an odd backslash
 * would otherwise merge with (or escape) the closing triple quote and make
 * the generated block — Code Mode's only SDK — syntactically invalid Python.
 */
function docLines(description: unknown, indent: number): string[] {
  const collapsed = describe({ description })
  if (collapsed === undefined) return []
  const escaped = collapsed.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return [`${pad(indent)}"""${escaped}"""`]
}

/** The fixed model-facing usage contract rendered above the declarations. */
const SDK_INSTRUCTIONS = `## Writing code for run_code

\`run_code\` takes two required arguments: \`code\` — the body of an async Python function (top-level \`await\` and \`return\` both work) — and \`description\`, a short summary of what the program does. At run time exactly two of the names declared below are bound: \`tools\` and \`ToolCallError\`. Everything else is a STATIC STUB describing argument and return types — in particular the \`TypedDict\` classes do NOT exist at run time, so build arguments as plain \`dict\`/\`list\` JSON values: \`await tools.name({"field": 1})\`, never \`FooArgs(field=1)\`, which raises \`NameError\`. Inside the program:

- Call tools as \`await tools.name(args)\` — subscript access for exotic, reserved, or underscore-leading names: \`await tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value (each method's return type below). Tool arguments must be lossless JSON.
- A FAILED tool call raises \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose message is human-readable — wrap in \`try/except\` to handle and continue.
- Independent read-only calls MAY overlap under \`asyncio.gather\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- Emit the run's answer with \`print(...)\` and/or a top-level \`return <value>\`; the returned value must be lossless JSON. ONLY what you print and the returned value come back — intermediate tool results never enter the conversation, so extract just what you need.

The available tools:`

/**
 * Render the full `tools:sdk` prompt section under `runtime.language ===
 * 'python'`: the Python-flavored usage instructions plus one named `TypedDict`
 * per tool argument or output object (and per nested object) and one awaitable
 * method per visible tool on a `Tools` protocol — typed args in, the tool's
 * canonical output value out — with a `tools: Tools` singleton the model calls
 * into. The `typing` import line lists exactly the symbols the render used.
 * Deterministic — tools are emitted in lexicographic name order, and class
 * declarations precede the protocol in that same order (nested classes before
 * the parent that references them), so an unchanged tool set produces
 * byte-identical text across assemblies. The sort is not a total order on
 * byte-equal names, so two schemas sharing a name would render in argument
 * order; the caller's visible-capability map is keyed by name, so the input
 * never carries a duplicate.
 * @param schemas - the tool schemas plus canonical output schemas to declare
 *   (the caller excludes `run_code` itself).
 * @returns the complete section text.
 */
export function renderToolsSdkPy(schemas: ToolSdkSchema[]): string {
  const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const state: RenderState = { classes: [], usedClassNames: new Set(), nextClassCounter: new Map(), typing: new Set(['Protocol']) }
  // ONE ordered member stream, matching the documented lexicographic contract
  // and the TypeScript flavor (which quotes exotic keys in place rather than
  // partitioning them out). Interleaving is free here: a comment line between
  // two `async def` lines is not a statement, so it changes nothing about how
  // the class body parses.
  const members: string[] = []
  let statements = 0
  for (const schema of sorted) {
    const argType = renderType(schema.parameters, `${camelCase(schema.name)}Args`, state)
    const outputType = renderType(schema.output, `${camelCase(schema.name)}Output`, state)
    if (isBareIdentifier(schema.name) && !RESERVED.has(schema.name) && !schema.name.startsWith('_')) {
      // A docstring only documents its method when it is the FIRST statement
      // of that method's body. Emitted before the `async def` it would instead
      // become the `Tools` class docstring (for the first tool) or a dead
      // expression (for every later one), leaving every method undocumented —
      // and under `mode: 'code'` this SDK is the model's only description of
      // what a tool does. A docstring is a complete body, so the `...` stub is
      // only for the description-less case.
      const doc = docLines(schema.description, 2)
      members.push(doc.length > 0
        ? `${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}:`
        : `${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}: ...`)
      members.push(...doc)
      statements += 1
    } else {
      // Not reachable as ``tools.name`` — the model reaches it via
      // ``tools[name]``. Exotic names and hard keywords are not legal
      // attributes at all; an underscore-leading name (``_foo``) IS a legal
      // attribute and is routed here anyway, because the forms that break
      // split three ways — a non-dunder ``__token`` name-mangles at the CALL
      // site, a dunder that exists on ``object``/``type`` (``__class__``,
      // ``__doc__``) resolves before ``__getattr__`` ever runs, and implicit
      // special-method lookup skips the hook entirely — and one rule over the
      // whole family costs nothing while a per-form rule would have to
      // enumerate them (see {@link RESERVED}). The stub lists it as a subscript comment
      // (referencing the named TypedDicts too) so a reader sees what is
      // accessible; runtime resolution goes through the proxy's __getitem__.
      members.push(`${pad(1)}# tools[${JSON.stringify(schema.name)}](args: ${argType}) -> ${outputType}`)
      const description = describe(schema)
      if (description !== undefined) members.push(`${pad(1)}#   ${description}`)
    }
  }
  // Subscript entries are COMMENTS, not statements: a class body of only
  // comments fails to parse, so `pass` is required whenever no method was
  // emitted — including the subscript-only tool set.
  const bodyLines = statements > 0 ? members : [`${pad(1)}pass`, ...members]
  const body = bodyLines.join('\n')
  const imports = TYPING_ORDER.filter(symbol => state.typing.has(symbol))
  const classBlock = state.classes.length > 0 ? `${state.classes.join('\n\n')}\n\n` : ''
  const errorDeclaration = 'class ToolCallError(Exception):\n    toolName: str'
  const declaration = `from typing import ${imports.join(', ')}\n\n${errorDeclaration}\n\n${classBlock}class Tools(Protocol):\n${body}\n\ntools: Tools`
  return `${SDK_INSTRUCTIONS}\n\n\`\`\`python\n${declaration}\n\`\`\``
}
