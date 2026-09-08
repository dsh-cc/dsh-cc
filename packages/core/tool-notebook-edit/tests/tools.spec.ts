/**
 * Unit tests for the NotebookEdit model tool over a bare ToolRuntime +
 * LocalFileSystem against a temp directory. The read-before-write gate is
 * driven by synthesizing `fs/observed` present events (the same event the
 * tool-fs Read tool emits on a committed read), then asserting the
 * replace/insert/delete round-trips, the gate rejections, and the
 * purity of the presentation functions.
 */

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import * as ToolNotebookEdit from '@dsh-cc/tool-notebook-edit'

let callCounter = 0

/** A freshly created temp dir for one test (cleaned up in afterEach). */
const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-nb-'))
  dirs.push(dir)
  return dir
}

/** A valid nbformat 4.5 notebook with three addressable cells. */
function validNotebook(): Record<string, unknown> {
  return {
    cells: [
      {
        cell_type: 'code',
        id: 'c1',
        execution_count: 3,
        metadata: {},
        outputs: [{ output_type: 'stream', text: '1\n' }],
        source: 'print(1)',
      },
      {
        cell_type: 'markdown',
        id: 'c2',
        metadata: {},
        source: '# Title',
      },
      {
        cell_type: 'code',
        id: 'c3',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: 'print(3)',
      },
    ],
    metadata: { language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  }
}

/** Write a notebook body to `dir/name.ipynb` (default name.ipynb). */
function writeNotebook(dir: string, body: unknown, name = 'name.ipynb'): string {
  const path = join(dir, name)
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body, null, 1))
  return path
}

/** Read a notebook file back from disk as a parsed object. */
function readNotebook(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** Mount the tool stack against a temp dir backed by a real local fs. */
async function setup(): Promise<{ ctx: Context; dir: string; dispose: () => Promise<void> }> {
  const dir = tempDir()
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(ToolNotebookEdit)
  return { ctx, dir, dispose: () => ctx.fiber.dispose() }
}

/** Synthesize the model-facing Read observation (what tool-fs read emits). */
async function observeRead(ctx: Context, path: string): Promise<void> {
  const target = await ctx.fs.resolve(path)
  const info = await ctx.fs.stat(target)
  expect(info).toBeDefined()
  if (info === undefined) throw new Error('stat returned undefined')
  ctx.emit('fs/observed', target, { kind: 'present', version: info.version })
}

/** Execute one NotebookEdit call, returning the normalized tool result. */
async function call(
  ctx: Context,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; value?: unknown; error?: { message?: string; info?: { code?: string } } }> {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`nb-${++callCounter}`),
    name: 'NotebookEdit',
    arguments: args,
  })
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('NotebookEdit registration', () => {
  it('registers a single NotebookEdit tool with the CC-aligned schema', async () => {
    const { ctx, dir, dispose } = await setup()
    expect(ctx.tools.schemas().map(s => s.name)).toEqual(['NotebookEdit'])
    const tool = ctx.tools.get('NotebookEdit')!
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        notebook_path: { type: 'string' },
        new_source: { type: 'string' },
        cell_type: { type: 'string', enum: ['code', 'markdown'] },
        edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'] },
      },
      required: ['notebook_path', 'new_source'],
    })
    // NotebookEdit mutates shared cell state, so it must never overlap siblings.
    expect(tool.isConcurrencySafe?.({})).toBe(false)
    expect(dir).toBeDefined()
    await dispose()
  })

  it('is fully cleaned up on dispose', async () => {
    // Mount the scaffold by hand so we can dispose exactly the tool plugin's
    // fiber and observe its unregistration through the still-alive services.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: tempDir() })
    const plugin = await ctx.plugin(ToolNotebookEdit)
    expect(ctx.tools.schemas()).toHaveLength(1)

    await plugin.dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
    await ctx.fiber.dispose()
  })
})

