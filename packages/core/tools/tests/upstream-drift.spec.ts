// Fork-drift gate for `@dsh-cc/tools` (design D2.4 of the harness 0.2.2-rc.1
// migration): diff the fork's `src/` against harness `packages/core/tools/src`
// at the pinned checkout and assert EXACTLY the documented delta set.
//
// Diff strategy: CODE-LINE multiset diff with whitespace normalization — each
// file is reduced to its trimmed non-empty lines with comment blocks and
// structural-only lines (`}`, `});`, `)`, …) dropped, compared as counted
// multisets in both directions, and every residual extra line (fork-side or
// upstream-side) must be covered by a DRIFT_ALLOWANCE entry that is a prefix of
// the line. Comments are documentation, not behavior: they are excluded here
// and described in README.md's FORK DRIFT note instead. Chosen over a hunk-based
// LCS diff because the allowances are described as line-level deltas, a line
// allowlist maps 1:1 onto them, and it needs no hunk extraction to stay
// deterministic.
//
// One extra rule carries the `json-schema-value.ts` extraction (a fork-only
// module): an upstream-only line of `json-schema.ts` is also covered when the
// same code line lives in the extracted file, so the extraction is asserted
// rather than allowlisted line by line.
//
// A missing sibling checkout is a HARD FAIL: drift must never read as "no
// drift". CI always has the checkout side-by-side with this repository.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const UPSTREAM_PACKAGE = 'packages/core/tools'

