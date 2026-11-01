// Upstream drift gate (§4 item 3 / §6 PR-B of docs/plans/2026-10-09-acp-m2-own-plugin.md).
//
// Diff strategy (documented per the design's "practical diff implementation"
// option): multiset line diff with whitespace normalization — every file is
// reduced to its trimmed non-empty lines, compared as counted multisets in
// both directions, and each extra line (vendored-side or upstream-side) must
// be covered by a DRIFT_ALLOWANCE entry that is a prefix of the trimmed line.
// Chosen over a hunk-based LCS diff because allowances in DIVERGENCE.md are
// described as line-level changes (a rename hunk, an added block), a line
// allowlist maps 1:1 onto them, and it needs no hunk extraction to stay
// deterministic. ponytail: duplicate-only reordering (same lines, moved) is
// invisible to this diff — an LCS hunk diff would see it; upgrade if a
// migration ever reorders without changing lines.
//
// A missing sibling checkout is a HARD FAIL: drift must never read as "no
// drift". CI always has the checkout side-by-side with this repository.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const UPSTREAM_PACKAGE = 'packages/acp/acp'
const HEADER_LINES = 4
const ALLOWANCE_NOTE =
  'update DRIFT_ALLOWANCE only with review evidence (harness-migration PR)'

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
    `upstream drift gate: no sibling deepseek-harness checkout with ${UPSTREAM_PACKAGE} found next to or above this repository — ` +
      'the gate hard-fails when the checkout is missing, because a missing checkout must never read as "no drift"',
  )
}

// Vendored file (repo-relative to packages/acp/cc-acp) → upstream file
// (repo-relative to the harness checkout). Vendored files not listed here
// must appear in CC_ONLY_FILES; anything else fails the two-way coverage check.
const PAIRS: Record<string, string> = {}
for (const f of ['codec', 'content', 'index', 'mcp', 'model-control', 'session', 'updates']) {
  PAIRS[`src/${f}.ts`] = `${UPSTREAM_PACKAGE}/src/${f}.ts`
}
for (const f of [
  'approval', 'bridge', 'codec', 'content', 'dispose', 'edges', 'mcp',
  'model-control', 'multi-session', 'turns', 'updates',
]) {
  PAIRS[`tests/${f}.spec.ts`] = `${UPSTREAM_PACKAGE}/tests/${f}.spec.ts`
}
PAIRS['tests/harness.ts'] = `${UPSTREAM_PACKAGE}/tests/harness.ts`
PAIRS['tests/fixture-server.ts'] = 'packages/mcp/mcp-client/tests/fixture-server.ts'
PAIRS['tests/http-fixture.ts'] = 'packages/mcp/mcp-client/tests/http-fixture.ts'
PAIRS['tests/working-directory-fixture.ts'] = 'packages/subagent/subagent/tests/working-directory-fixture.ts'
PAIRS['tests/mock-adapter.ts'] = 'packages/core/agent-loop/tests/mock-adapter.ts'

// CC-only files (no upstream counterpart) — each backed by a DIVERGENCE.md entry.
const CC_ONLY_FILES = [
  'src/version.ts', // divergence 6
  'tests/branding.spec.ts', // divergence 9
  'tests/preset-composition.spec.ts', // divergence 9
  'tests/upstream-drift.spec.ts', // this gate itself
  // Size-budget extractions (cc-only modules, no upstream counterpart):
  // upstream rc.5 inline forms live here so index.ts ≤ 594 / session.ts ≤ 558.
  'src/lifecycle.ts', // agent/error + agent/status listeners (out of index.ts)
  'src/cancellation-status.ts', // rc.5 prompt settlement (out of session.ts)
]

// DRIFT_ALLOWANCE: per vendored file, `why` (ties to DIVERGENCE.md) plus the
// exact extra lines each side contributes. An entry covers a divergent line
// when it is a prefix of the trimmed line (so one entry can cover a
// multi-line comment block or a renamed import path family).
const DRIFT_ALLOWANCE: Record<
  string,
  { why: string; ccOnly: string[]; upstreamOnly: string[] }
