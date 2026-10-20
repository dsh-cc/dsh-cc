/**
 * CI tool-schema regression gate (design §F.2.1 + §F.2.2).
 *
 * Every first-party package that registers model-facing tools is mounted
 * against a capture registry and every captured tool definition is asserted
 * to carry a valid, non-degenerate JSON Schema `parameters` — the class of
 * bug PR #262 fixed (a flat spec that degraded silently to `{}` on the
 * model side). A coverage check walks every package src file for the
 * registration call patterns and fails when a matching file's owning package
 * is missing from TOOL_PACKAGE_MANIFEST.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { assertSupportedJsonSchema, type ToolDefinition } from '@dsh-cc/tools'
import { CaptureRegistry } from '../../../interaction/vwa-argument/src/sources.ts'
import { registerArgumentTools } from '../../../interaction/vwa-argument/src/tools.ts'
import { apply as registerSleepTool } from '@dsh-cc/tool-sleep'
import { DeferredToolRegistry } from '@dsh-cc/tool-search'
import { apply as registerWebFetchTool } from '@dsh-cc/tool-web-fetch'
import { apply as registerNotebookEditTool } from '@dsh-cc/tool-notebook-edit'
import { apply as registerManageSkillTool } from '@dsh-cc/tool-manage-skill'
import { apply as registerStructuredOutputTool } from '@dsh-cc/tool-structured-output'
import { apply as registerWorkflowTool } from '@dsh-cc/tool-workflow'
import { apply as registerGitWorktreeTools } from '@dsh-cc/tool-git-worktree'
import { registerMemorySaveTool } from '@dsh-cc/memory'
import { registerTaskTool } from '../../../subagent/task/src/tool.ts'
import { registerReleaseAgentTool } from '../../../subagent/task/src/release-agent.ts'
import { installCoordinatorMode } from '@dsh-cc/coordinator'
import { publishListedTool } from '../../../mcp/mcp-client/src/defer.ts'
// Not in tsconfig.base paths — imported via relative src path (see report).
import { defineHandoffGetTool, defineHandoffPutTool, HandoffLedger, HandoffStore } from '../../../subagent/handoff-store/src/index.ts'
import ContextCrusher from '../../../context/context-crusher/src/index.ts'

/** Tools that genuinely take no arguments (empty `parameters.properties`). */
const NO_ARG_TOOLS = new Set(['worker_tasks'])

/** Capture registry shaped exactly like the runtime `ctx.tools` seam. */
interface CaptureSeam {
  captured: ToolDefinition[]
  tools: {
    register(def: ToolDefinition): () => void
    reserve(name: string): () => void
    restrict(names: unknown): () => void
    get(name: string): unknown
    view(): { restrictableNames: ReadonlySet<string> }
  }
}

function captureSeam(): CaptureSeam {
  const captured: ToolDefinition[] = []
  const noop = () => () => {}
  return {
    captured,
    tools: {
      register: (def) => {
        captured.push(def)
        return () => {}
      },
      reserve: () => () => {},
      restrict: () => () => {},
      get: () => undefined,
      view: () => ({ restrictableNames: new Set() }),
    },
  }
}

/**
 * Minimal duck-typed cordis Context: only the surface the surveyed
 * registration functions touch at mount time. Execute-time collaborators
 * (web, llm, fs, skills, subagents) are resolved lazily and never reached
 * here — the gate only registers definitions, it never calls them.
 */
