# @dsh-cc/tool-structured-output

English | [中文](README.zh.md)

Model-facing `StructuredOutput` tool that validates the model's final structured output against a caller-supplied JSON schema and echoes it back verbatim, aligned to Claude Code's `SyntheticOutputTool`. Input is validated with the shared `@dsh-cc/tools` JSON-schema subset, so an invalid value is rejected with the same error semantics the rest of the harness uses for bad tool arguments.

## Tools

### `StructuredOutput`

Takes any JSON value that must validate against the configured schema and returns it in the CC-structured-output envelope:

```json
{
  "data": "Structured output provided successfully",
  "structured_output": { "...": "the validated input, verbatim" }
}
```

The tool is created by the `createStructuredOutputTool(jsonSchema)` factory:

- The schema is asserted against the supported subset at construction — an unsupported schema fails early with `JsonSchemaError`.
- Every call re-validates its arguments with `validateJsonSchemaValue`; a mismatch throws `ToolArgsError` (the same `INVALID_ARGS` semantics cc-tools raises for invalid tool arguments).
- `isConcurrencySafe = () => true`: it only reads its own arguments, so it never forms an ordering barrier against sibling calls.

## Plugin

```ts
import * as ToolStructuredOutput from '@dsh-cc/tool-structured-output'

await ctx.plugin(ToolRuntime)                        // @dsh-cc/tools
await ctx.plugin(ToolStructuredOutput)               // no schema declared -> no tool registered
await ctx.plugin(ToolStructuredOutput, { schema })   // schema declared  -> registers StructuredOutput
```

The plugin's `Config` is schemastery-typed with an optional `schema`. When a schema is declared, `apply` registers the matching `StructuredOutput` tool; when it is omitted, nothing is registered (mirroring CC's `isSyntheticOutputToolEnabled` gating tool creation).

## Usage

```ts
const tool = createStructuredOutputTool({
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    count: { type: 'integer' },
  },
  required: ['title', 'count'],
})
ctx.tools.register(tool)
```

## Choice of semantics

- **Early schema assertion** at factory construction rejects unsupported subschemas up front, before any call.
- **Shared validation** through `@dsh-cc/tools` keeps structured-output errors consistent with every other tool's argument errors.
- **CC-aligned envelope** (`data` + `structured_output`) reproduces SyntheticOutputTool's `call()` return shape.
- **Concurrency-safe** so `StructuredOutput` may overlap sibling calls.

## Build order

`tool-structured-output` depends only on the workspace `@dsh-cc/tools` package and harness base packages (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-invariants`). It builds as soon as `core/tools` does; `tsc -b` resolves the reference order automatically.

## Known limitations

- CC enables `StructuredOutput` only in non-interactive sessions (`isSyntheticOutputToolEnabled`); this tool has no session-mode gate — registration is purely driven by whether a schema is configured.
- The schema must stay within the enforced `@dsh-cc/tools` subset (no `anyOf`, pattern, format, numeric bounds, etc.) rather than the full Ajv dialect CC compiles.