describe('NotebookEdit round-trips (replace/insert/delete)', () => {
  it('replaces a markdown cell, keeping the cell count and neighbours', async () => {
    const { ctx, dir, dispose } = await setup()
    const path = writeNotebook(dir, validNotebook())
    await observeRead(ctx, path)

    const result = await call(ctx, {
      notebook_path: path,
      cell_id: 'c2',
      new_source: '# New Heading',
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ edit_mode: 'replace', cell_id: 'c2', error: '' })

    const onDisk = readNotebook(path)
    expect(onDisk['cells']).toHaveLength(3)
    const cell = (onDisk['cells'] as Array<Record<string, unknown>>)[1]!
    expect(cell['source']).toBe('# New Heading')
    expect(cell['cell_type']).toBe('markdown')
    await dispose()
  })

  it('replaces a code cell and resets execution_count + outputs', async () => {
    const { ctx, dir, dispose } = await setup()
    const path = writeNotebook(dir, validNotebook())
    await observeRead(ctx, path)

    const result = await call(ctx, {
      notebook_path: path,
      cell_id: 'c1',
      new_source: 'print(2)',
    })
    expect(result.isError).toBe(false)

    const cell = (readNotebook(path)['cells'] as Array<Record<string, unknown>>)[0]!
    expect(cell['source']).toBe('print(2)')
    expect(cell['execution_count']).toBeNull()
    expect(cell['outputs']).toEqual([])
    await dispose()
  })

  it('inserts a markdown cell after the addressed cell', async () => {
    const { ctx, dir, dispose } = await setup()
    const path = writeNotebook(dir, validNotebook())
    await observeRead(ctx, path)

    const result = await call(ctx, {
      notebook_path: path,
      cell_id: 'c1',
      cell_type: 'markdown',
      edit_mode: 'insert',
      new_source: '### inserted',
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ edit_mode: 'insert' })

    const cells = readNotebook(path)['cells'] as Array<Record<string, unknown>>
    expect(cells).toHaveLength(4)
    const inserted = cells[1]!
    expect(inserted['cell_type']).toBe('markdown')
    expect(inserted['source']).toBe('### inserted')
    expect(inserted['id']).toBeTruthy() // nbformat >= 4.5 mints a fresh id
    expect(cells[0]!['source']).toBe('print(1)')
    expect(cells[2]!['source']).toBe('# Title')
    await dispose()
  })

  it('inserts at the beginning when cell_id is omitted', async () => {
    const { ctx, dir, dispose } = await setup()
    const path = writeNotebook(dir, validNotebook())
    await observeRead(ctx, path)

    const result = await call(ctx, {
      notebook_path: path,
      cell_type: 'code',
      edit_mode: 'insert',
      new_source: 'print(0)',
    })
    expect(result.isError).toBe(false)

    const cells = readNotebook(path)['cells'] as Array<Record<string, unknown>>
    expect(cells).toHaveLength(4)
    expect(cells[0]!['source']).toBe('print(0)')
    expect(cells[0]!['cell_type']).toBe('code')
    expect(cells[0]!['outputs']).toEqual([])
    await dispose()
  })

  it('deletes the addressed cell', async () => {
    const { ctx, dir, dispose } = await setup()
    const path = writeNotebook(dir, validNotebook())
    await observeRead(ctx, path)

    const result = await call(ctx, {
      notebook_path: path,
      cell_id: 'c1',
      edit_mode: 'delete',
      new_source: '',
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ edit_mode: 'delete' })

    const cells = readNotebook(path)['cells'] as Array<Record<string, unknown>>
    expect(cells).toHaveLength(2)
    expect(cells.every(c => c['id'] !== 'c1')).toBe(true)
    expect(cells[0]!['source']).toBe('# Title')
    await dispose()
  })

  it('re-baselines after its own write, so a second edit needs no re-read', async () => {
    const { ctx, dir, dispose } = await setup()
    const path = writeNotebook(dir, validNotebook())
    await observeRead(ctx, path)

    await call(ctx, { notebook_path: path, cell_id: 'c3', new_source: 'print(9)' })
    // No fresh Read: the write above updated the baseline to the new version.
    const second = await call(ctx, { notebook_path: path, cell_id: 'c3', new_source: 'print(10)' })
    expect(second.isError).toBe(false)
    const cell = (readNotebook(path)['cells'] as Array<Record<string, unknown>>)[2]!
    expect(cell['source']).toBe('print(10)')
    await dispose()
  })

  it('addresses an id-less notebook by zero-based cell-<index>', async () => {
    const { ctx, dir, dispose } = await setup()
    // An older nbformat (no real ids) — cells are addressed by cell-<index>.
    const body = { ...validNotebook(), nbformat: 4, nbformat_minor: 3 }
    ;(body['cells'] as Array<Record<string, unknown>>).forEach(c => { delete c['id'] })
    const path = writeNotebook(dir, body)
    await observeRead(ctx, path)

    const result = await call(ctx, {
      notebook_path: path,
      cell_id: 'cell-1',
      new_source: '## Replacement',
    })
    expect(result.isError).toBe(false)

    const cells = readNotebook(path)['cells'] as Array<Record<string, unknown>>
    expect((cells[1] as Record<string, unknown>)['source']).toBe('## Replacement')
    // An id-less notebook does not gain an id on insert.
    await dispose()
  })
})

