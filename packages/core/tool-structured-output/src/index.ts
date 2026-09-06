/**
 * Model-facing `StructuredOutput` tool that validates model input against a
 * caller-supplied JSON schema and echoes it back verbatim as the structured
 * output. Aligns with Claude Code's SyntheticOutputTool (StructuredOutput):
 * the schema subtype is asserted at creation, every call re-validates its
 * arguments through the shared `@dsh-cc/tools` subset, and success
 * returns the CC `{ data, structured_output }` envelope. The tool is
 * concurrency-safe and reads only its own arguments.
 * @module @dsh-cc/tool-structured-output
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import {
  assertSupportedJsonSchema,
  ToolArgsError,
  validateJsonSchemaValue,
} from '@dsh-cc/tools'
import type { JsonSchemaNode, JsonValue, ToolDefinition, ToolRunContext } from '@dsh-cc/tools'

export const name = 'tool-structured-output'
export const inject = ['tools']

/** Runtime configuration for the StructuredOutput tool. */
export interface Config {
  /**
   * Optional enforced-subset JSON schema the model's structured output must
   * validate against. When declared, `apply` registers a `StructuredOutput`
   * tool configured with it; when omitted, no tool is registered.
   */
  schema?: JsonSchemaNode
}

/** Runtime configuration schema. */
export const Config: z<Config> = z.object({
  schema: z.any(),
})

/** The CC-aligned structured-output envelope returned on a successful call. */
export interface StructuredOutputResult {
  /** CC-aligned success acknowledgement string. */
  data: string
  /** The validated structured input, returned verbatim. */
  structured_output: unknown
}

const SUCCESS_MESSAGE = 'Structured output provided successfully'

/**
 * Build a `StructuredOutput` tool whose arguments must validate against
 * `jsonSchema` before they are echoed back. The schema is asserted against the
 * enforced subset at construction (early fail on an unsupported schema), and
 * every call re-validates with the shared subset semantics, throwing a
 * `ToolArgsError` (the same error cc-tools raises for invalid arguments) on a
 * mismatch.
 * @param jsonSchema - raw enforced-subset JSON Schema for the structured output.
 * @returns a ready-to-register tool definition.
 */
export function createStructuredOutputTool(jsonSchema: unknown): ToolDefinition {
  assertSupportedJsonSchema(jsonSchema)
  return {
    name: 'StructuredOutput',
    description:
      'Return structured output in the requested format. Use this tool to return your final '
      + 'response in the requested structured format: call it exactly once at the end with a '
      + 'value that validates against the provided JSON schema.',
    parameters: jsonSchema as Record<string, unknown>,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          data: { type: 'string' },
          structured_output: {},
        },
        required: ['data', 'structured_output'],
      },
      render: (_args: unknown, value: JsonValue): ContentBlock[] => {
        const output = value as unknown as StructuredOutputResult
        return [{
          type: 'text',
          text: `Structured output: ${JSON.stringify(output.structured_output)}`,
        }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: unknown, _exec: ToolRunContext): Promise<unknown> {
      const violations = validateJsonSchemaValue(jsonSchema, args, '')
      if (violations.length > 0) throw new ToolArgsError(violations)
      return { data: SUCCESS_MESSAGE, structured_output: args }
    },
  }
}

/**
 * Register a `StructuredOutput` tool when a schema is declared, and nothing
 * otherwise. The schema is asserted at registration the same way the factory
 * asserts it, so an invalid configured schema fails early.
 * @param ctx - Cordis context carrying the `tools` service.
 * @param config - optional `{ schema }` configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const schema = config.schema
  if (schema === undefined) return
  ctx.tools.register(createStructuredOutputTool(schema))
}
