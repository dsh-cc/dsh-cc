/**
 * Model-facing `NotebookEdit` tool that edits Jupyter notebook (.ipynb) cells
 * over the `ctx.fs` seam, aligned with Claude Code's NotebookEditTool: the
 * `replace` / `insert` / `delete` edit modes, `cell-<n>`-and-real-id cell
 * addressing for id-less notebooks, and a strict read-before-write gate that
 * refuses to write a notebook the model never read, or one whose file changed
 * since that read.
 *
 * ## Read-before-write gate
 *
 * CC's validateInput requires a prior Read and a fresh file before any edit.
 * This tool reproduces that over the harness observation seam: `apply()` keeps
 * a plugin-lifetime `readStates` map (path → observed {@link FsVersion}) fed by
 * the synchronous `fs/observed` event every time a model-facing read/write/edit
 * commits a present observation. On execute the tool rejects a path with no
 * observed read, rejects a path whose current `stat()` version no longer
 * matches the observed one (an external change — CC's stale mtime check), and
 * after writing re-baselines the map to the write outcome's version, so its own
 * write counts as the latest read baseline. The seam exposes an authoritative
 * opaque version token rather than an mtime; comparing that token is the seam's
 * native staleness check and is strictly stronger than CC's mtime comparison.
 * @module @dsh-cc/tool-notebook-edit
 */

import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { FsObservation, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import { defineTool } from '@dsh-cc/tools'
import type { ToolResult, ToolRunContext } from '@dsh-cc/tools'
import {
  findCellIndex,
  languageOf,
  newCellId,
  parseNotebook,
  supportsCellIds,
} from './notebook.ts'
import type { NotebookCell, NotebookContent } from './notebook.ts'
import {
  presentNotebookEditCall,
  presentNotebookEditResult,
} from './render.ts'
import type { NotebookEditArgs, NotebookEditResult } from './render.ts'

export const name = 'tool-notebook-edit'
export const inject = ['tools', 'fs']

export { presentNotebookEditCall, presentNotebookEditResult } from './render.ts'
export type { NotebookEditArgs, NotebookEditResult } from './render.ts'
export {
  findCellIndex,
  languageOf,
  newCellId,
  parseCellId,
  parseNotebook,
  supportsCellIds,
} from './notebook.ts'
export type {
  NotebookCell,
  NotebookContent,
} from './notebook.ts'

/**
 * Canonical JSON indentation for the rewritten .ipynb — a single space, the
 * same `IPYNB_INDENT = 1` CC uses when it writes a notebook back.
 */
const IPYNB_INDENT = 1

/** Stable, machine-routable code for one NotebookEdit failure. */
export type NotebookEditErrorCode =
  | 'NOTEBOOK_NOT_FOUND'
  | 'NOTEBOOK_NOT_IPYNB'
  | 'NOTEBOOK_INVALID_MODE'
  | 'NOTEBOOK_MISSING_CELL_TYPE'
  | 'NOTEBOOK_INVALID_JSON'
  | 'NOTEBOOK_MISSING_CELL_ID'
  | 'NOTEBOOK_INDEX_OUT_OF_RANGE'
  | 'NOTEBOOK_ID_NOT_FOUND'
  | 'NOTEBOOK_NOT_READ'
  | 'NOTEBOOK_STALE'

/**
 * Typed NotebookEdit failure carrying a stable code (like `FsError`), so
 * failure/retry layers can branch on the code rather than parsing messages.
 */
export class NotebookEditError extends HarnessError {
  override readonly code: NotebookEditErrorCode

  constructor(message: string, code: NotebookEditErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'NotebookEditError'
    this.code = code
  }
}

/** Plugin runtime configuration (reserved for future caps; none today). */
export interface Config {
  /** No configuration today. */
  readonly _?: never
}

/** Runtime configuration schema. */
export const Config: z<Config> = z.object({})

/**
 * Register the NotebookEdit tool and its plugin-lifetime read-state recorder.
 * A single `fs/observed` listener feeds a `readStates` map (path → observed
 * version); the tool is registered once and lives for the whole plugin mount,
 * so there is no per-call state to reconstruct. cordis auto-disposes both the
 * listener and the tool registration when the plugin's scope disposes.
 * @param ctx - active Cordis context.
 */
export function apply(ctx: Context): void {
  const readStates = new Map<string, FsVersion>()

  // Cordis auto-clears this listener on plugin dispose (the dispose contract
  // for this tool's subscription).
  ctx.on('fs/observed', (target: FsTarget, observation: FsObservation) => {
    // Synchronous recorder (must not throw: fs/observed is an emit event and a
    // throw would fail the observing tool's already-committed call). Every
    // present observation — read, write, or edit — becomes the baseline for
    // that path, matching CC's readFileState being (re)set by Read/Write/Edit.
    if (observation.kind === 'present') {
      readStates.set(target.displayPath, observation.version)
    }
  })

  ctx.tools.register(defineTool({
    name: 'NotebookEdit',
    description:
      'Replace the contents of a specific cell in a Jupyter notebook. '
      + 'Use edit_mode=insert to add a new cell after the cell specified by cell_id (or at the beginning when cell_id is omitted), '
      + 'and edit_mode=delete to remove it. Cell references address a cell by its id, '
      + 'or by its zero-based cell-<index>.',
    parameters: {
      notebook_path: {
        type: 'string',
        description:
          'The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)',
        required: true,
      },
      cell_id: {
        type: 'string',
        description:
          'The ID of the cell to edit. When inserting a new cell, the new cell will be inserted after the cell with this ID, or at the beginning if not specified.',
      },
      new_source: {
        type: 'string',
        description: 'The new source for the cell',
        required: true,
      },
      cell_type: {
        type: 'string',
        enum: ['code', 'markdown'],
        description:
          'The type of the cell (code or markdown). If not specified, it defaults to the current cell type. If using edit_mode=insert, this is required.',
      },
      edit_mode: {
        type: 'string',
        enum: ['replace', 'insert', 'delete'],
        description:
          'The type of edit to make (replace, insert, delete). Defaults to replace.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          new_source: { type: 'string', required: true },
          cell_id: { type: 'string' },
          cell_type: { type: 'string', enum: ['code', 'markdown'], required: true },
          language: { type: 'string', required: true },
          edit_mode: { type: 'string', required: true },
          error: { type: 'string', required: true },
          notebook_path: { type: 'string', required: true },
          original_file: { type: 'string', required: true },
          updated_file: { type: 'string', required: true },
        },
      },
      render: (_args: NotebookEditArgs, value: NotebookEditResult) => {
        if (value.error !== '') {
          return [{ type: 'text', text: value.error }]
        }
        switch (value.edit_mode) {
          case 'insert':
            return [{ type: 'text', text: `Inserted cell ${value.cell_id ?? ''} with ${value.new_source}` }]
          case 'delete':
            return [{ type: 'text', text: `Deleted cell ${value.cell_id ?? ''}` }]
          default:
            return [{ type: 'text', text: `Updated cell ${value.cell_id ?? ''} with ${value.new_source}` }]
        }
      },
    },
    presentCall: presentNotebookEditCall,
    presentResult: (args: unknown, result: ToolResult) =>
      presentNotebookEditResult(args, result),
    isConcurrencySafe: () => false,
    async execute(args: NotebookEditArgs, exec: ToolRunContext) {
      return editNotebook(ctx, readStates, args, exec)
    },
  }))
}

