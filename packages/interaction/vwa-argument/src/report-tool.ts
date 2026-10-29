/**
 * Public deterministic report tool, with no model calls and no receipt mutation.
 *
 * Two-step as-of flow (design docs/plans/2026-10-28-vwa-batch-autonomous-review.md
 * §6.2/§6.3): `write:false` only freezes an evaluation and returns its
 * evaluationId + bindingDigest; passing `evaluationId` back renders that
 * evaluation as-of (no live recheck) after the page was fixed.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  EvaluationNotFoundError,
  EvaluationReadBackError,
  VwaArgumentService,
  type DeliveryCheck,
} from './report.ts'
import { fail, type Fail } from './store.ts'
import { sha256Hex, stableJson, isPrefixedId, type JsonValue } from './schema.ts'
import { RESULT_SCHEMA } from './tool-input.ts'
import { defineTool, type ToolDefinition } from '@dsh-cc/tools'
import { withSchemaEnvelope, type ToolDeps } from './tools.ts'

/** One rendered report (live or as-of). */
interface Rendered {
  text: string
  reportHash: string
  bindingDigest: string
}

export function reportTool(deps: ToolDeps): ToolDefinition {
  return withSchemaEnvelope(
    defineTool({
      name: 'argument.report',
      description:
        'Render the current VWA argument report as markdown or JSON, optionally writing a derived report. write:false freezes an evaluation and returns its evaluationId/bindingDigest; pass that evaluationId to re-render it as-of after fixing the page. Makes no model calls.',
      parameters: {
        projectId: { type: 'string', required: true },
        artifactId: { type: 'string', required: true },
        format: { type: 'string', enum: ['markdown', 'json'], required: true },
        write: { type: 'boolean', required: true },
        evaluationId: { type: 'string', description: 'Frozen evaluation id (eval_…) to render as-of' },
      },
      output: {
        // Reuses the ported RESULT_SCHEMA: the success return carries
        // projectId/revision/data, so an {ok}-only schema would throw
        // ToolOutputError on every successful call.
        schema: RESULT_SCHEMA,
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: stableJson(value) }],
      },
      async execute(raw, exec) {
        const args = raw as {
          projectId: string
          artifactId: string
          format: 'markdown' | 'json'
          write: boolean
          evaluationId?: string
        }
        if (
          !isPrefixedId(args?.projectId, 'prj') ||
          !isPrefixedId(args?.artifactId, 'art') ||
          !['markdown', 'json'].includes(args.format) ||
          typeof args.write !== 'boolean' ||
          (args.evaluationId !== undefined && !isPrefixedId(args.evaluationId, 'eval'))
        )
          return fail(
            'SCHEMA_INVALID',
            'expected projectId, artifactId, format:markdown|json, write:boolean and an optional evaluationId (eval_…)',
          )
        const root = deps.workspaceRoot(exec.agent)
        if (!root) return fail('STORE_IO_FAILED', 'no workspace bound')
        try {
          exec.signal.throwIfAborted()
          const service = deps.report?.(root, exec.agent) ?? new VwaArgumentService({ root })
          const path = `docs/vwa-reports/${args.projectId}/${args.artifactId}.review.${args.format === 'json' ? 'json' : 'md'}`
          let rendered: Rendered
          let revision: number
          let check: Pick<DeliveryCheck, 'eligibleForReviewed'>
          // Output identity: the as-of handle travels as plain JSON fields.
          let identity: { evaluationId?: string; asOf?: Record<string, JsonValue> }
          if (args.evaluationId !== undefined) {
            // §6.2 step 3: as-of — no checkForDelivery, no layer-B live recheck;
            // only the live adjudication overlay is applied.
            const asOf = await service.renderReportAsOf(
              args.projectId,
              args.artifactId,
              args.evaluationId,
              args.format,
            )
            rendered = { text: asOf.text, reportHash: asOf.reportHash, bindingDigest: asOf.bindingDigest }
            revision = asOf.revision
            check = { eligibleForReviewed: asOf.eligible }
            identity = { evaluationId: args.evaluationId, asOf: { ...asOf.asOf } }
          } else {
            const frozen = await service.checkForDelivery(args.projectId, args.artifactId)
            rendered = await service.renderReport(args.projectId, args.artifactId, frozen.evaluationId, args.format)
            revision = frozen.check.projectRevision
            check = frozen.check
            // Step 1 (write:false) is a pure freeze: hand back the handle. A
            // writing live call keeps its pre-existing output shape.
            identity = args.write ? {} : { evaluationId: frozen.evaluationId }
          }
          if (args.write) {
            const published = publish(root, path, rendered)
            if (published !== undefined) return published
          }
          return {
            ok: true,
            projectId: args.projectId,
            revision,
            data: {
              ...rendered,
              ...identity,
              ...(args.write ? { path } : {}),
              deliveryState: check.eligibleForReviewed ? 'reviewed candidate' : 'draft',
            },
          }
        } catch (error) {
          // §6.3: per-type pass-through — not every failure is a retryable
          // input change. Anything else keeps today's INPUT_CHANGED folding.
          if (error instanceof EvaluationReadBackError) return fail('STORE_CORRUPT', String(error))
          if (error instanceof EvaluationNotFoundError) return fail('REFERENCE_INVALID', String(error))
          return fail('INPUT_CHANGED', String(error), true)
        }
      },
    }),
  )
}

/** Atomic publication (§6.3): a reader never sees a partial report (temp + rename). */
function publish(root: string, path: string, report: Rendered): Fail | undefined {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${randomUUID()}.tmp`
  writeFileSync(tmp, report.text, 'utf8')
  if (sha256Hex(readFileSync(tmp, 'utf8')) !== report.reportHash) {
    rmSync(tmp, { force: true })
    return fail('STORE_IO_FAILED', 'report read-back failed')
  }
  renameSync(tmp, target)
  return undefined
}
