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

// CC-only files (no upstream counterpart) — each backed by a DIVERGENCE.md entry.
const CC_ONLY_FILES = [
  'src/version.ts', // divergence 6
  'tests/branding.spec.ts', // divergence 9
  'tests/preset-composition.spec.ts', // divergence 9
  'tests/upstream-drift.spec.ts', // this gate itself
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
    why: 'DIVERGENCE.md 1, 2, 3, 6 — plugin name, preset seam wiring (ctx.get roster, NOT inject: cordis re-composes injected services in this scope and double-registers the roster — live-acceptance finding 2026-10-09), presetId config, agentInfo branding, preset-registry type-only augmentation',
    ccOnly: [
      '// Type-only: declaration-merges',
      'import type {}',
      'import { AcpSession, type AcpPresetsService }',
      'import { readOwnVersion }',
      "export const name = 'acp-cc'",
      '// Inject deliberately mirrors the upstream set WITHOUT',
      '// cordis re-composes an injected service in this plugin',
      '// re-applies the preset-cc row and double-registers the roster',
      '// finding, 2026-10-09). The roster is resolved via ctx.get() in apply',
      '// the TUI preset.ts rosterOf pattern / the upstream `subagents`',
      '/** Agent preset composed into every fresh session',
      'presetId?: string',
      "presetId: Schema.string().default('cc'),",
      '// Resolved during apply like `persistence` is captured',
      "// outside this plugin's injection scope, so a lazy ctx.get() inside a",
      '// handler could miss the service). Unlike `persistence` it is NOT',
      '// inject-declared (see the inject comment above) — plain ctx.get at apply',
      '// time reads the already-activated registry without re-composing it.',
      "const roster = ctx.get('agentPresets')",
      'if (roster === undefined) {',
      'throw new Error(',
      "'acp-cc requires an agent-preset registry in the composition",
      ')',
      '}',
      'const presets: AcpPresetsService = roster',
      "const presetId = config.presetId ?? 'cc'",
      "agentInfo: { name: 'dsh-cc', version: await readOwnVersion() },",
      '// The preset composition itself happens',
      '// setup — preset → model control → MCP (§5.2, TUI driver.ts order).',
      "// plugin's injection scope, and the preset roster is composed into every",
      '// session in setup (§5.2).',
      '// composes (§5.2); the runtime service arrives via bundle composition and is',
      '// read with ctx.get() — never inject (see the inject comment).',
      'presetId,',
      'presets,',
      '// §5.2 revised (live acceptance 2026-10-09): join stamped agents via the',
      '// serial `agent/created` event + registry select() instead of mounting in',
      '// the create setup. Guards: only agents whose frozen session header',
      '// records OUR presetId (the create stamp — subagent forks inherit the same',
      '// stamp but arrive already composed via child-agent parentage and are',
      '// skipped), and only agents not already bound. Select appends the',
      '// model-visible `agent-preset/selected` event; the serial event awaits the',
      '// join before the create call returns (no first-prompt race — the P2b',
      '// probe verified this form live).',
      "const joinPresetId = config.presetId ?? 'cc'",
      "ctx.on('agent/created', (payload: { agent?: unknown }) => {",
      'const agent = payload?.agent as',
      '| { session?: { header?: { agentPreset?: string } }; ctx?: Context }',
      '| undefined',
      'const stamped = agent?.session?.header?.agentPreset',
      'if (stamped !== joinPresetId || agent?.ctx === undefined) return undefined',
      'if (presets.composedPreset(agent.ctx) !== undefined) return undefined',
      'return presets',
      '.select(agent as never, joinPresetId)',
      '.then(() => undefined)',
      '.catch((error: unknown) => {',
      '`acp-cc failed to join preset ${joinPresetId}',
      'if (typeof stamped !== \'string\' || stamped === \'\' || agent?.ctx === undefined) return undefined',
      '.select(agent as never, stamped)',
      '`acp-cc failed to join preset ${stamped}',
      '// Join the RECORDED stamp (create stamps config.presetId; resumed',
      '// sessions carry their original stamp) — presetless agents are skipped.',
      "const app = createAcpAgentApp({ name: 'dsh-cc' })",
    ],
    upstreamOnly: [
      "export const name = 'acp'",
      'import { AcpSession }',
      "agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },",
      '// No preset composition:',
      '// the host plane, so this agent reads them from the global layer. A',
      '// deployment that configures a roster has to join one here first',
      '// (@deepseek-ai/dsh-agent-preset-registry README, "Composing a child agent").',
      'meta: { cwd: options.cwd',
      "const app = createAcpAgentApp({ name: 'deepseek-harness-acp' })",
    ],
  },
  'src/session.ts': {
    why: 'DIVERGENCE.md 2, 4, 5 — presets seam, create meta stamp + setup order, resume projection mount',
    // ponytail: bare '}' and '},' entries are scoped to this file's allowance
    // only and cover the AcpPresetsService interface / mount callback braces.
    ccOnly: [
      '/** The preset-registry seam',
      'export interface AcpPresetsService {',
      'mount(agentCtx: Context, presetId?: string): Promise<unknown>',
      '/** Compose a preset into a published agent, appending `agent-preset/selected`. */',
      'select(agent: Agent, presetId: string): Promise<string>',
      '/** The preset a live agent already uses, if bound. */',
      'composedPreset(ctx: Context): string | undefined',
      '}',
      'presets: AcpPresetsService',
      '/** Agent preset composed into this session',
      'presetId: string',
      '// §5.2',
      '// records the composed preset identity (frozen creation fact, copied',
      '// into the header by agents.create — core/session/src/index.ts:1058).',
      '// §5.2, revised after live acceptance (2026-10-09): the preset join',
      '// runs on the serial `agent/created` event (index.ts) for resumed',
      '// agents too — it joins the RECORDED header stamp, so a presetless',
      '// session stays presetless and an unrecorded id fails loudly',
      '// through select(). Resume therefore only re-installs model control',
      '// and MCP here.',
      '// moved OUT of the create setup — mount() inside setup double-applies',
      '// the roster rows in the composed profile (persona/command',
      '// double-registration surfacing at session/new). The join now runs',
      '// on the serial `agent/created` event via registry select() in',
      '// index.ts (the live-verified P2b form; select also appends the',
      '// model-visible `agent-preset/selected` event). Setup keeps the',
      '// remaining order: model control, then MCP (mounts plugins',
      '// immediately, so it goes last).',
      '// the `agentPreset` session projection (registered by the preset',
      '// registry; stateOf access mirrors command-permissions/index.ts:95).',
      '// The create header is a frozen fact and ResumeAgentOptions has no',
      '// meta, so resume never re-stamps; `config.presetId` applies to fresh',
      '// creates only. Recorded null/undefined → stay presetless; a recorded',
      '// id missing from the roster throws from mount() and fails',
      '// session/resume loudly.',
      'meta: { cwd: options.cwd, agentPreset: options.presetId },',
      'await options.presets.mount(agentCtx, options.presetId)',
      "const projections = ctx.get('sessionProjections') as",
      "| { stateOf(session: Agent['session'], key: string): unknown }",
      '| undefined',
      "const recorded = projections?.stateOf(agent.session, 'agentPreset')",
      "if (typeof recorded === 'string') await options.presets.mount(agentCtx, recorded)",
    ],
    upstreamOnly: ['meta: { cwd: options.cwd'],
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
      const { ccOnly } = diffPair(
        'h1\nh2\nh3\nh4\nx\n// §5.2: deliberate CC delta\nconst b = 1\ny',
        'x\nconst b = 1\ny',
        'src/session.ts',
      )
      expect(ccOnly).toEqual([]) // covered by the '// §5.2' prefix entry
      const partial = diffPair(
        'h1\nh2\nh3\nh4\nx\n// unrelated change\nconst b = 1\ny',
        'x\nconst b = 1\ny',
        'src/session.ts',
      )
      expect(partial.ccOnly).toEqual(['// unrelated change'])
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