/**
 * Run one NotebookEdit call. Lives in a separate function (called from the
 * registered closure) so the whole validation → read → gate → edit → write →
 * re-baseline flow is a single testable unit.
 */
async function editNotebook(
  ctx: Context,
  readStates: Map<string, FsVersion>,
  args: NotebookEditArgs,
  exec: ToolRunContext,
): Promise<NotebookEditResult> {
  const target = await ctx.fs.resolve(args.notebook_path, { signal: exec.signal })

  // ── static validation (CC validateInput order) ────────────────────────
  if (extname(target.displayPath) !== '.ipynb') {
    throw new NotebookEditError(
      'File must be a Jupyter notebook (.ipynb file). For editing other file types, use the FileEdit tool.',
      'NOTEBOOK_NOT_IPYNB',
    )
  }
  const editMode = args.edit_mode ?? 'replace'
  if (editMode !== 'replace' && editMode !== 'insert' && editMode !== 'delete') {
    throw new NotebookEditError(
      'Edit mode must be replace, insert, or delete.',
      'NOTEBOOK_INVALID_MODE',
    )
  }
  if (editMode === 'insert' && !args.cell_type) {
    throw new NotebookEditError(
      'Cell type is required when using edit_mode=insert.',
      'NOTEBOOK_MISSING_CELL_TYPE',
    )
  }

  // ── read-before-write gate ─────────────────────────────────────────────
  // (a) no observed read → refuse; (b) file changed since that read → refuse.
  const observed = readStates.get(target.displayPath)
  if (observed === undefined) {
    throw new NotebookEditError(
      'File has not been read yet. Read it first before writing to it.',
      'NOTEBOOK_NOT_READ',
    )
  }
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) {
    throw new NotebookEditError('Notebook file does not exist.', 'NOTEBOOK_NOT_FOUND')
  }
  if (info.version !== observed) {
    throw new NotebookEditError(
      'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
      'NOTEBOOK_STALE',
    )
  }

  // ── read + parse ───────────────────────────────────────────────────────
  let content: string
  try {
    content = await ctx.fs.readText(target, exec.signal)
  } catch (error) {
    if (isNotFound(error)) {
      throw new NotebookEditError('Notebook file does not exist.', 'NOTEBOOK_NOT_FOUND')
    }
    throw error
  }
  const notebook = parseNotebook(content)
  if (notebook === null) {
    throw new NotebookEditError('Notebook is not valid JSON.', 'NOTEBOOK_INVALID_JSON')
  }

  // ── cell addressing (CC call semantics) ────────────────────────────────
  let cellIndex: number
  if (args.cell_id === undefined) {
    if (editMode !== 'insert') {
      throw new NotebookEditError(
        'Cell ID must be specified when not inserting a new cell.',
        'NOTEBOOK_MISSING_CELL_ID',
      )
    }
    cellIndex = 0 // CC defaults to inserting at the beginning.
  } else {
    const resolved = findCellIndex(notebook.cells, args.cell_id)
    if (!resolved.found) {
      const parsed = /^cell-(\d+)$/.exec(args.cell_id)
      if (parsed !== null && parsed[1] !== undefined) {
        const index = Number.parseInt(parsed[1]!, 10)
        if (!Number.isNaN(index) && index >= notebook.cells.length) {
          throw new NotebookEditError(
            `Cell with index ${index} does not exist in notebook.`,
            'NOTEBOOK_INDEX_OUT_OF_RANGE',
          )
        }
      }
      throw new NotebookEditError(
        `Cell with ID "${args.cell_id}" not found in notebook.`,
        'NOTEBOOK_ID_NOT_FOUND',
      )
    }
    cellIndex = resolved.index
    if (editMode === 'insert') cellIndex += 1 // insert after the addressed cell
  }

  // ── apply the edit ─────────────────────────────────────────────────────
  let appliedMode: 'replace' | 'insert' | 'delete' = editMode
  let insertedIndex: number | undefined
  if (appliedMode === 'insert') {
    insertedIndex = cellIndex
    spliceInsert(
      notebook,
      cellIndex,
      args.new_source,
      args.cell_type ?? 'code',
      supportsCellIds(notebook) ? newCellId() : undefined,
    )
  } else if (appliedMode === 'delete') {
    notebook.cells.splice(cellIndex, 1)
  } else {
    const targetCell = notebook.cells[cellIndex]
    if (targetCell === undefined) {
      throw new NotebookEditError(
        `Cell with index ${cellIndex} does not exist in notebook.`,
        'NOTEBOOK_INDEX_OUT_OF_RANGE',
      )
    }
    targetCell.source = args.new_source
    if (targetCell.cell_type === 'code') {
      targetCell.execution_count = null
      targetCell.outputs = []
    }
    if (args.cell_type && args.cell_type !== targetCell.cell_type) {
      targetCell.cell_type = args.cell_type
    }
  }

  // ── write back + re-baseline ───────────────────────────────────────────
  const updatedContent = JSON.stringify(notebook, null, IPYNB_INDENT)
  let outcome
  try {
    outcome = await ctx.fs.writeText(target, updatedContent, undefined, exec.signal)
  } catch (error) {
    if (isNotFound(error)) {
      throw new NotebookEditError('Notebook file does not exist.', 'NOTEBOOK_NOT_FOUND')
    }
    throw error
  }
  // This tool's write becomes the latest observed baseline (CC: write sets
  // readFileState to the post-write mtime).
  readStates.set(target.displayPath, outcome.version)

  const resultCellId =
    insertedIndex !== undefined ? notebook.cells[insertedIndex]?.id : args.cell_id
  return {
    new_source: args.new_source,
    ...(resultCellId !== undefined ? { cell_id: resultCellId } : {}),
    cell_type: args.cell_type ?? (appliedMode === 'delete'
      ? 'code'
      : notebook.cells[insertedIndex ?? cellIndex]?.cell_type ?? 'code'),
    language: languageOf(notebook),
    edit_mode: appliedMode,
    error: '',
    notebook_path: target.displayPath,
    original_file: content,
    updated_file: updatedContent,
  }
}

/** Insert one new cell (mirroring CC's code vs markdown cell construction). */
function spliceInsert(
  notebook: NotebookContent,
  index: number,
  source: string,
  type: 'code' | 'markdown',
  id: string | undefined,
): void {
  const idPart = id !== undefined ? { id } : {}
  const cell: NotebookCell = type === 'markdown'
    ? { cell_type: 'markdown', ...idPart, source, metadata: {} }
    : { cell_type: 'code', ...idPart, source, metadata: {}, execution_count: null, outputs: [] }
  notebook.cells.splice(index, 0, cell)
}

/** Whether a thrown error from ctx.fs signals a missing target. */
function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error
    && (error as { code?: string }).code === 'FS_NOT_FOUND'
  )
}