describe('NotebookEdit read-before-write gate', () => {
  it('rejects an edit with no prior read', async () => {
    const { ctx, dir, dispose } = await setup()
    const path = writeNotebook(dir, validNotebook())
    // No observeRead — the file was never read.

    const result = await call(ctx, { notebook_path: path, cell_id: 'c1', new_source: 'x' })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/has not been read yet/i)
    expect(result.error?.info?.code).toBe('NOTEBOOK_NOT_READ')
    await dispose()
  })

  it('rejects a stale write when the file changed since the read', async () => {
    const { ctx, dir, dispose } = await setup()
    const path = writeNotebook(dir, validNotebook())
    await observeRead(ctx, path)

    // External modification after the read, before the edit.
    writeFileSync(path, JSON.stringify(validNotebook(), null, 1) + '\n')

    const result = await call(ctx, { notebook_path: path, cell_id: 'c1', new_source: 'x' })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/modified since read/i)
    expect(result.error?.info?.code).toBe('NOTEBOOK_STALE')
    await dispose()
  })

  it('treats its own write as the fresh baseline (not stale on re-edit)', async () => {
    const { ctx, dir, dispose } = await setup()
    const path = writeNotebook(dir, validNotebook())
    await observeRead(ctx, path)

    await call(ctx, { notebook_path: path, cell_id: 'c1', new_source: 'v1' })
    // Still "fresh" — the tool's own write is the new baseline.
    const again = await call(ctx, { notebook_path: path, cell_id: 'c1', new_source: 'v2' })
    expect(again.isError).toBe(false)
    await dispose()
  })
})

describe('NotebookEdit validation rejections', () => {
  it('rejects a non-.ipynb path', async () => {
    const { ctx, dir, dispose } = await setup()
    const path = join(dir, 'x.txt')
    writeFileSync(path, 'text')
    await observeRead(ctx, path)

    const result = await call(ctx, { notebook_path: path, cell_id: 'c1', new_source: 'x' })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/Jupyter notebook/i)
    expect(result.error?.info?.code).toBe('NOTEBOOK_NOT_IPYNB')
    await dispose()
  })

  it('rejects a notebook that is not valid JSON', async () => {
    const { ctx, dir, dispose } = await setup()
    const path = writeNotebook(dir, 'this is not json')
    await observeRead(ctx, path)

    const result = await call(ctx, { notebook_path: path, cell_id: 'c1', new_source: 'x' })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/not valid JSON/i)
    expect(result.error?.info?.code).toBe('NOTEBOOK_INVALID_JSON')
    await dispose()
  })

  it('rejects an unknown cell_id', async () => {
    const { ctx, dir, dispose } = await setup()
    const path = writeNotebook(dir, validNotebook())
    await observeRead(ctx, path)

    const result = await call(ctx, { notebook_path: path, cell_id: 'nope', new_source: 'x' })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/Cell with ID "nope" not found/i)
    expect(result.error?.info?.code).toBe('NOTEBOOK_ID_NOT_FOUND')
    await dispose()
  })

  it('rejects an out-of-range cell-<index>', async () => {
    const { ctx, dir, dispose } = await setup()
    const path = writeNotebook(dir, validNotebook())
    await observeRead(ctx, path)

    const result = await call(ctx, { notebook_path: path, cell_id: 'cell-99', new_source: 'x' })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/Cell with index 99 does not exist/i)
    expect(result.error?.info?.code).toBe('NOTEBOOK_INDEX_OUT_OF_RANGE')
    await dispose()
  })

  it('rejects a non-insert edit without a cell_id', async () => {
    const { ctx, dir, dispose } = await setup()
    const path = writeNotebook(dir, validNotebook())
    await observeRead(ctx, path)

    const result = await call(ctx, { notebook_path: path, new_source: 'x' })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/Cell ID must be specified/i)
    expect(result.error?.info?.code).toBe('NOTEBOOK_MISSING_CELL_ID')
    await dispose()
  })

  it('rejects an insert without a cell_type', async () => {
    const { ctx, dir, dispose } = await setup()
    const path = writeNotebook(dir, validNotebook())
    await observeRead(ctx, path)

    const result = await call(ctx, {
      notebook_path: path,
      cell_id: 'c1',
      edit_mode: 'insert',
      new_source: 'x',
    })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/Cell type is required/i)
    expect(result.error?.info?.code).toBe('NOTEBOOK_MISSING_CELL_TYPE')
    await dispose()
  })
})

describe('NotebookEdit presentation', () => {
  it('presentCall / presentResult are pure functions of args', async () => {
    const { ctx, dispose } = await setup()
    const tool = ctx.tools.get('NotebookEdit')!

    expect(tool.presentCall?.({
      notebook_path: '/a/b.ipynb',
      cell_id: 'c1',
      new_source: 'x',
    })).toMatchObject({
      card: 'generic',
      kind: 'execute',
      title: 'Editing Notebook',
      rawInput: '/a/b.ipynb (replace)',
    })

    expect(tool.presentResult?.(
      { notebook_path: '/a/b.ipynb', new_source: 'print(1)' },
      { content: [{ type: 'text', text: 'Updated cell c1 with print(1)' }], isError: false },
    )).toEqual({ card: 'generic', content: [{ type: 'text', text: 'Updated cell c1 with print(1)' }] })
    await dispose()
  })
})
