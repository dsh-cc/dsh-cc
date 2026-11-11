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
  'tests/preset-roster-resolution.spec.ts', // issue #380: per-use roster + admission gate
  'tests/upstream-drift.spec.ts', // this gate itself
  // Size-budget extractions (cc-only modules, no upstream counterpart):
  // upstream rc.5 inline forms live here so index.ts ≤ 594 / session.ts ≤ 558.
  'src/lifecycle.ts', // agent/error + agent/status listeners (out of index.ts)
  'src/preset-roster.ts', // issue #380: per-use roster resolver + admission gate (out of index.ts)
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
      "// inject couples this plugin's fiber lifecycle to the registry's, so a",
      "// registry fiber restart would re-apply acp-cc and drop every live ACP",
      "// session (the sessions map is apply-scoped). The roster is resolved per",
      "// use instead (src/preset-roster.ts, issue #380). The 2026-10-09",
      "// double-registration claim predates the PR-B module-split fix and does",
      "// not reproduce; the lifecycle coupling is the standing rationale.",
      "// Join the RECORDED stamp (create stamps config.presetId; resumed",
      "// The preset composition itself happens inside AcpSession.create's",
      "// Type-only: declaration-merges the `agentPresets` roster service this plugin",
      "// composes (§5.2); the runtime service arrives via bundle composition and is",
      "// join before the create call returns (no first-prompt race — the P2b",
      "// model-visible `agent-preset/selected` event; the serial event awaits the",
      "// outside this plugin's injection scope, so a lazy ctx.get() inside a",
      "// probe verified this form live).",
      "// read with ctx.get() — never inject (see the inject comment).",
      "// records OUR presetId (the create stamp — subagent forks inherit the same",
      "// The preset composition itself happens on the serial `agent/created`",
      "// join above (§5.2); the create path only stamps the requested identity",
      "// into the frozen session header.",
      "// serial `agent/created` event + registry select() instead of mounting in",
      "// sessions carry their original stamp) — presetless agents are skipped.",
      "// setup — preset → model control → MCP (§5.2, TUI driver.ts order).",
      "// skipped), and only agents not already bound. Select appends the",
      "// stamp but arrive already composed via child-agent parentage and are",
      "// the create setup. Guards: only agents whose frozen session header",
      "// §5.2 revised (live acceptance 2026-10-09): join stamped agents via the",
      "`acp-cc failed to join preset ${stamped}: ${error instanceof Error ? error.message : String(error)}`,",
      "agentInfo: { name: 'dsh-cc', version: await readOwnVersion() },",
      "import { presetRosterResolver, settleComposition } from './preset-roster.ts'",
      "// Issue #380: the roster is resolved per use (preset-roster.ts), never",
      "// captured at apply time — the loader mounts group siblings concurrently",
      "// and an eager read raced the registry's async Service.init, killing the",
      "// ACP lane on a lost race. The join runs behind the admission gate below.",
      "const resolvePresets = presetRosterResolver(ctx, internalError)",
      "// Issue #380: session admission waits for the loader tree to settle",
      "// (preset-roster.ts) so the per-use roster read observes the registry's",
      "// final state even when a client races past an early initialize.",
      "const settle = settleComposition(ctx)",
      "// Issue #380: the roster is resolved PER USE, never at apply time. The",
      "// loader mounts group siblings concurrently (EntryGroup.update →",
      "// Promise.all) and strict ctx.get reads a LOADING sibling as undefined, so",
      "// an eager read here raced the registry's async Service.init — a lost race",
      "// threw here and killed the whole ACP lane. The join below runs behind the",
      "// admission gate (`settle`), where the registry is observably ACTIVE.",
      "// Unlike `persistence` it is NOT inject-declared (see the inject comment",
      "// above) — plain ctx.get reads the activated registry without re-composing",
      "// it, and re-reads pick up a restarted registry without re-applying us.",
      "const resolvePresets = (): AcpPresetsService => {",
      "const roster = ctx.get('agentPresets')",
      "if (presets.composedPreset(agent.ctx) !== undefined) return undefined",
      "throw internalError(",
      "return roster",
      "const presets = resolvePresets()",
      "// Issue #380: session admission waits for the loader tree to settle — the",
      "// same primitive boot() itself awaits — so the per-use roster read in the",
      "// agent/created join observes the registry's final state even when a",
      "// client races its first request past an early initialize round trip.",
      "// Absent in the in-process test rig (no loader service): a no-op there.",
      "const settle = async (): Promise<void> => {",
      "const loader = ctx.get('loader') as { await(): Promise<void> } | undefined",
      "if (loader !== undefined) await loader.await()",
      "await settle()",
      "const agent = payload?.agent as",
      "const app = createAcpAgentApp({ name: 'dsh-cc' })",
      "const presetId = config.presetId ?? 'cc'",
      "const stamped = agent?.session?.header?.agentPreset",
      "ctx.on('agent/created', (payload: { agent?: unknown }) => {",
      "export const name = 'acp-cc'",
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
    why: 'DIVERGENCE.md 11 (D4c) — an ACP config-set model/effort change is an explicit USER write: notify moa (noteUserSelection) exactly like the TUI `/model`/`/effort` paths so arming disarms/re-arms consistently across entry points',
    ccOnly: [
      // NOTE: keep every import statement on ONE line — a trailing bare from
      // keyword makes check-spec-deps mis-parse the next string literal.
      "import { installModelSelection, type Model, type ModelSelection } from '@deepseek-ai/dsh-agent'",
      "import type { Context } from '@deepseek-ai/cordis'",
      '/**',
      "* Compose one ACP session's model-control listeners in the unpublished Agent",
      '* scope: the harness switch-notice listener plus, co-located immediately after',
      '* it, the moa notice sanitizer (D4a / effective-model-truth §5.1 — the',
      '* later-with-prepend registration makes the sanitizer the OUTERMOST',
      '* `agent/pre-step` listener, publishing the frozen per-step selection before',
      "* the inner chain runs). Same co-location rule as the TUI's",
      '* `model-selection-wiring.ts`; side-effect-free when moa is unmounted.',
      '* @param agentCtx - unpublished Agent scope that consumes this selection.',
      '*/',
      "import { installModelSelectionSanitizer } from '@dsh-cc/moa/sanitizer'",
      "import { noteUserSelection } from '@dsh-cc/moa'",
      '// CC-only delta (D4a): the co-located model-selection notice sanitizer.',
      'export function installModelControl(agentCtx: Context): void {',
      'installModelSelection(agentCtx)',
      'installModelSelectionSanitizer(agentCtx)',
      '// CC-only delta (D4c, harness-0.2.2 migration): an ACP config-set model change',
      '// is an explicit USER write — notify moa exactly like the TUI `/model` path so',
      '// arming disarms (or re-arms on the boot pair) consistently across entry points.',
      '// D4c: notify moa with the exact recorded write (provider/model pair).',
      'noteUserSelection(selected)',
      'const effortSelection = await this.resolveSelection({',
      '}, signal)',
      'this.model.select(effortSelection)',
      '// D4c: an effort change is a USER write carrying the current pair too',
      '// (the driver\'s `/effort` path does the same — stale effort otherwise',
      '// survives a FailOpenServe restore).',
      'noteUserSelection(effortSelection)',
    ],
    // The upstream one-liner `this.model.select(await this.resolveSelection({`
    // is split so the recorded write can be notified to moa (D4c); both of its
    // lines therefore differ from the merged vendored pair. The upstream
    // `installModelSelection` import/spec lives in the co-located
    // `installModelControl` helper instead (D4a).
    upstreamOnly: [
      'this.model.select(await this.resolveSelection({',
      '}, signal))',
      "import { type Model, type ModelSelection } from '@deepseek-ai/dsh-agent'",
    ],
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
      "import { routeBeforeAdmission } from '@dsh-cc/moa'",
      "import { AcpModelControl, installModelControl } from './model-control.ts'",
      '// CC-only deltas (D4a/D4b): the model-control install helper (switch notice +',
      '// co-located notice sanitizer) and the moa pre-admission routing hook. Both are',
      '// side-effect-free when moa is unmounted (the sanitizer\'s runtime-state',
      '// accessors are inert, the router\'s admission entry is absent), so a moa-less',
      '// deployment is byte-equivalent.',
      '// CC-only delta (D4a): the model-control install is a co-located helper —',
      '// the harness switch-notice listener plus the moa notice sanitizer — so the',
      '// §5.1 co-location rule lives next to the selection seam it guards.',
      'installModelControl(agentCtx)',
      '// CC-only delta (D4b / D3.2): moa\'s pre-admission classification runs on',
      '// the EXACT admitted UserMessage, before the prompt splice — an ACP turn',
      '// therefore routes through the same entry-point seam the TUI uses.',
      '// Inert when moa is unmounted or disarmed.',
      'await routeBeforeAdmission(this.agent, message)',
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
      "import { installModelSelection } from '@deepseek-ai/dsh-agent'",
      "installModelSelection(agentCtx)",
      "meta: { cwd: options.cwd },",
      "return",
      "this.agent.cancel({ kind: 'user' })",
      "this.settleAfterQuiescence(inflight)",
      "void this.agent.whenIdle().then(() => { done.resolve(this.outputTail) }, done.reject)",
      "while (true) {",
      "}",
      "import { AcpModelControl } from './model-control.ts'",
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
      'import { mkdtemp, readFile, rm } from \'node:fs/promises\'',
      'import { startHttpMcpFixture }',
      "/** This package's own version",
      'const pkgVersion = (JSON.parse(await readFile',
      "agentInfo: { name: 'dsh-cc', version: pkgVersion },",
      "const fixtureServer = fileURLToPath(new URL('./fixture-server.ts', import.meta.url))",
    ],
    upstreamOnly: [
      "import { mkdtemp, rm } from 'node:fs/promises'",
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
      '} as never)',
      'ctx.sessionProjections.register(agentPresetProjectionDefinition)',
      'presetMounts,',
          "export interface LoaderGate {",
      "/** Resolves on the NEXT `loader.await()` call (re-arms after each entry). */",
      "entered: () => Promise<void>",
      "/** Release the current hold so the parked admission proceeds. */",
      "open: () => void",
      "/**",
      "/**",
      "/**",
      "/**",
      "* Install (or replace) the spy roster as the `agentPresets` service. The",
      "* rig skips the initial provide when `roster: 'absent'` \u2014 calling this",
      "* later exercises the per-use resolution contract (issue #380): the plugin",
      "* must tolerate the service missing at apply time.",
      "*/",
      "*/",
      "*/",
      "*/",
      "provideRoster: (knownPresets?: string[]) => void",
      "* Installed when `loaderGate: true` \u2014 a fake `loader` service whose",
      "* `await()` blocks until the test opens it. Drives the session-admission",
      "* boot-settlement gate deterministically (issue #380).",
      "loaderGate: LoaderGate | undefined",
      "* Skip the initial roster provide (default 'present' provides it before the",
      "* plugin mounts). 'absent' leaves `agentPresets` unprovided at apply time \u2014",
      "* the issue #380 regression shape; the test installs one via provideRoster.",
      "roster?: 'present' | 'absent'",
      "* Install a fake `loader` service with a test-controlled `await()` \u2014 the",
      "* admission gate's barrier fixture (issue #380).",
      "loaderGate?: boolean",
      "// `roster: 'absent'` defers the (one-time) provide to the test \u2014 later",
      "// calls only retarget the accepted ids, since cordis rejects a second",
      "// provide of an already-registered name (issue #380 per-use contract).",
      "const rosterState = { known: options.knownPresets ?? ['cc'] }",
      "let rosterInstalled = false",
      "const provideRoster = (knownPresets: string[] = ['cc']): void => {",
      "rosterState.known = knownPresets",
      "if (rosterInstalled) return",
      "rosterInstalled = true",
      "if (presetId === undefined || !rosterState.known.includes(presetId)) {",
      "if (!rosterState.known.includes(presetId)) {",
      "if (options.roster !== 'absent') provideRoster()",
      "// Fake loader for the admission-gate barrier: `loader.await()` resolves the",
      "// entry signal first, so a test can prove a request is parked INSIDE the",
      "// gate before any roster read; `open()` releases the current hold and",
      "// re-arms for the next admission (issue #380).",
      "let loaderGate: LoaderGate | undefined",
      "if (options.loaderGate === true) {",
      "let releaseGate!: () => void",
      "let gate = new Promise<void>((resolve) => { releaseGate = resolve })",
      "const waiters: Array<() => void> = []",
      "loaderGate = {",
      "entered: () => new Promise<void>((resolve) => { waiters.push(resolve) }),",
      "open: () => {",
      "releaseGate()",
      "gate = new Promise<void>((resolve) => { releaseGate = resolve })",
      "const enter = (): void => { waiters.shift()?.() }",
      "ctx.provide('loader', { await: async () => { enter(); await gate } } as never)",
      "provideRoster,",
      "loaderGate,",
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

/**
 * Lines that carry no code of their own: bare braces, brackets, commas and
 * semicolons. They appear in a diff whenever a block moves (this port moves
 * upstream bodies into `src/cancellation-status.ts`), and they can never be an
 * allowance ENTRY — an entry is a prefix, so a bare `}` would silently cover
 * every future upstream line that happens to start with a brace. Structural
 * lines are therefore filtered before the allowance step, and the gate stays
 * meaningful for everything that names something.
 */
function isStructural(line: string): boolean {
  return /^[{}\[\](),;]+$/.test(line)
}

function uncoveredLines(
  divergent: string[],
  allowance: string[] | undefined,
): string[] {
  const semantic = divergent.filter((line) => !isStructural(line))
  if (semantic.length === 0) return []
  // A structural ENTRY is equally inert: allowing `}` would cover every future
  // upstream line starting with a brace, so such an entry is treated as a bug
  // in the record rather than as coverage.
  const entries = (allowance ?? []).filter((entry) => !isStructural(entry))
  const covered = (line: string) => entries.some((entry) => line.startsWith(entry))
  return semantic.filter((line) => !covered(line))
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

    it('structural-only lines never need an allowance', () => {
      // A moved block leaves bare braces behind; they must not become
      // allowance entries, and must not count as drift either.
      expect(uncoveredLines(['}', '},', '});', 'const a = 1'], undefined)).toEqual(['const a = 1'])
      // A brace-prefixed ENTRY is exactly the hazard this rule removes.
      expect(uncoveredLines(['} else {'], ['}'])).toEqual(['} else {'])
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
