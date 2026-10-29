/**
 * CI tool-schema regression gate (design §F.2.1 + §F.2.2).
 *
 * Every first-party package that registers model-facing tools is mounted
 * against a capture registry and every captured tool definition is asserted
 * to carry a valid, non-degenerate JSON Schema `parameters` — the class of
 * bug PR #262 fixed (a flat spec that degraded silently to `{}` on the
 * model side). A coverage check walks every package src file for the
 * registration call patterns and fails when any file gains or loses a call,
 * including new entry points inside an existing package.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { findUncoveredToolSources } from './tool-schema-discovery.ts'
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
import { syncResources } from '../../../mcp/mcp-client/src/resources.ts'
import { createRunCodeTool } from '../src/code-mode.ts'
// Not in tsconfig.base paths — imported via relative src path (see report).
import { defineHandoffGetTool, defineHandoffPutTool, HandoffLedger, HandoffStore } from '../../../subagent/handoff-store/src/index.ts'
import ContextCrusher from '../../../context/context-crusher/src/index.ts'

/** Tools that genuinely take no arguments (empty `parameters.properties`). */
const NO_ARG_TOOLS = new Set(['worker_tasks', 'mcp__schema_gate__list_mcp_resources'])

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
    packageName: '@dsh-cc/mcp-client',
    registerFn: 'syncResources',
    mount: (seam) => {
      const disposers = syncResources({} as never, fakeContext(seam), 'schema_gate')
      expect(disposers.size).toBe(2)
    },
  },
  {
    packageName: '@dsh-cc/tools',
    registerFn: 'createRunCodeTool',
    mount: (seam) => {
      seam.captured.push(createRunCodeTool({} as never, {
        requireRuntime: () => { throw new Error('schema gate must not execute code') },
        peekRuntime: () => undefined,
        maxParallel: 1,
        shapeDispatchLog: async () => [],
      }))
    },
  },
]

/** Exact AST call counts, not a package allowlist. Review mounts and expected
 * tool names whenever a count changes. Exclusions are limited to these files.
 * Both defineTool and tools.register calls count (including nested calls).
 */
const TOOL_SOURCE_CALLS: Record<string, number> = {
  'packages/context/context-crusher/src/index.ts': 2,
  'packages/core/tool-manage-skill/src/index.ts': 2,
  'packages/core/tool-notebook-edit/src/index.ts': 2,
  'packages/core/tool-search/src/index.ts': 2,
  'packages/core/tool-sleep/src/index.ts': 2,
  'packages/core/tool-structured-output/src/index.ts': 1,
  'packages/core/tool-web-fetch/src/index.ts': 2,
  'packages/core/tool-workflow/src/index.ts': 2,
  'packages/core/tools/src/code-mode.ts': 1,
  // Test fixture factory; no model-facing runtime tool.
  'packages/core/tools/src/testing.ts': 1,
  'packages/interaction/vwa-argument/src/init-tool.ts': 1,
  'packages/interaction/vwa-argument/src/report-tool.ts': 1,
  'packages/interaction/vwa-argument/src/tools.ts': 10,
  // External server inputSchema passthrough only.
  'packages/mcp/mcp-client/src/defer.ts': 2,
  'packages/mcp/mcp-client/src/resources.ts': 1,
  'packages/memory/memory/src/save.ts': 2,
  'packages/subagent/coordinator/src/index.ts': 8,
  'packages/subagent/handoff-store/src/index.ts': 2,
  'packages/subagent/handoff-store/src/tools.ts': 2,
  'packages/subagent/task/src/release-agent.ts': 2,
  'packages/subagent/task/src/tool.ts': 2,
  // Scenario mock tool only.
  'packages/test-support/cache-trajectory/src/runner.ts': 1,
  // Scenario mock tools only.
  'packages/test-support/token-efficiency/src/mock-run.ts': 2,
  'packages/workspace/tool-git-worktree/src/index.ts': 4,
}

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

describe('CI tool-schema regression gate (design §F.2.1)', () => {
  it('every registration source has an explicit call-site inventory', () => {
    expect(findUncoveredToolSources(REPO_ROOT, TOOL_SOURCE_CALLS)).toEqual([])
  })

  it('covers the first-party code transport and MCP resource bridge', () => {
    const definitions = TOOL_PACKAGE_MANIFEST.flatMap(entry => {
      const seam = captureSeam()
      entry.mount(seam)
      return seam.captured
    })
    expect(definitions.map(def => def.name)).toEqual(expect.arrayContaining([
      'run_code', 'mcp__schema_gate__list_mcp_resources', 'mcp__schema_gate__read_mcp_resource',
    ]))
  })

  for (const entry of TOOL_PACKAGE_MANIFEST) {
    it(`${entry.packageName}: every mounted tool exposes a valid non-degenerate JSON Schema parameters`, () => {
      const seam = captureSeam()
      entry.mount(seam)
      // Exact per-entry tool sets detect missing mounts and dropped branches.
      expect(seam.captured.map(def => def.name).sort()).toMatchSnapshot(entry.packageName)
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