function findHarnessRoot(): string {
  let dir = fileURLToPath(new URL('../../../..', import.meta.url)) // repo root
  const candidates: string[] = []
  for (;;) {
    const candidate = join(dir, 'deepseek-harness')
    if (existsSync(join(candidate, UPSTREAM_PACKAGE, 'src', 'index.ts'))) {
      // Prefer the canonical side-by-side checkout over a .claude worktree copy.
      if (!candidate.includes('.claude')) return candidate
      candidates.push(candidate)
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (candidates.length > 0) return candidates[0]
  throw new Error(
    `upstream drift gate: no sibling deepseek-harness checkout with ${UPSTREAM_PACKAGE} found next to or above this repository — `
      + 'the gate hard-fails when the checkout is missing, because a missing checkout must never read as "no drift"',
  )
}

const HARNESS = findHarnessRoot()
const FORK_SRC = fileURLToPath(new URL('../src', import.meta.url))
const upstreamSrc = (name: string): string => join(HARNESS, UPSTREAM_PACKAGE, 'src', name)

/** Vendored files with an upstream counterpart (`src/x.ts` ↔ upstream `src/x.ts`). */
const PAIRS = [
  'batch', 'contracts', 'events', 'executor', 'index', 'json-schema',
  'pipeline', 'presentation', 'schema',
]

/**
 * Fork-only modules (no upstream counterpart). Each is backed by a delta entry
 * in README.md's FORK DRIFT note.
 */
const FORK_ONLY_FILES = [
  'cc-executor.ts', // D7 — the native/code/both ToolExecutor plugin + run_code transport
  'cc-names.ts', // CC↔harness tool-name translation
  'current-execution.ts', // execution-identity instrumentation (tools/execute listener)
  'json-schema-value.ts', // extracted value validator, re-exported by json-schema.ts
  'py-names.ts', // Python SDK renderer support (upstream hosts these in tool-executor-ptc)
  'py-render.ts',
  'py-sdk-doc.ts',
  'py-types.ts',
  'ts-types.ts',
  'types.ts', // durable tool/code-dispatch* session-event payloads + KNOWN registration
]

/** Lines that carry no behavior: pure structure left behind by an added block. */
const STRUCTURAL = new Set(['}', '})', ');', ')', '};', ']', '[', '{', '(', '});', '];', '},'])

/** Trimmed, non-empty, non-comment, non-structural code lines as a counted multiset. */
function codeLines(path: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue
    if (STRUCTURAL.has(line)) continue
    counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  return counts
}

/** Lines present on `side` in excess, after removing those covered by `other` or an allowance prefix. */
function uncovered(
  side: Map<string, number>,
  other: Map<string, number>,
  allowances: readonly string[],
  alsoCoveredBy?: Map<string, number>,
): string[] {
  const out: string[] = []
  for (const [line, count] of side) {
    const surplus = count - (other.get(line) ?? 0)
    if (surplus <= 0) continue
    if (allowances.some(prefix => line.startsWith(prefix))) continue
    const covered = alsoCoveredBy?.get(line) ?? 0
    for (let i = covered; i < surplus; i += 1) out.push(line)
  }
  return out
}

/**
 * DRIFT_ALLOWANCE: per vendored file, `why` (ties to README FORK DRIFT / the
 * migration design) plus the extra code lines each side contributes. An entry
 * covers a divergent line when it is a prefix of the line.
 */
const DRIFT_ALLOWANCE: Record<string, { why: string, forkOnly: string[], upstreamOnly: string[] }> = {
  'src/contracts.ts': {
    why: 'D2.1 — the `tools/code-dispatch-log` waterfall payload type (CodeDispatchLog)',
    forkOnly: [
      'readonly name: string',
      'readonly agent?: Agent',
      'export interface CodeDispatchLog {',
      'readonly exec: ToolExecution',
      'readonly subCallId: ToolCallId',
      'readonly isError: boolean',
      'readonly content: ContentBlock[]',
    ],
    upstreamOnly: [],
  },
  'src/events.ts': {
    why: 'D2.1 — declares the fork `tools/code-dispatch-log` waterfall',
    forkOnly: [
      "import type { ContentBlock } from '@deepseek-ai/dsh-llm'",
      "import type { CodeDispatchLog, ToolExecution",
      "'tools/code-dispatch-log'(",
    ],
    upstreamOnly: [
      "import type { ToolExecution, ToolDispatchExecution",
    ],
  },
  'src/index.ts': {
    why: 'D2.1 — reserve()/isAdmitted()/restrictableNames(), the execution-identity listener, the flat-spec registration tripwire, and the fork barrel exports',
    forkOnly: [
      "import './types.ts'",
      "import { instrumentToolExecution } from './current-execution.ts'",
      'readonly reserved: NamedEntries<undefined>',
      'this.reserved = new NamedEntries(',
      '? `tool name',
      ': `tool name',
      'return this.tools.isEmpty() && this.reserved.isEmpty()',
      "ctx.on('tools/execute',",
      'if (definition.parameters !== undefined',
      'try {',
      'assertSupportedJsonSchema(definition.parameters)',
      '} catch (error) {',
      'if (process.env.VITEST !== undefined) {',
      'throw new Error(',
      '`tool "${name}" parameters is not a supported JSON Schema',
      'this.ctx.logger.warn(',
      'if (name === RUN_CODE_NAME) {',
      'return this.layers.effect(',
      'this.ctx,',
      'reserve(name: string): () => void {',
      'throw new Error(`tool name "${RUN_CODE_NAME}" is reserved',
      'layer => layer.reserved.insert(name, undefined),',
      "{ label: 'tools.reserve()' },",
      'isAdmitted(name: string, scope?: ScopeKey): boolean {',
      'return this.layers.chainLayers(scope).every(',
      'restrictableNames(scope?: ScopeKey): ReadonlySet<string> {',
      'return this.view(scope).restrictableNames',
      'knownNames.add(name)',
      'restrictableNames.add(name)',
      'for (const { reserved } of [this.layers.global, ...layers]) {',
      'for (const name of reserved.keys()) {',
      "export { currentToolExecution } from './current-execution.ts'",
      "export { CodeRunFailedError } from './cc-executor.ts'",
      "export type { ToolPresentationMode } from './cc-executor.ts'",
      "export { CODE_DISPATCH_EVENT, CODE_DISPATCH_START_EVENT } from './types.ts'",
      "export type { CodeDispatchEventData, CodeDispatchStartEventData } from './types.ts'",
      'export {',
      'CC_TO_HARNESS_TOOLS,',
      'KNOWN_HARNESS_TOOLS,',
      'translateToolNames,',
      'ccToolAliases,',
      'ccCanonicalToolName,',
      'type ToolNameTranslationPolicy,',
      "} from './cc-names.ts'",
      "export type { JsonValue } from '@deepseek-ai/dsh-util-values'",
    ],
    upstreamOnly: [
      'return this.tools.isEmpty() && this.restrictions.isEmpty()',
    ],
  },
  'src/json-schema.ts': {
    why: 'D2.1 — `$schema`-dialect annotation tolerance and the json-schema-value.ts extraction (see EXTRACTED_FILES)',
    forkOnly: [
      '$schema?: string',
      "const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples',",
      "'$schema'])",
      "export const SCHEMA_TYPES: readonly JsonSchemaType[]",
      'export function isJsonNumber(value: unknown): value is number {',
      "if (Object.hasOwn(node, '$schema') && typeof node.$schema !== 'string') {",
      'violations.push(`${path}.$schema must be a string`)',
      "export { validateJsonSchemaValue } from './json-schema-value.ts'",
    ],
    upstreamOnly: [
      "const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])",
      'const SCHEMA_TYPES: readonly JsonSchemaType[]',
      'function isJsonNumber(value: unknown): value is number {',
    ],
  },
  'src/pipeline.ts': {
    why: 'D2.1 — the approval-seam denial copy (ask-reason hygiene + guidance tails), a documented fork divergence carried across every harness bump',
    forkOnly: [
      'const ASK_CHANNEL_GUIDANCE',
      "= 'This is an environment limitation",
      'const ASK_DENIAL_GUIDANCE',
      "= 'This is a permission decision",
      'function sanitizeAskReason(reason: string): string {',
      'const clean = reason.replace(',
      'return clean.length <= 120',
      'function askRaisedClause(ask: { reason?: string }): string {',
      'return ask.reason === undefined',
      'const reason = ask.reason === undefined',
      '? `tool "${exec.name}" requires approval (not yet supported)`',
      ': sanitizeAskReason(ask.reason)',
      'decision: { kind: \'deny\', reason: `${reason}. ${ASK_CHANNEL_GUIDANCE}` },',
      'decision: { kind: \'deny\', reason: `tool "${exec.name}" requires approval, but the call has no agent',
      'decision: { kind: \'deny\', reason: `the user rejected tool "${exec.name}"${askRaisedClause(ask)}',
      'decision: { kind: \'deny\', reason: `tool "${exec.name}" requires approval, but no approval channel',
    ],
    upstreamOnly: [
      'decision: { kind: \'deny\', reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)` },',
      'decision: { kind: \'deny\', reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through` },',
      'decision: { kind: \'deny\', reason: `the user rejected tool "${exec.name}"` },',
      'decision: { kind: \'deny\', reason: `tool "${exec.name}" requires approval, but no approval channel is available` },',
    ],
  },
}

/** Vendored file → fork-only module(s) whose code lines cover its upstream-only lines (an extraction). */
const EXTRACTED_FILES: Record<string, string[]> = {
  // Upstream inlines the value validator; the fork carries it in its own module
  // and re-exports it, so every inline upstream line must exist there verbatim.
  'src/json-schema.ts': ['json-schema-value.ts'],
}

describe('tools fork drift (harness 0.2.2-rc.1)', () => {
  it('vendors exactly the documented file set', () => {
    const forkFiles = readdirSync(FORK_SRC).filter(name => name.endsWith('.ts')).sort()
    const expected = [...PAIRS.map(name => `${name}.ts`), ...FORK_ONLY_FILES].sort()
    expect(forkFiles).toEqual(expected)
  })

  it.each(PAIRS)('%s.ts differs from upstream only by its documented delta', (name) => {
    const forkPath = join(FORK_SRC, `${name}.ts`)
    const upstreamPath = upstreamSrc(`${name}.ts`)
    expect(existsSync(upstreamPath), `missing upstream ${name}.ts — the checkout is not at the pin`).toBe(true)
    const key = `src/${name}.ts`
    const allowance = DRIFT_ALLOWANCE[key] ?? { why: 'no delta', forkOnly: [], upstreamOnly: [] }
    const forkMultiset = codeLines(forkPath)
    const upstreamMultiset = codeLines(upstreamPath)
    const extracted = new Map<string, number>()
    for (const extraFile of EXTRACTED_FILES[key] ?? []) {
      for (const [line, count] of codeLines(join(FORK_SRC, extraFile))) {
        extracted.set(line, (extracted.get(line) ?? 0) + count)
      }
    }
    const forkOnly = uncovered(forkMultiset, upstreamMultiset, allowance.forkOnly)
    const upstreamOnly = uncovered(upstreamMultiset, forkMultiset, allowance.upstreamOnly, extracted)
    expect({ why: allowance.why, forkOnly, upstreamOnly }).toEqual({ why: allowance.why, forkOnly: [], upstreamOnly: [] })
  })
})
