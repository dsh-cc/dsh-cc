/**
 * The fork-owned declaration of the SDK renderer's schema shape.
 *
 * Upstream `@deepsee-ai/dsh-tool-executor-ptc` exports this interface, but
 * importing the upstream TYPE would drag the upstream package's declaration
 * chain into this program (see `./vendor/dsh-tool-executor-ptc.ts` for why
 * that is structurally impossible here). The shape is one field on top of
 * `ToolSchema` — which both sides import from the same `@deepseek-ai/dsh-llm`
 * — so this local declaration is the fork's public contract for it, and the
 * renderer functions are typed against it in the vendor module.
 *
 * @module @dsh-cc/tools/sdk-schema
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { JsonSchemaNode } from './json-schema.ts'

/** The model-facing tool schema plus its canonical output schema. */
export interface ToolSdkSchema extends Readonly<ToolSchema> {
  /** The tool's canonical output schema. */
  readonly output: JsonSchemaNode
}
