# @dsh-cc/mcp-client

[English](README.md) | 中文

MCP 客户端桥接插件：连接外部 [Model Context Protocol](https://modelcontextprotocol.io/) 服务器，把它们的工具注册到 `ctx.tools`，使模型能够通过服务器限定名称（`mcp__<serverName>__<rawName>`）将其作为原生工具使用。

## 用法

`cordis.yml` 中每个 MCP 服务器使用一个插件实例：

```yaml
- id: mcp-github
  name: '@dsh-cc/mcp-client'
  config:
    serverName: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN

- id: mcp-web
  name: '@dsh-cc/mcp-client'
  config:
    serverName: web
    transport: streamable-http
    url: http://localhost:3000/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'

- id: mcp-feed
  name: '@dsh-cc/mcp-client'
  config:
    serverName: feed
    transport: sse
    url: http://localhost:3001/sse
    oauth:
      redirectUrl: http://localhost:8787/callback
```

模型会看到 `mcp__github__create_issue`、`mcp__web__search` 等工具，这与 Claude Code 和 Codex 使用的服务器限定形状相同。HMR（热模块替换）支持热替换：编辑配置项会触发断开 + 重新连接，无需重启进程；`serverName` 不变时会生成完全相同的工具名称。

## 配置

| 字段 | 传输 | 必填 | 描述 |
|---|---|---|---|
| `transport` | 两者 | 是 | `"stdio"`、`"streamable-http"` 或 `"sse"` |
| `serverName` | 两者 | 是 | 该服务器面向模型工具名称的 namespace；`[A-Za-z0-9_-]{1,32}`，在存活实例中唯一 |
| `command` | stdio | 是 | 要 spawn 的可执行文件 |
| `args` | stdio | 否 | 传给命令的参数 |
| `env` | stdio | 否 | 合并到已清理环境中的额外环境变量 |
| `cwd` | stdio | 否 | 子进程工作目录 |
| `url` | http | 是 | MCP 服务器 URL |
| `headers` | http | 否 | 额外标头（例如认证 token） |
| `oauth` | http | 否 | OAuth 流程选项（见下文） |
| `toolCallTimeoutMs` | 两者 | 否 | 每次 `callTool` 调用的超时（默认 60000） |
| `failOnStartupError` | 两者 | 否 | 初始连接或工具同步失败时拒绝插件激活（默认 `false`） |
| `reconnect.enabled` | 两者 | 否 | 连接丢失后自动重新连接（默认 `true`） |
| `reconnect.initialDelayMs` | 两者 | 否 | 首次重连延迟（毫秒）；每次连续失败尝试翻倍（默认 500） |
| `reconnect.maxDelayMs` | 两者 | 否 | 退避上限（毫秒）；同时也是重置尝试预算所需的正常运行时长（默认 30000） |
| `reconnect.maxAttempts` | 两者 | 否 | 每次中断期间连续失败尝试次数上限，超出后彻底放弃（默认 10） |

## 工具命名

每个 MCP 工具都有两个名称：通过 `tools/call` 在协议上传送的原始 MCP 名称，以及公开名称 `mcp__<serverName>__<rawName>`，后者注册到 `ctx.tools`。公开名称会规范化为 DeepSeek 函数名称约定（64 个字符、`[A-Za-z0-9_-]`）；如果替换或截断改变名称，就会追加 `(serverName, rawName)` 的确定性 12 位十六进制 hash，确保不同工具绝不会折叠为同一个名称。名称是 `(serverName, rawName)` 的纯函数：连接顺序、重新同步和其他服务器永远不会重命名工具。

- 发布相同原始名称（例如 `search`）的两个服务器会在各自 namespace 下共存。
- 存活实例中的重复 `serverName` 会使后加载的插件实例失败。
- 服务器在工具列表中两次列出同一工具名称时，该列表会作为无效工具列表被拒绝。
- 外部注册抢占该服务器 namespace 时，会回滚整个世代（绝不保留部分集合），并明确报错。

## 行为

- 连接时：插件激活会等待 `listTools()`，并在组合开始首个轮次前以公开名称发布每个工具——默认通过 `ctx.tools.register()` 即时注册；当 `ctx.toolSearch` seam 已挂载且该服务器列出的工具数达到 `deferToolThreshold`（默认 8）时，改为经 `registerDeferred` 延迟注册。初始连接、发现或注册失败始终会记录日志；`failOnStartupError` 为 true 时拒绝激活，否则插件仍会激活但不注册工具。
- 监听 `notifications/tools/list_changed` → 重新同步；获取阶段失败时保留上一世代的注册，注册冲突则会回滚本次尝试的世代，并且不保留该服务器的任何工具。
- 工具执行：`client.callTool({ name: rawName, arguments }, { signal })`，支持超时 + 中止；公开名称绝不会发给服务器。
- 规范成功值是 `{ content: JsonValue[], structuredContent? }`；完整的 JSON MCP 块会保留给编程调用方。受支持且已声明的 `outputSchema` 会验证 `structuredContent`；不受支持的 schema 词汇会回退为不受约束的 `JsonValue`。
- Native／模型渲染保留现有文本投影：文本块以换行连接，图片、音频、资源和不受支持的块会变成占位符。
- 断开／崩溃时：supervisor 以指数退避（`reconnect.initialDelayMs` 逐次翻倍，上限 `reconnect.maxDelayMs`）重启原始服务器配置，成功后重新执行发现——恢复的世代会替换前一个，因此工具既不会重复也不会泄漏。中断期间最后一个正常世代保持注册；针对它的调用在恢复前会失败。
- 重连按中断预算控制：连续失败达到 `reconnect.maxAttempts` 次后，该服务器的工具会被注销，重连停止，直到 HMR 重载或重启 Host。连接存活超过 `maxDelayMs` 会重置预算，因此偶尔崩溃的服务器可以无限恢复，而崩溃循环的服务器——即使短暂连接成功——仍会耗尽上限而非永远重启。
- 重连状态在日志中对用户可见：reconnecting（warn，含尝试次数和延迟）、recovered（info）、最终失败和 disabled-loss（error）。dispose（资源释放）会取消任何待执行的重连。设置 `reconnect.enabled: false` 时，连接丢失后工具保持注册但调用失败，直到重载——即手动恢复行为。
- stdio 服务器的 stderr 会被管道捕获、不再继承父进程，因此不会刷到 TUI。内容追加到 `$DSH_HOME/mcp-logs/<serverName>.log`，达到 4 MiB 时轮转并保留一份 `.log.1` 备份，截断后的尾部会附在连接失败 / 连接丢失的 warn 上。无界面运行时终端上也不再出现服务器的实时 stderr。

## 消费的服务

| 服务 | 用途 |
|---|---|
| `ctx.tools` | 注册／注销 MCP 工具及资源桥 |
| `ctx.toolSearch` | 可选：把超过阈值的列出工具延迟注册（duck-type；不是必选 inject） |
| `ctx.skills` | 可选：注册 MCP 提示词技能 |
| `ctx.credentials` | 可选：持久化 OAuth token 及相关状态 |

## 能力

除工具外，当服务器声明其他 MCP 能力时，桥也会将其暴露出来：

- **资源（Resources）**——以两个服务器限定的模型工具 `mcp__<serverName>__list_mcp_resources` 与 `mcp__<serverName>__read_mcp_resource` 暴露，分别调用 `resources/list` 与 `resources/read`。`ctx.fs` seam（针对真实文件系统的抽象，基于 `FsTarget`/`readBytes`）无法表达虚拟 MCP 资源，因此这两个桥接工具正是能力 seam 规定的回退方案。资源列表变更通知会重新注册桥。
- **提示词（Prompts）**——当声明提示词能力时，每个 MCP 提示词都会作为技能注册到 `ctx.skills`。技能名把 `mcp__<server>__<prompt>` 形状映射到注册表的 lowercase-kebab 语法（`mcp-<server>-<prompt>`）。无参数提示词通过 `prompts/get` 解析，其渲染文本成为技能正文；需要参数的提示词则以参数约定作为文档。MCP 来源的技能是惰性纯文本——绝不包含可执行的 shell。提示词列表变更通知会重新注册技能。提示词桥需要 `ctx.skills` 服务；缺失时该桥为空操作。
- **OAuth**——网络传输（`streamable-http`、`sse`）接受 `oauth` 配置块。token、已注册客户端信息、PKCE code verifier 与发现状态通过 `ctx.credentials` 引用 seam 持久化（存储在派生的凭据引用下，绝不内联）。MCP SDK 通过 provider 驱动 RFC 9728 → RFC 8414 元数据发现、动态客户端注册、授权码 PKCE 与 token 刷新；会话中途的 `401` 会在丢弃过期 token 状态后重试一次。OAuth 需要 `ctx.credentials` 服务。

supervisor 在中断期间保持每个能力的注册存活（保留最后一个正常世代），并在放弃或 dispose 时移除，全部经由一条串行化的交换链。


## 模型体验

### 已发现的 MCP 工具

#### 模型看到的内容

初始发现成功后，每个已声明的 MCP 工具都会显示为名为 `mcp__<serverName>__<rawName>`（或其确定性规范化形式）的原生工具，并携带服务器提供的描述和输入 schema。成功的重新同步——包括自动重连后的同步——会替换整个世代；对插件执行 dispose（资源释放）或重连预算耗尽会移除该世代。

当 `ctx.toolSearch` seam 已挂载、且该服务器列出的工具数达到 **8 个**（默认 `deferToolThreshold`；按 `tools/list` 数组长度计，含 alwaysLoad 工具）时，可延迟的工具改为**延迟注册**：它们向 ToolSearch 池贡献名称 + 描述 + 服务器限定的搜索提示，在 ToolSearch 命中激活之前不进入模型可见 schema（激活执行真正的注册，此后与任何提示词顶部的工具无异）。声明 `_meta['anthropic/alwaysLoad'] === true` 的工具即使在延迟服务器上也立即注册。资源桥工具（`mcp__<server>__list_mcp_resources` / `read_mcp_resource`）始终保持即时注册。没有 toolSearch seam 时——独立部署、其他 preset——任何阈值下全部工具都即时注册。

世代替换（重连或 `tools/list_changed`）会先注销上一世代，这同时会卸载模型此前通过 ToolSearch 激活的工具：替换之后这些名字重新变为可搜索，模型必须再次搜索（或由会话重新激活）才能调用。同一客户端上的相同重新同步由 fingerprint 跳过，不会重新发布任何内容。

#### Token 影响

工具注册期间，每次请求都会承担数据相关的 schema 成本——延迟工具只在激活后才承担该成本，其 schema 成本被一个 ToolSearch 工具加每次命中的激活所取代。重新同步会替换而非累积 schema，服务器限定名称也会为每个工具定义和调用增加 token。

#### KV Cache 影响

只要已发现工具集合及其 schema 不变，前缀就保持稳定。增加、移除、重命名或更改工具的重新同步会替换定义，并可能使从第一个变化的 schema token 起的复用失效；恢复了未变列表的重连会生成完全相同的定义，前缀保持稳定。首个延迟注册还会把 ToolSearch 工具插入模型可见集合（一次性前缀变化；此后保持注册——迟滞）。

### 工具调用历史与结果

#### 模型看到的内容

公开工具名称和 JSON 参数会保留在 assistant 历史中。文本结果块会以换行连接为一个保留的 Native 文本结果；图片、音频、资源和不受支持的块在其中变为简短占位符。它们的完整 JSON 块及可选结构化内容保留在执行局部的规范值中；MCP `isError` 会通过注册表的错误路径拒绝调用。

#### Token 影响

参数和映射后的文本会保留到压缩（compaction）发生时。二进制与资源载荷会被丢弃，而不会加入上下文。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与暂缓事项

- **延迟阈值按服务器工具数计，而非上下文占比**：按上下文百分比或跨服务器聚合的规则（Claude Code 的约 10%）会更激进地延迟；三个各 5 个工具的小服务器全部保持即时注册。阈值也尚不能通过插件 Config 配置（测试直接把选项传入 `syncTools`）。
- **ToolSearch 激活是进程全局的**：加载一个延迟 MCP 工具后，凡工具限制放行该名字的 agent 都能看到它，且没有按会话的发现历史（见 `dsh-tool-search` README）。
- **对已预留但未激活的 MCP 名字执行程序化 `ctx.tools.execute` 会以 unknown 失败**：定义在 ToolSearch 命中激活之前并不存在；仓库内没有调用方依赖此路径。
- **frontmatter 里的精确 MCP 名字必须与公开名（可能带 hash 后缀）一致**：服务器前缀通配符可以绕开大多数此类问题。

- **动态 OAuth 客户端注册委托给 MCP SDK**：SDK 负责 RFC 9728/8414 元数据发现、PKCE、动态客户端注册与 token 刷新；本包只提供基于凭据的 `OAuthClientProvider` seam 持久化半边与单次 401 重试。交互式 `redirectToAuthorization` 在 headless 主机上只记录 URL 而不会驱动浏览器；完成流程仍需操作者介入。
- **启动超时继承自 MCP SDK**：DSH 尚未公开连接／发现超时。每次 initialize 请求或分页 `tools/list` 请求都使用 SDK 默认的 60 秒，因此在初始同步完成期间，无响应的 server 或 cursor chain 可能同时延迟激活与 teardown。
- **重连在传输关闭时触发**：崩溃的 stdio 子进程会触发重连；Streamable HTTP 失败通过每次请求以及 SDK 传输自身的 SSE（Server-Sent Events）流恢复机制暴露，因此不可达的 HTTP 服务器会按调用重试，而非由 supervisor 重新 spawn。
- **Native 非文本渲染有损**：图片、音频与资源载荷在模型上下文中会变成占位符，即使执行局部的规范值保留了其 JSON 块。更丰富的 Native 多媒体投影暂缓实现。
- **不强制执行不受支持的 MCP 输出 schema**：已声明 schema 使用 harness 子集之外的词汇时，`structuredContent` 会回退到 `JsonValue`。
- **资源桥使用两个工具的回退方案，而非文件系统 provider**：`ctx.fs` seam 无法表达虚拟 MCP 资源；当前表面是 ListMcpResources/ReadMcpResource 两个模型工具。
