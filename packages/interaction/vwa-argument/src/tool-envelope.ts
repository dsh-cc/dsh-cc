/**
 * Shared registration-envelope helpers for the vwa-argument author tools.
 *
 * Extracted from tools.ts (which sits at the file-size budget) so both the
 * main registration face and the per-feature tool modules (report-tool.ts,
 * init-tool.ts) can import them without growing tools.ts.
 *
 * @module @dsh-cc/vwa-argument/tool-envelope
 */

import { ToolArgsError, type ToolDefinition, type ToolRunContext } from '@dsh-cc/tools'
import { fail } from './store.ts'

/** The minimal registration face of the harness tool runtime (no hard dep). */
export interface ToolRegistrar {
  register(definition: ToolDefinition): unknown
}

export type { ToolDefinition } from '@dsh-cc/tools'

/** Wrap a defineTool result so shape rejections keep the §10.1 SCHEMA_INVALID envelope (not a thrown ToolArgsError). */
export function withSchemaEnvelope(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    async execute(args: unknown, exec: ToolRunContext) {
      try {
        return await tool.execute(args, exec)
      } catch (error) {
        if (error instanceof ToolArgsError) return fail('SCHEMA_INVALID', error.violations.join('; '))
        throw error
      }
    },
  }
}
