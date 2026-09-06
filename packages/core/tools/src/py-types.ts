/**
 * Code Mode codegen — Python flavor. The pure projection from registered tool schemas to the
 * Python SDK text the model programs against under `runtime.language === 'python'`. Sibling of
 * {@link ./ts-types.ts | ts-types.ts}; the two files are two projections of the same registry
 * store, keyed by the loaded {@link @deepseek-ai/dsh-code-runtime#CodeRuntime.language | code
 * runtime's language}.
 *
 * Under `mode: 'code'` the native tool schemas are omitted from the request, so this generated
 * SDK is the model's ONLY source for each tool's argument names, required fields, types,
 * descriptions, and canonical output shapes; under `mode: 'both'` the native schemas ship
 * alongside it and it is one of two. Object-shaped arguments and outputs therefore render as one
 * named `TypedDict` per tool (and per nested object), not an opaque `dict[str, Any]`, so the
 * shape survives into the program under the mode that has nothing else to carry it.
 *
 * Line-budget layout: `py-names.ts` holds the shared naming/state/text-escape machinery,
 * `py-render.ts` the {@link renderType} walker, `py-sdk-doc.ts` the `renderToolsSdkPy`
 * document renderer; this file stays the public barrel — both exports re-exported here.
 * @module @dsh-cc/tools/src/py-types
 */

import { renderType } from './py-render.ts'

export { renderToolsSdkPy } from './py-sdk-doc.ts'

/**
 * Map one JSON-Schema node to a context-free Python type expression from the
 * `typing` module. Handles every unified schema construct — `object` (degraded
 * to `dict[str, Any]`: naming a `TypedDict` requires the render context that
 * {@link renderToolsSdkPy} supplies), `const`/`enum` (→ `Literal[...]`),
 * `oneOf` (→ union), `string`/`number`/`integer`/`boolean`/`null`, `array`
 * (`items` → `list[T]`) — and returns `Any` for an unsupported or malformed
 * schema, matching the TS flavor's `unknown` fallback. Type annotations in the
 * emitted SDK are advisory: Python does not enforce them at runtime.
 * @param schema - the JSON-Schema node.
 * @returns the Python type text.
 */
export function jsonSchemaToPy(schema: unknown): string {
  // A throwaway state whose class collector never escapes: an object with
  // properties has nowhere to declare its TypedDict and degrades to
  // dict[str, Any]. renderToolsSdkPy drives the named-TypedDict path.
  return renderType(schema, '', { classes: [], usedClassNames: new Set(), nextClassCounter: new Map(), typing: new Set() })
}
