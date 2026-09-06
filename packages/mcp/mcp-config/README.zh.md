# @dsh-cc/mcp-config

[English](README.md) | 中文

Claude Code 风格的 MCP 工作区配置加载器：解析 `.mcp.json` 文档，进行校验、环境变量展开、企业级 allow/deny 策略过滤，并把通过的服务转换为可直接挂载的 `@dsh-cc/mcp-client` 注册项。

本包只负责文件→配置的**读取与校验**。它不做任何网络 I/O，也不自行挂载；下游把输出喂给 `@dsh-cc/mcp-client` 实例。

## 用法

```ts
import { buildRegistrations, type McpConfigPolicy } from '@dsh-cc/mcp-config'
import { readFileSync } from 'node:fs'

const body = JSON.parse(readFileSync('.mcp.json', 'utf8'))
const policy: McpConfigPolicy = {
  deny: (name) => name === 'blocked-saas',
  allow: (name) => name !== 'experimental',
}
// registrations: mcp-client Config objects (with serverName), in stable config order
const registrations = buildRegistrations(body, { env: process.env, policy })

for (const config of registrations) {
  await ctx.plugin(mcpClient, config)
}
```

典型的 `.mcp.json`：

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    },
    "web": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    },
    "feed": {
      "type": "sse",
      "url": "https://sse.example.com/events"
    }
  }
}
```

## 服务定义类型

`.mcp.json` 的 `mcpServers` 值为 Claude Code 服务定义：

| 形态 | `type` | 必填 | 说明 |
|---|---|---|---|
| `stdio` | 省略或 `"stdio"` | `command` | `args`、`env`、`cwd` 可选 |
| `http` | `"http"`（也接受旧式 `"streamable-http"`） | `url` | `headers` 可选 |
| `sse` | `"sse"` | `url` | `headers` 可选 |

`mcpServers` 可以是按服务名索引的对象，也可以是若干此类对象的数组（数组形式会拒绝重复出现的服务名）。

## 配置映射

每个通过的服务转换为一个 `@dsh-cc/mcp-client` `Config`：

- 服务**名**成为 `serverName`，即模型可见工具名的公共命名空间（`mcp__<serverName>__*`）。
- 基于 `command` 的定义映射为 `stdio` 传输。
- `http` / `streamable-http` 定义映射为 `streamable-http` 传输。
- `sse` 定义映射为 `sse` 传输。
- 注册项默认 `toolCallTimeoutMs` 为 60000、`failOnStartupError` 为 `true`（坏配置或不可达服服务在加载时响亮失败，而非静默地无工具激活）。

## 环境变量展开

`command`、`args`、`cwd`、`env` 值、`url`、`headers` 中的字符串支持：

- `${VAR}` —— 用环境变量值替换；**变量未设置时在加载期抛错**。
- `${VAR:-default}` —— 变量未设置或为空时回退到 `default`。
- `$$` —— 一个字面量 `$`。

展开默认读取 `process.env`，也可传入 `buildRegistrations`/`applyEnv` 的 `env` 选项。

## 企业级 allow/deny 策略

向 `buildRegistrations` 传入 `McpConfigPolicy` 以在转换前过滤服务：

- `deny(name, entry)` —— 返回 `true` 时丢弃该服务（先执行，优先级更高）。
- `allow(name, entry)` —— 存在时，只有返回 `true` 的服务被保留。

钩子接收原始 `McpServerEntry`，必须同步且收敛；抛出的钩子会中止整个加载。策略发生在解析与校验之后、转换之前，按稳定配置顺序执行；被拒绝的服务永远不会进入客户端。

## 错误

格式错误的配置在加载期抛错——非对象 body、缺失或非映射的 `mcpServers`、重复的服务名、未知传输类型、缺少必填的 `command`/`url`、或未设置的环境变量。响亮失败胜过静默跳过缺失引用。

## API

- `parseMcpServers(body)` —— 校验 `mcpServers` 映射并返回；畸形输入抛错。
- `dedupServers(map)` —— 将解析后的映射规范化为稳定的 `McpServerSpec[]`；重复服务名抛错。
- `normalizeServerEntry(entry)` —— 单个原始条目 → mcp-client `Config`（不展开环境变量），校验必填字段。
- `applyEnv(config, env?)` —— 在一个规范化配置中展开 `${...}` 替换。
- `expandEnv(value, env)` —— 展开单个字符串的替换。
- `buildRegistrations(body, { env?, policy? })` —— 到 mcp-client 注册项的完整流水线。
