/** Shared public tool parameters and strict input validation before filesystem access. */
import { stableJson, isPrefixedId, isUuidV4 } from './schema.ts'
import { fail, type Fail } from './store.ts'
/** Tool arguments: common write fields plus the op body (§10.1). */
export interface ToolArgs {
  projectId: string
  expectedRevision: number
  requestId: string
  input: Record<string, unknown>
}

/**
 * Output envelope for all five lane-2 tools, as a ValueSchemaSpec (compiled by
 * defineTool). Success = {ok, projectId, revision, data}; Fail = {ok:false,
 * code, message, retryable} plus optional details. `data` assumes an object
 * shape (all current call sites); widen to {type:'json'} if a replayed scalar
 * ever appears.
 */
export const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    projectId: { type: 'string' },
    revision: { type: 'integer' },
    data: { type: 'object', additionalProperties: true },
    code: { type: 'string' },
    message: { type: 'string' },
    retryable: { type: 'boolean' },
    details: { type: 'json' },
  },
} as const

export const COMMON_PARAMS = {
  projectId: { type: 'string', required: true, description: 'Project id (prj_…)' },
  expectedRevision: { type: 'integer', required: true, description: 'Current project revision (CAS guard)' },
  requestId: { type: 'string', required: true, description: 'UUID v4 idempotency key' },
  input: {
    type: 'object',
    additionalProperties: true,
    required: true,
    description: 'Operation body (per the VWA lane-2 tool contract)',
  },
} as const

export function toText(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: stableJson(value) }]
}

export function guard(raw: unknown): ToolArgs | Fail {
  const args = raw as ToolArgs
  if (
    typeof args?.projectId !== 'string' ||
    typeof args?.requestId !== 'string' ||
    !isPrefixedId(args.projectId, 'prj') ||
    !isUuidV4(args.requestId) ||
    !Number.isSafeInteger(args?.expectedRevision) ||
    args.expectedRevision < 1 ||
    typeof args?.input !== 'object' ||
    args.input === null ||
    Array.isArray(args.input)
  ) {
    return fail('SCHEMA_INVALID', 'expected a project UUID, request UUID v4, integer revision and input object')
  }
  if (Buffer.byteLength(stableJson(raw), 'utf8') > 2 * 1024 * 1024)
    return fail('LIMIT_EXCEEDED', 'tool payload exceeds 2 MiB')
  return args
}
