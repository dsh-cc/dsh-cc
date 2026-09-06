# @dsh-cc/tool-structured-output

[English](README.md) | 中文

模型侧 `StructuredOutput` 工具：根据调用方提供的 JSON schema 校验模型最终的结构化输出，并原样回显，语义对齐 Claude Code 的 `SyntheticOutputTool`。输入使用 `@dsh-cc/tools` 共享的 JSON-schema 子集校验，因此非法值会以与 harness 其余工具参数错误一致的错误语义被拒绝。

## 工具

### `StructuredOutput`

接受任意必须通过已配置 schema 校验的 JSON 值，并以 CC 结构化输出信封返回：

```json
{
  "data": "Structured output provided successfully",
  "structured_output": { "...": "校验通过的原样输入" }
}
```

该工具由 `createStructuredOutputTool(jsonSchema)` 工厂创建：

- 构造时即对 schema 断言受支持的子集——不支持的 schema 早期失败并抛出 `JsonSchemaError`。
- 每次调用都用 `validateJsonSchemaValue` 重新校验参数；不匹配则抛出 `ToolArgsError`（与 cc-tools 对非法工具参数抛出的 `INVALID_ARGS` 语义一致）。
- `isConcurrencySafe = () => true`：它只读取自己的参数，因此不会对并行的兄弟调用形成顺序屏障。

## 插件

```ts
import * as ToolStructuredOutput from '@dsh-cc/tool-structured-output'

await ctx.plugin(ToolRuntime)                        // @dsh-cc/tools
await ctx.plugin(ToolStructuredOutput)               // 未声明 schema -> 不注册工具
await ctx.plugin(ToolStructuredOutput, { schema })   // 声明 schema  -> 注册 StructuredOutput
```

插件的 `Config` 采用 schemastery 类型，含可选 `schema`。声明 schema 时，`apply` 注册对应的 `StructuredOutput` 工具；省略时则不注册任何工具（对应 CC 中 `isSyntheticOutputToolEnabled` 对工具创建的开关）。

## 使用

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

## 语义取舍

- **构造时早期 schema 断言**：在工厂创建阶段即拒绝不支持的子 schema。
- **共享校验**：通过 `@dsh-cc/tools` 使结构化输出的错误与所有其它工具的参数错误保持一致。
- **CC 对齐信封**（`data` + `structured_output`）：复现 SyntheticOutputTool 的 `call()` 返回结构。
- **并发安全**：`StructuredOutput` 可与兄弟调用重叠。

## 构建顺序

`tool-structured-output` 仅依赖工作区 `@dsh-cc/tools` 包与 harness 基础包（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-invariants`）。只要 `core/tools` 构建完成即可构建；`tsc -b` 会自动解析引用顺序。

## 已知限制

- CC 仅在非交互会话中启用 `StructuredOutput`（`isSyntheticOutputToolEnabled`）；本工具没有会话模式门控——是否注册完全取决于是否配置了 schema。
- schema 必须落在强制的 `@dsh-cc/tools` 子集内（不支持 `anyOf`、pattern、format、数值边界等），而非 CC 编译所用的完整 Ajv 方言。