function fakeContext(seam: CaptureSeam): never /* Context */ {
  const settings = { get: () => undefined, installSection: () => ({}) }
  const ctx = {
    // Cordis plugins reach the tools service both as `ctx.tools` (property
    // injection) and `ctx.get('tools')`; expose the same seam for both.
    tools: seam.tools,
    get: (name: string) => (name === 'tools' ? seam.tools : undefined),
    // cordis ctx.effect runs `execute` inside the fiber and collects
    // disposables; the gate only needs the synchronous mount side to run
    // (generator bodies are drained, yielded disposables are ignored).
    effect: (execute: (runner?: unknown) => unknown) => {
      const result = typeof execute === 'function' ? execute({ collect: () => {}, epoch: true }) : undefined
      if (result !== undefined && result !== null && typeof (result as object)[Symbol.iterator] === 'function') {
        for (const _ of result as Iterable<unknown>) void _
      }
      return () => {}
    },
    reflect: { provide: () => {}, dispose: () => {} },
    on: () => () => {},
    emit: () => {},
    inject: (names: readonly string[], cb: (sctx: unknown) => void) => {
      cb(names.includes('settings') ? { settings } : {})
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    systemPrompt: {
      section: () => ({}),
      context: () => ({}),
      getSectionOrder: () => 0,
    },
    subagents: {},
    // dshHomeFn(ctx) returns this; a temp home keeps store/ledger I/O hermetic.
    dshHomePath: (...parts: string[]) => join(home, ...parts),
  }
  return ctx as never
}

/** Temp home for mounts that touch the filesystem (crusher store, memory). */
const home = mkdtempSync(join(tmpdir(), 'tool-schema-gate-'))
afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

/** One manifest entry: how to mount a package's tools onto a capture seam. */
interface ManifestEntry {
  /** Human-readable package label, used in coverage errors. */
  packageName: string
  /** Exported registration function this entry mounts (informational). */
  registerFn: string
  mount(seam: CaptureSeam): void
  /** True when the entry asserts only registration existence (no mounted tools). */
  existenceOnly?: boolean
}

const TOOL_PACKAGE_MANIFEST: ManifestEntry[] = [
  {
    packageName: '@dsh-cc/vwa-argument',
    registerFn: 'registerArgumentTools',
    mount: (seam) => {
      registerArgumentTools(
        { tools: { register: (def) => seam.captured.push(def) } } as never,
        {
          workspaceRoot: () => '/tmp',
          captures: new CaptureRegistry(),
          artifactTexts: new Map(),
          snapshotTexts: new Map(),
          maxEntities: 10_000,
        },
      )
    },
  },
  {
    packageName: '@dsh-cc/tool-sleep',
    registerFn: 'apply',
    mount: (seam) => registerSleepTool(fakeContext(seam) as never),
  },
  {
    packageName: '@dsh-cc/tool-search',
    registerFn: 'DeferredToolRegistry.registerDeferred',
    mount: (seam) => {
      const registry = new DeferredToolRegistry(fakeContext(seam) as never)
      // A non-alwaysLoad entry triggers the lazy registration of the
      // model-facing ToolSearch tool itself (index.ts hysteresis 0→1).
      registry.registerDeferred({
        name: 'schema_gate_probe',
        description: 'Probe capability used only by the schema gate to force ToolSearch registration.',
        activate: () => () => {},
      })
    },
  },
  {
    packageName: '@dsh-cc/tool-web-fetch',
    registerFn: 'apply',
    mount: (seam) => registerWebFetchTool(fakeContext(seam) as never),
  },
  {
    packageName: '@dsh-cc/tool-notebook-edit',
    registerFn: 'apply',
    mount: (seam) => registerNotebookEditTool(fakeContext(seam) as never),
  },
  {
    packageName: '@dsh-cc/tool-manage-skill',
    registerFn: 'apply',
    mount: (seam) => registerManageSkillTool(fakeContext(seam) as never),
  },
  {
    packageName: '@dsh-cc/tool-structured-output',
    registerFn: 'apply',
    mount: (seam) =>
      registerStructuredOutputTool(fakeContext(seam) as never, {
        schema: { type: 'object', properties: { data: { type: 'string' } }, required: ['data'] },
      }),
  },
  {
    packageName: '@dsh-cc/tool-workflow',
    registerFn: 'apply',
    mount: (seam) => registerWorkflowTool(fakeContext(seam) as never),
  },
  {
    packageName: '@dsh-cc/tool-git-worktree',
    registerFn: 'apply',
    mount: (seam) => registerGitWorktreeTools(fakeContext(seam) as never),
  },
  {
    packageName: '@dsh-cc/memory',
    registerFn: 'registerMemorySaveTool',
    mount: (seam) => {
      const registered = registerMemorySaveTool(
        fakeContext(seam) as never,
        join(home, 'memory'),
        // MemorySection is only reached after a successful save; a stub is
        // enough because the gate never executes tools.
        { refresh: () => {} } as never,
      )
      expect(registered).toBeDefined()
    },
  },
  {
    packageName: '@dsh-cc/subagent-task',
    registerFn: 'registerTaskTool + registerReleaseAgentTool',
    mount: (seam) => {
      const ctx = fakeContext(seam)
      expect(registerTaskTool(ctx as never, {} as never, undefined, undefined, undefined)).toBeDefined()
      expect(registerReleaseAgentTool(ctx as never)).toBeDefined()
    },
  },
  {
    packageName: '@dsh-cc/handoff-store',
    registerFn: 'defineHandoffPutTool + defineHandoffGetTool',
    mount: (seam) => {
      const deps = {
        store: new HandoffStore(join(home, 'handoff')),
        ledger: new HandoffLedger(join(home, 'handoff-ledger.jsonl')),
        readSettings: () => undefined,
        sessionIdOf: () => 'schema-gate-session',
      }
      seam.captured.push(defineHandoffPutTool(deps), defineHandoffGetTool(deps))
    },
  },
  {
    packageName: '@dsh-cc/coordinator',
    registerFn: 'installCoordinatorMode',
    mount: (seam) => {
      const ctx = fakeContext(seam)
      installCoordinatorMode({ ctx } as never, ctx as never, {})
    },
  },
  {
    packageName: '@dsh-cc/context-crusher',
    registerFn: 'ContextCrusher (constructor registers context_retrieve)',
    mount: (seam) => {
      new ContextCrusher(fakeContext(seam) as never)
    },
  },
  {
    // MCP tools carry an external inputSchema passthrough (not first-party
    // JSON Schema authored here) — the design excludes them from the schema
    // assertions; the gate only checks the registration function exists.
    packageName: '@dsh-cc/mcp-client',
    registerFn: 'publishListedTool',
    existenceOnly: true,
    mount: () => {
      expect(typeof publishListedTool).toBe('function')
    },
  },
]

const MANIFEST_PACKAGES = new Set(TOOL_PACKAGE_MANIFEST.map((entry) => entry.packageName))

/**
 * Packages whose src files match the coverage pattern but that register no
 * first-party model-facing tool schema. Keyed by package name; each value is
 * the one-line justification recorded in the gate.
 */
const EXCLUDED_PACKAGES: Record<string, string> = {
  // The tools package's own defineTool( uses are internal machinery:
  // define-tool.ts is the compiler itself, code-mode.ts builds the run_code
  // bridge definition as a host-invoked factory (createRunCodeTool), and
  // testing.ts is the defineContentToolFixture test helper.
  '@dsh-cc/tools':
    'internal factory/utility: define-tool.ts (compiler), code-mode.ts (run_code factory), testing.ts (test fixture helper)',
  // MCP tools are external servers' inputSchema passthrough (design §F.2.2).
  '@dsh-cc/mcp-client': 'external MCP inputSchema passthrough — registration fn existence asserted in the manifest entry',
  // Test-support packages register mock tool fixtures for scenario runners,
  // never into a real runtime.
  '@dsh-cc/cache-trajectory': 'test-support mock tool fixture for cache-trajectory scenario runs',
  '@dsh-cc/token-efficiency': 'test-support mock tool fixture for token-efficiency scenario runs',
}

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** All first-party packages whose src uses defineTool(/tools.register(. */
function findToolPackages(): string[] {
  const pkgRoot = join(REPO_ROOT, 'packages')
  const offenders = new Set<string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts') || entry.name.endsWith('.d.ts')) continue
      if (!/\/src\//.test(full.slice(pkgRoot.length))) continue
      const source = readFileSync(full, 'utf8')
      if (!/\bdefineTool\(|tools\.register\(/.test(source)) continue
      const pkg = owningPackageName(full)
      if (pkg !== undefined && !MANIFEST_PACKAGES.has(pkg) && !(pkg in EXCLUDED_PACKAGES)) offenders.add(pkg)
    }
  }
  walk(pkgRoot)
  return [...offenders].sort()
}

/** Name of the nearest enclosing package.json, or undefined outside one. */
function owningPackageName(file: string): string | undefined {
  let dir = file
  for (;;) {
    const parent = join(dir, '..')
    if (parent === dir) return undefined
    dir = parent
    try {
      return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name as string
    } catch {
      // No package.json at this level; keep walking up.
    }
  }
}

describe('CI tool-schema regression gate (design §F.2.1)', () => {
  it('every first-party tool-registering package is in TOOL_PACKAGE_MANIFEST', () => {
    expect(findToolPackages(), 'package(s) not in TOOL_PACKAGE_MANIFEST').toEqual([])
  })

  for (const entry of TOOL_PACKAGE_MANIFEST) {
    it(`${entry.packageName}: every mounted tool exposes a valid non-degenerate JSON Schema parameters`, () => {
      const seam = captureSeam()
      entry.mount(seam)
      if (entry.existenceOnly) return
      expect(seam.captured.length, `${entry.packageName} registered no tools`).toBeGreaterThan(0)
      for (const definition of seam.captured) {
        const label = `${entry.packageName} tool ${definition.name}`
        expect(definition.parameters, `${label}: parameters must be defined`).toBeDefined()
        expect(definition.parameters, `${label}: parameters must not be null`).not.toBeNull()
        const parameters = definition.parameters as { type?: unknown; properties?: unknown }
        expect(parameters.type, `${label}: parameters.type must be 'object'`).toBe('object')
        if (!NO_ARG_TOOLS.has(definition.name)) {
          expect(
            parameters.properties,
            `${label}: parameters.properties must be a non-empty object (or list ${definition.name} in NO_ARG_TOOLS)`,
          ).toEqual(expect.objectContaining({}))
          expect(Object.keys(parameters.properties as object).length, `${label}: properties must not be empty`).toBeGreaterThan(0)
        }
        expect(() => assertSupportedJsonSchema(definition.parameters), `${label}: schema must pass assertSupportedJsonSchema`).not.toThrow()
      }
    })
  }
})