> = {
    'src/index.ts': {
    why: 'DIVERGENCE.md 1, 2, 3, 6 — plus the agent/error + agent/status registrations, which live verbatim in src/lifecycle.ts.',
    ccOnly: [
      "'acp-cc requires an agent-preset registry in the composition (the cc-acp profile provides it via @dsh-cc/bundle-acp row B)',",
      ")",
      ".catch((error: unknown) => {",
      ".select(agent as never, stamped)",
      ".then(() => undefined)",
      "/** Agent preset composed into every fresh session (§5.2). */",
      "// Inject deliberately mirrors the upstream set WITHOUT 'agentPresets':",
      "// Join the RECORDED stamp (create stamps config.presetId; resumed",
      "// Resolved during apply like `persistence` is captured (ACP handlers run",
      "// The preset composition itself happens inside AcpSession.create's",
      "// Type-only: declaration-merges the `agentPresets` roster service this plugin",
      "// composes (§5.2); the runtime service arrives via bundle composition and is",
      "// cordis re-composes an injected service in this plugin's own scope, which",
      "// finding, 2026-10-09). The roster is resolved via ctx.get() in apply instead —",
      "// handler could miss the service). Unlike `persistence` it is NOT",
      "// inject-declared (see the inject comment above) — plain ctx.get at apply",
      "// join before the create call returns (no first-prompt race — the P2b",
      "// model-visible `agent-preset/selected` event; the serial event awaits the",
      "// outside this plugin's injection scope, so a lazy ctx.get() inside a",
      "// probe verified this form live).",
      "// re-applies the preset-cc row and double-registers the roster (live-acceptance",
      "// read with ctx.get() — never inject (see the inject comment).",
      "// records OUR presetId (the create stamp — subagent forks inherit the same",
      "// serial `agent/created` event + registry select() instead of mounting in",
      "// sessions carry their original stamp) — presetless agents are skipped.",
      "// setup — preset → model control → MCP (§5.2, TUI driver.ts order).",
      "// skipped), and only agents not already bound. Select appends the",
      "// stamp but arrive already composed via child-agent parentage and are",
      "// the TUI preset.ts rosterOf pattern / the upstream `subagents` duck-type.",
      "// the create setup. Guards: only agents whose frozen session header",
      "// time reads the already-activated registry without re-composing it.",
      "// §5.2 revised (live acceptance 2026-10-09): join stamped agents via the",
      "`acp-cc failed to join preset ${stamped}: ${error instanceof Error ? error.message : String(error)}`,",
      "agentInfo: { name: 'dsh-cc', version: await readOwnVersion() },",
      "const agent = payload?.agent as",
      "const app = createAcpAgentApp({ name: 'dsh-cc' })",
      "const presetId = config.presetId ?? 'cc'",
      "const presets: AcpPresetsService = roster",
      "const roster = ctx.get('agentPresets')",
      "const stamped = agent?.session?.header?.agentPreset",
      "ctx.on('agent/created', (payload: { agent?: unknown }) => {",
      "export const name = 'acp-cc'",
      "if (presets.composedPreset(agent.ctx) !== undefined) return undefined",
      "if (roster === undefined) {",
      "if (typeof stamped !== 'string' || stamped === '' || agent?.ctx === undefined) return undefined",
      "import type {} from '@deepseek-ai/dsh-agent-preset-registry'",
      "import { AcpSession, type AcpPresetsService } from './session.ts'",
      "import { installAgentLifecycleListeners } from './lifecycle.ts'",
      "import { readOwnVersion } from './version.ts'",
      "installAgentLifecycleListeners(ctx, ownedRecord)",
      "presetId,",
      "presetId: Schema.string().default('cc'),",
      "presetId?: string",
      "presets,",
      "return presets",
      "throw new Error(",
      "| undefined",
      "| { session?: { header?: { agentPreset?: string } }; ctx?: Context }",
      "}",
    ],
    upstreamOnly: [
      "// (@deepseek-ai/dsh-agent-preset-registry README, \"Composing a child agent\").",
      "// No preset composition: the ACP bundle keeps the model-facing rows in",
      "// deployment that configures a roster has to join one here first",
      "// the host plane, so this agent reads them from the global layer. A",
      "agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },",
      "const app = createAcpAgentApp({ name: 'deepseek-harness-acp' })",
      "ctx.on('agent/error', ({ agent, error }) => {",
      "ctx.on('agent/status', ({ agent, status }) => {",
      "export const name = 'acp'",
      "import { AcpSession } from './session.ts'",
      "ownedRecord(agent)?.onAgentError(error)",
      "ownedRecord(agent)?.onAgentStatus(status)",
    ],
  },
  'src/model-control.ts': {
    why: 'CC-only (not upstream drift): co-located model-selection notice sanitizer registration (dsh-cc effective-model-truth PR-1, design §5.1) immediately after the installModelSelection call',
    ccOnly: [
      // NOTE: keep the import statement on ONE line — a trailing bare from
      // keyword makes check-spec-deps mis-parse the next string literal.
      "import { installModelSelectionSanitizer } from '@dsh-cc/moa/sanitizer'",
      '// Co-located sanitizer (effective-model-truth §5.1): later-with-prepend →',
      '// outermost agent/pre-step listener; drops phantom model-selection notices',
      '// while moa overlays the boot selection.',
      'installModelSelectionSanitizer(agentCtx, this.selection)',
    ],
    upstreamOnly: [],
  },
    'src/session.ts': {
    why: 'DIVERGENCE.md 1, 2, 3, 6 — upstream bodies extracted verbatim into src/cancellation-status.ts to hold the 558-line size budget; the upstreamOnly entries are exactly the lines that moved.',
    ccOnly: [
      "/** Agent preset composed into this session and stamped into its header. */",
      "/** Compose a preset into a published agent, appending `agent-preset/selected`. */",
      "/** The preset a live agent already uses, if bound. */",
      "/** The preset-registry seam composed into every ACP session (§5.2). */",
      "// select() (index.ts); setup order: model control, then MCP (last).",
      "// §5.2 revised 2026-10-09: the preset join runs on agent/created via",
      "// §5.2: resume's preset join also runs on agent/created (index.ts).",
      "// §5.2: the frozen create header records the composed preset identity.",
      "await awaitQuiescence(this.agent, subagents, inflight, () => this.outputTail)",
      "composedPreset(ctx: Context): string | undefined",
      "export interface AcpPresetsService {",
      "if (inflight === undefined) return",
      "import { awaitQuiescence, noteAgentError, requestPromptCancellation, settleCancelledOnStatus } from './cancellation-status.ts'",
      "meta: { cwd: options.cwd, agentPreset: options.presetId },",
      "mount(agentCtx: Context, presetId?: string): Promise<unknown>",
      "noteAgentError(inflight, errorChain(error), () => this.settleAfterQuiescence(inflight))",
      "presetId: string",
      "presets: AcpPresetsService",
      "requestPromptCancellation(this.agent, inflight, detail, () => this.settleAfterQuiescence(inflight), () => this.outputTail)",
      "select(agent: Agent, presetId: string): Promise<string>",
      "settleCancelledOnStatus(inflight, status, this.outputTail)",
    ],
    upstreamOnly: [
      "// A later committed turn/end supersedes this live failure. Failed turn",
      "// Maintenance remains publicly idle; its next running transition belongs",
      "// Plugin disposal can detach status observers before this activity retires.",
      "// start/end appends have no terminal record and keep the failure observable.",
      "// to work released after the maintenance task finished.",
      "await Promise.race([this.agent.whenIdle(), cancelled])",
      "await this.outputTail",
      "const cancelled = inflight.cancellationDone.promise",
      "const children = await Promise.race([subagents?.waitForChildren(this.agent), cancelled])",
      "const done = inflight.cancellationDone",
      "const firstCancellation = !inflight.admissionController.signal.aborted",
      "const idleAt = (seq: Session['seq']): boolean => this.agent.status === 'idle' && this.agent.session.seq === seq",
      "const idleSeq = this.agent.session.seq",
      "const isCancelled = (): boolean => inflight.admissionController.signal.aborted",
      "if (!inflight.messageQueued) {",
      "if (children || !idleAt(idleSeq)) continue",
      "if (firstCancellation) inflight.cancelStartedIdle = this.agent.status === 'idle'",
      "if (firstCancellation) {",
      "if (inflight === undefined || !inflight.messageQueued || !inflight.admissionController.signal.aborted) return",
      "if (inflight === undefined || !inflight.messageQueued) return",
      "if (isCancelled() || idleAt(idleSeq)) break",
      "if (isCancelled()) await cancelled",
      "if (isCancelled()) break",
      "if (status === 'idle' || inflight.cancelStartedIdle) inflight.cancellationDone.resolve(this.outputTail)",
      "inflight.admissionController.abort(new Error(detail))",
      "inflight.agentError = new Error(errorChain(error))",
      "inflight.cancellationDone.resolve()",
      "meta: { cwd: options.cwd },",
      "return",
      "this.agent.cancel({ kind: 'user' })",
      "this.settleAfterQuiescence(inflight)",
      "void this.agent.whenIdle().then(() => { done.resolve(this.outputTail) }, done.reject)",
      "while (true) {",
      "}",
    ],
  },
  'tests/turns.spec.ts': {
    why: 'local fixture copies (the fixture-server.ts/http-fixture.ts precedent): the delegation suite imports mountWorkingDirectoryFixture and toolCallResponse from vendored fixture copies instead of cross-package relative paths',
    ccOnly: [
      "import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'",
      "import { toolCallResponse } from './mock-adapter.ts'",
    ],
    upstreamOnly: [
      "import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'",
      "import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'",
    ],
  },
  'tests/bridge.spec.ts': {
    why: 'DIVERGENCE.md 7 — agentInfo assertion + package-local fixture paths',
    ccOnly: [
      'import { readFile }',
      'import { startHttpMcpFixture }',
      "/** This package's own version",
      'const pkgVersion = (JSON.parse(await readFile',
      "agentInfo: { name: 'dsh-cc', version: pkgVersion },",
      "const fixtureServer = fileURLToPath(new URL('./fixture-server.ts', import.meta.url))",
    ],
    upstreamOnly: [
      "import { startHttpMcpFixture } from '../../../mcp/mcp-client/tests/http-fixture.ts'",
      "agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },",
      "const fixtureServer = fileURLToPath(new URL('../../../mcp/mcp-client/tests/fixture-server.ts', import.meta.url))",
    ],
  },
  'tests/harness.ts': {
    why: 'DIVERGENCE.md 8 — spy agentPresets roster + preset projection registration',
    ccOnly: [
      'import { agentPresetProjectionDefinition }',
      '/** Agent presets the bridge composed',
      'presetMounts: { presetId: string | undefined }[]',
      '/** Preset ids the spy roster accepts',
      'knownPresets?: string[]',
      '// Spy preset roster',
      '// the bridge tests only need mount observability, so a recording stub with',
      '// the real projection registered stands in.',
      '// The registry registers this projection',
      '// registers the definition directly so resume reads the recorded identity',
      '// exactly as the composed bundle does (§5.2).',
      '}',
      'const presetMounts: { presetId: string | undefined }[] = []',
      'const composedAgents = new WeakSet<object>()',
      '// §5.2 revised: the create-path join runs on agent/created + select()',
      '// (see src/index.ts). The spy records the join like a mount and dedupes',
      '// by agent; composedPreset reports nothing pre-composed so the',
      "// listener's already-composed guard always proceeds in tests.",
      'select: async (agent: object, presetId: string) => {',
      'if (!knownPresets.includes(presetId)) {',
      'if (!composedAgents.has(agent)) {',
      'composedAgents.add(agent)',
      'return presetId',
      'composedPreset: () => undefined,',
      '// The real SubagentRuntime unconditionally inherits a parent preset via',
      '// composeFrom (upstream child-agent.ts:200); the spy composes nothing,',
      '// so delegation-test children run preset-free.',
      'composeFrom: () => undefined,',
      "const knownPresets = options.knownPresets ?? ['cc']",
      "ctx.provide('agentPresets', {",
      'mount: async (_agentCtx: unknown, presetId?: string) => {',
      'if (presetId === undefined || !knownPresets.includes(presetId)) {',
      'throw new Error(`Unknown agent preset:',
      'presetMounts.push({ presetId })',
      '},',
      '} as never)',
      'ctx.sessionProjections.register(agentPresetProjectionDefinition)',
      'presetMounts,',
    ],
    upstreamOnly: [],
  },
}


