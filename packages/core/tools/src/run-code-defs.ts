/**
 * The model-facing `run_code` definition vocabulary: the tool name, its
 * per-language schema flavors, and the failure error type shared by the
 * Code Mode transport in {@link ./code-mode.ts}.
 * @module dsh-tools/run-code-defs
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'

/** The model-facing name of the Code Mode tool. */
export const RUN_CODE_NAME = 'run_code'

/** The `tools:sdk` section order: inside the 100–199 tool-guidance band, after per-tool guidance sections. */
export const SDK_SECTION_ORDER = 150

/**
 * The language-specific `run_code` schema text: the tool `description` and its
 * `code` parameter description, kept together so a language's two model-facing
 * strings share one source of truth. Keyed by `PtcRuntime.language`, mirroring
 * `SDK_RENDERERS` in {@link ./index.ts}. The emitted flavor MUST match the
 * semantics the same language's SDK instructions promise, so the model never
 * receives a TypeScript schema beside a Python SDK (or vice versa).
 */
interface RunCodeFlavor {
  /** The tool `description` the model sees for this language. */
  readonly description: string
  /** The `code` parameter's description for this language. */
  readonly codeDescription: string
}

/**
 * The TypeScript flavor: the fallback for a schema read with no runtime
 * mounted ({@link resolveFlavor} owns which readers reach that). A real
 * assembly always resolves a runtime first, so the model never sees this
 * fallback outside its own language.
 */
export const TYPESCRIPT_FLAVOR: RunCodeFlavor = {
  description:
    'Execute a TypeScript program against the available tools. Takes two required '
    + 'arguments: `code`, the BODY of an async function (erasable syntax only; top-level '
    + '`await` and `return` work), and `description`, a short summary of what the program '
    + 'does. Call tools as `await tools.name(args)` per the declarations in the system '
    + 'prompt. Only what you print or return comes back — curate it.',
  codeDescription: 'The program: the body of an async TypeScript function.',
}

/**
 * The Python flavor: the body of an async function, top-level `await` and
 * `return`, answer via `print` and/or the returned value, matching
 * {@link ./py-types.ts}'s SDK instructions.
 */
const PYTHON_FLAVOR: RunCodeFlavor = {
  description:
    'Execute a Python program against the available tools. Takes two required '
    + 'arguments: `code`, the BODY of an async function (top-level `await` and `return` '
    + 'work), and `description`, a short summary of what the program does. Call tools as '
    + '`await tools.name(args)` per the declarations in the system prompt. Answer '
    + 'with `print(...)` and/or `return <value>` — only that comes back, so curate it.',
  codeDescription: 'The program: the body of an async Python function.',
}

/**
 * The languages Code Mode ships a presentation for. Both per-language tables —
 * {@link RUN_CODE_FLAVORS} here and `SDK_RENDERERS` in {@link ./index.ts} — are
 * checked against this union with `satisfies`, so a language added to one and
 * not the other fails `typecheck` instead of waiting for a runtime that reports
 * it. The tables stay declared `Record<string, …>` because `PtcRuntime.language`
 * is an unconstrained `string`: this union pins what the harness ships, while the
 * `Object.hasOwn` guards reject what a mounted runtime may report.
 */
export type CodeSdkLanguage = 'typescript' | 'python'

/** Per-language `run_code` schema flavors (see {@link RunCodeFlavor}); one entry per {@link CodeSdkLanguage}. */
const RUN_CODE_FLAVORS: Record<string, RunCodeFlavor> = {
  typescript: TYPESCRIPT_FLAVOR,
  python: PYTHON_FLAVOR,
} satisfies Record<CodeSdkLanguage, RunCodeFlavor>

/**
 * The `description` parameter's model-facing description: language-independent
 * (the UI label contract is the same for every runtime), shared between the
 * static spec and the language-aware `parameters` getter so the two emissions
 * can never drift.
 */
export const RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION
  = 'Clear, concise description of what this program does in active voice, '
    + '5-10 words (shown in the UI). Examples: "Count TODO markers across packages"; '
    + '"Read failing test and its fixture"; "Rename config key in every cordis.yml".'

/**
 * Resolve the {@link RunCodeFlavor} for the loaded runtime's language, read at
 * schema-emission time so the model-visible `run_code` schema always matches
 * the SDK section's language. `peekRuntime` returns `undefined` only when no
 * runtime is mounted, which reaches this function through definition readers
 * and `schemas()` — the doc-catalog harvest is the only shipped one, and none
 * of them feeds a model, because `wireSchemas` calls `requirePtcRuntime`
 * before projecting — so that path degrades to {@link TYPESCRIPT_FLAVOR}. A
 * mounted runtime whose language has no flavor entry fails loud, exactly as
 * `requirePtcRuntime` rejects it at assembly. Keeping this table in step with
 * `SDK_RENDERERS` is the compiler's job ({@link CodeSdkLanguage}); what this
 * guard owns is the runtime-supplied language neither table knows, which never
 * yields a wrong-language schema for a real runtime.
 */
export function resolveFlavor(peekRuntime: () => PtcRuntime | undefined): RunCodeFlavor {
  const runtime = peekRuntime()
  if (runtime === undefined) {
    // No runtime mounted: reached by definition readers and `schemas()`, of
    // which the doc-catalog harvest is the only shipped one. None feeds a
    // model — `wireSchemas` calls `requirePtcRuntime` before projecting, so
    // the assembly path never arrives here. Degrade to the TS default.
    return TYPESCRIPT_FLAVOR
  }
  // Own-property read: a language like `toString`/`constructor` would otherwise
  // resolve an inherited Object.prototype member as a flavor.
  const flavor = RUN_CODE_FLAVORS[runtime.language]
  if (!Object.hasOwn(RUN_CODE_FLAVORS, runtime.language) || flavor === undefined) {
    const known = Object.keys(RUN_CODE_FLAVORS).map(name => JSON.stringify(name)).join(', ')
    throw new Error(`dsh-tools: no run_code schema flavor registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`)
  }
  return flavor
}

/**
 * Thrown by `run_code` when the program run itself failed — a program
 * exception, a budget expiry, an abort, or substrate death. Extends
 * {@link HarnessError} (`code: 'CODE_RUN_FAILED'`); the registry's execution
 * pipeline converts it into a structured `isError` result whose text carries
 * the failure kind plus the captured logs, so the model can self-correct.
 */
export class CodeRunFailedError extends HarnessError {
  constructor(message: string) {
    super(message, 'CODE_RUN_FAILED')
    this.name = 'CodeRunFailedError'
  }
}
