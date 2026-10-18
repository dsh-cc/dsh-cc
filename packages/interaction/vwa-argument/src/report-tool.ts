/** Public deterministic report tool, with no model calls and no receipt mutation. */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { VwaArgumentService } from './report.ts'
import { fail } from './store.ts'
import { sha256Hex, stableJson, isPrefixedId } from './schema.ts'
import { RESULT_SCHEMA } from './tool-input.ts'
import { defineTool, type ToolDefinition } from '@dsh-cc/tools'
import { withSchemaEnvelope, type ToolDeps } from './tools.ts'
export function reportTool(deps: ToolDeps): ToolDefinition {
  return withSchemaEnvelope(
    defineTool({
      name: 'argument.report',
      description:
        'Render the current VWA argument report as markdown or JSON, optionally writing a derived report. Makes no model calls.',
      parameters: {
        projectId: { type: 'string', required: true },
        artifactId: { type: 'string', required: true },
        format: { type: 'string', enum: ['markdown', 'json'], required: true },
        write: { type: 'boolean', required: true },
      },
      output: {
        // Reuses the ported RESULT_SCHEMA: the success return carries
        // projectId/revision/data, so an {ok}-only schema would throw
        // ToolOutputError on every successful call.
        schema: RESULT_SCHEMA,
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: stableJson(value) }],
      },
      async execute(raw, exec) {
        const args = raw as { projectId: string; artifactId: string; format: 'markdown' | 'json'; write: boolean }
        if (
          !isPrefixedId(args?.projectId, 'prj') ||
          !isPrefixedId(args?.artifactId, 'art') ||
          !['markdown', 'json'].includes(args.format) ||
          typeof args.write !== 'boolean'
        )
          return fail('SCHEMA_INVALID', 'expected projectId, artifactId, format:markdown|json and write:boolean')
        const root = deps.workspaceRoot(exec.agent)
        if (!root) return fail('STORE_IO_FAILED', 'no workspace bound')
        try {
          exec.signal.throwIfAborted()
          const service = deps.report?.(root, exec.agent) ?? new VwaArgumentService({ root })
          const frozen = await service.checkForDelivery(args.projectId, args.artifactId)
          const report = await service.renderReport(args.projectId, args.artifactId, frozen.evaluationId, args.format)
          const path = `docs/vwa-reports/${args.projectId}/${args.artifactId}.review.${args.format === 'json' ? 'json' : 'md'}`
          if (args.write) {
            mkdirSync(join(root, 'docs/vwa-reports', args.projectId), { recursive: true })
            writeFileSync(join(root, path), report.text, 'utf8')
            if (sha256Hex(readFileSync(join(root, path), 'utf8')) !== report.reportHash)
              return fail('STORE_IO_FAILED', 'report read-back failed')
          }
          return {
            ok: true,
            projectId: args.projectId,
            revision: frozen.check.projectRevision,
            data: {
              ...report,
              ...(args.write ? { path } : {}),
              deliveryState: frozen.check.eligibleForReviewed ? 'reviewed candidate' : 'draft',
            },
          }
        } catch (error) {
          return fail('INPUT_CHANGED', String(error), true)
        }
      },
    }),
  )
}