// ── pure diff helpers (shared by the gate and the bite tests below) ──

function normalize(source: string, stripHeader: boolean): string[] {
  const lines = source.split('\n')
  if (stripHeader) lines.splice(0, HEADER_LINES)
  return lines.map((l) => l.trim()).filter((l) => l !== '')
}

function multisetDiff(cc: string[], upstream: string[]): {
  ccOnly: string[]
  upstreamOnly: string[]
} {
  const counts = new Map<string, number>()
  for (const line of cc) counts.set(line, (counts.get(line) ?? 0) + 1)
  for (const line of upstream) counts.set(line, (counts.get(line) ?? 0) - 1)
  const ccOnly: string[] = []
  const upstreamOnly: string[] = []
  for (const [line, n] of counts) {
    for (let i = 0; i < n; i++) ccOnly.push(line)
    for (let i = 0; i < -n; i++) upstreamOnly.push(line)
  }
  return { ccOnly, upstreamOnly }
}

function uncoveredLines(
  divergent: string[],
  allowance: string[] | undefined,
): string[] {
  if (divergent.length === 0) return []
  const covered = (line: string) =>
    (allowance ?? []).some((entry) => line.startsWith(entry))
  return divergent.filter((line) => !covered(line))
}

function diffPair(
  vendoredSource: string,
  upstreamSource: string,
  file: string,
): { ccOnly: string[]; upstreamOnly: string[] } {
  const { ccOnly, upstreamOnly } = multisetDiff(
    normalize(vendoredSource, true),
    normalize(upstreamSource, false),
  )
  const allowance = DRIFT_ALLOWANCE[file]
  return {
    ccOnly: uncoveredLines(ccOnly, allowance?.ccOnly),
    upstreamOnly: uncoveredLines(upstreamOnly, allowance?.upstreamOnly),
  }
}

