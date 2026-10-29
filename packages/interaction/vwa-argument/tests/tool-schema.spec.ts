/**
 * Slice A regression pins (fix plan §A4): the five lane-2 tools register
 * through defineTool (compiled model-facing JSON Schema), shape rejections
 * keep the §10.1 SCHEMA_INVALID envelope, and returned envelopes validate
 * against the ported RESULT_SCHEMA.
 */
import { describe, expect, it } from 'vitest'
import { valueSchemaSpecToJsonSchema, validateJsonSchemaValue } from '@dsh-cc/tools'
import { registerArgumentTools, type ToolDefinition, type ToolDeps } from '../src/tools.ts'
import { CaptureRegistry } from '../src/sources.ts'
import { initWorkspace, uuid } from './helpers.ts'
import { BUDGET, fakeAdapter } from './review-helpers.ts'
import { RESULT_SCHEMA } from '../src/tool-input.ts'

/** Mount the tools against a fresh initialized workspace; return them by name. */
function mount(overrides: Partial<ToolDeps> = {}): { tools: Map<string, ToolDefinition>; workspace: ReturnType<typeof initWorkspace> } {
  const workspace = initWorkspace()
  const captured: ToolDefinition[] = []
  registerArgumentTools(
    { tools: { register: (definition) => captured.push(definition) } },
    {
      workspaceRoot: () => workspace.root,
      captures: new CaptureRegistry(),
      artifactTexts: new Map(),
      snapshotTexts: new Map(),
      maxEntities: 10_000,
      ...overrides,
    },
  )
  return { tools: new Map(captured.map((definition) => [definition.name, definition])), workspace }
}

/** Execute one tool call with a fresh idempotency key unless one is given. */
async function call(tool: ToolDefinition, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await tool.execute(
    { requestId: uuid(), ...args },
    { signal: new AbortController().signal },
  )) as Record<string, unknown>
}

describe('defineTool schema compilation (model-facing regression pins)', () => {
  const REQUIRED_FOUR = ['projectId', 'expectedRevision', 'requestId', 'input']
  const INIT_REQUIRED = ['requestId', 'input']
  const REPORT_REQUIRED = ['projectId', 'artifactId', 'format', 'write']

  it('every registered definition exposes a compiled object-rooted JSON Schema parameters', () => {
    const { tools } = mount()
    expect(tools.size).toBe(6)
    for (const tool of tools.values()) {
      const parameters = tool.parameters as {
        type: string
        properties: Record<string, { type?: string; required?: unknown }>
        required: string[]
      }
      // The pre-fix flat spec degraded to {} on CC-compatible backends.
      expect(parameters.type).toBe('object')
      const required = parameters.required ?? []
      if (tool.name === 'argument.report') {
        expect(parameters.properties.projectId?.type).toBe('string')
        for (const key of REPORT_REQUIRED) expect(required).toContain(key)
      } else if (tool.name === 'argument.init') {
        // Init creates the project: requestId + input only, no projectId.
        for (const key of INIT_REQUIRED) expect(required).toContain(key)
      } else {
        expect(parameters.properties.projectId?.type).toBe('string')
        for (const key of REQUIRED_FOUR) expect(required).toContain(key)
      }
      // The repo DSL's root-level `required` array must not leak into property nodes.
      for (const property of Object.values(parameters.properties)) {
        expect(property, `${tool.name} property node carries a required key`).not.toHaveProperty('required')
      }
    }
  })

  it('type-invalid payloads resolve to the §10.1 SCHEMA_INVALID envelope, never a thrown ToolArgsError', async () => {
    const { tools, workspace } = mount()
    const update = tools.get('argument.update') as ToolDefinition
    const stringRevision = await call(update, {
      projectId: workspace.projectId,
      expectedRevision: '1',
      input: { op: 'upsert', creates: [], updates: [], deletes: [] },
    })
    expect(stringRevision).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' })
    const report = tools.get('argument.report') as ToolDefinition
    const stringWrite = await call(report, {
      projectId: workspace.projectId,
      artifactId: 'art_11111111-1111-4111-8111-111111111111',
      format: 'json',
      write: 'true',
    })
    expect(stringWrite).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' })
  })

  it('Fail and Ok envelopes validate against the ported RESULT_SCHEMA (details included)', () => {
    const compiled = valueSchemaSpecToJsonSchema(RESULT_SCHEMA)
    const okShape = { ok: true, projectId: 'prj_x', revision: 2, data: { completion: 'started' } }
    const failShape = { ok: false, code: 'REVISION_CONFLICT', message: 'stale', retryable: true, details: { candidates: [] } }
    expect(validateJsonSchemaValue(compiled, okShape, '')).toEqual([])
    expect(validateJsonSchemaValue(compiled, failShape, '')).toEqual([])
    expect(validateJsonSchemaValue(compiled, { ok: true, unexpected: true }, '')).not.toEqual([])
  })

  it('a Fail-driven call and an Ok-driven call return envelope keys the schema accepts', async () => {
    const { tools, workspace } = mount()
    const update = tools.get('argument.update') as ToolDefinition
    const conflict = await call(update, {
      projectId: workspace.projectId,
      expectedRevision: 999,
      input: { op: 'upsert', creates: [], updates: [], deletes: [] },
    })
    expect(conflict).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' })
    expect(Object.keys(conflict).sort()).toEqual(['code', 'message', 'ok', 'retryable'])
    const ok = await call(update, {
      projectId: workspace.projectId,
      expectedRevision: 1,
      input: { op: 'upsert', creates: [], updates: [], deletes: [] },
    })
    expect(ok.ok).toBe(true)
    expect(Object.keys(ok).sort()).toEqual(['data', 'ok', 'projectId', 'revision'])
  })

  it('argument.review replay returns the widest running data shape (r2 residual 3)', async () => {
    const { tools, workspace } = mount({
      review: () => ({
        adapter: fakeAdapter([]),
        budget: BUDGET,
        tasks: { start: () => true, cancel: () => {}, get: () => 'running', emitProgress: () => {} },
      }),
    })
    const review = tools.get('argument.review') as ToolDefinition
    const requestId = uuid()
    const args = { projectId: workspace.projectId, expectedRevision: 1, requestId, input: { stage: 'claims' } }
    const started = await call(review, args)
    expect(started).toMatchObject({ ok: true, data: { completion: 'started' } })
    const replay = await call(review, args)
    expect(replay).toMatchObject({ ok: true, data: { completion: 'running' } })
  })
})