// ── the gate ──

describe('upstream drift gate (vendored @dsh-cc/acp vs deepseek-harness)', () => {
  const harnessRoot = findHarnessRoot()

  it('two-way file coverage: no added or deleted files on either side', () => {
    const messages: string[] = []
    const vendoredRoot = fileURLToPath(new URL('../', import.meta.url))
    for (const side of ['src', 'tests'] as const) {
      const vendoredFiles = readdirSync(join(vendoredRoot, side)).filter((f) =>
        f.endsWith('.ts'),
      )
      for (const f of vendoredFiles) {
        const key = `${side}/${f}`
        if (!PAIRS[key] && !CC_ONLY_FILES.includes(key)) {
          messages.push(`vendored-only file not registered anywhere: ${key}`)
        }
      }
      for (const [vendored, upstream] of Object.entries(PAIRS)) {
        if (!vendored.startsWith(`${side}/`)) continue
        if (!existsSync(join(vendoredRoot, vendored))) {
          messages.push(`paired vendored file missing: ${vendored}`)
        }
        if (!existsSync(join(harnessRoot, upstream))) {
          messages.push(
            `upstream counterpart missing in ${UPSTREAM_PACKAGE}: ${upstream} (pair of ${vendored})`,
          )
        }
      }
      const upstreamDir = side === 'src' ? 'src' : 'tests'
      const upstreamFiles = readdirSync(
        join(harnessRoot, UPSTREAM_PACKAGE, upstreamDir),
      ).filter((f) => f.endsWith('.ts'))
      const expectedUpstream = Object.entries(PAIRS)
        .filter(([vendored]) => vendored.startsWith(`${side}/`))
        .map(([, upstream]) => upstream.split('/').pop())
      for (const f of upstreamFiles) {
        if (!expectedUpstream.includes(f)) {
          messages.push(`upstream-only file not vendored: ${upstreamDir}/${f}`)
        }
      }
    }
    expect(
      messages,
      `vendored port and upstream ${UPSTREAM_PACKAGE} disagree on the file set:\n${messages.join('\n')}`,
    ).toEqual([])
  })

  for (const [file, upstream] of Object.entries(PAIRS)) {
    it(`vendored ${file} matches upstream ${upstream} within DRIFT_ALLOWANCE`, () => {
      const vendoredSource = readFileSync(
        fileURLToPath(new URL(`../${file}`, import.meta.url)),
        'utf8',
      )
      const upstreamSource = readFileSync(
        join(harnessRoot, upstream),
        'utf8',
      )
      const { ccOnly, upstreamOnly } = diffPair(vendoredSource, upstreamSource, file)
      const report = [
        ...ccOnly.map((line) => `  cc-only line: ${line}`),
        ...upstreamOnly.map((line) => `  upstream-only line: ${line}`),
      ]
      expect(
        report,
        `${file} drifted from upstream ${upstream} in ${report.length} unlisted line(s); ` +
          `${ALLOWANCE_NOTE} — or fold the upstream change into the vendored port`,
      ).toEqual([])
    })
  }

  describe('gate bites on synthetic drift', () => {
    it('flags a changed line absent from the allowance', () => {
      const { ccOnly, upstreamOnly } = diffPair(
        'h1\nh2\nh3\nh4\nx\nconst a = 1\ny',
        'x\nconst a = 2\ny',
        'src/codec.ts', // no allowance entry: identical upstream
      )
      expect(upstreamOnly).toEqual(['const a = 2'])
      expect(ccOnly).toEqual(['const a = 1'])
    })

    it('an allowance entry covers only matching prefixes', () => {
      // Exercised on a local allowance: the real per-file entries are a
      // generated record, so the property under test must not depend on them.
      expect(uncoveredLines(['// §5.2: deliberate CC delta', 'const b = 1'], ['// §5.2'])).toEqual(['const b = 1'])
      expect(uncoveredLines(['// unrelated change'], ['// §5.2'])).toEqual(['// unrelated change'])
    })

    it('duplicate-count drift is caught (multiset, not set)', () => {
      const { ccOnly } = diffPair(
        'h1\nh2\nh3\nh4\nx\nfoo()\nfoo()\ny',
        'x\nfoo()\ny',
        'src/codec.ts',
      )
      expect(ccOnly).toEqual(['foo()'])
    })
  })
})
