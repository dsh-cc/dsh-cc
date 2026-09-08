# @dsh-cc/tool-web-fetch

CC 风格的 `web_fetch` 替代工具，带可选 `prompt` 参数。当 CC preset 将 `tool-web` 配置为
`fetch: false` 并在 `cc-services` 内挂载本包时，本包取代 stock `@deepseek-ai/dsh-tool-web`
的 `web_fetch`。

## 行为

- **不传 `prompt`**（或为空白）：与 stock 工具完全一致——返回原始转换后的页面文本。
- **传 `prompt`** 且已配置 `haiku` 模型别名（`ccModelRoutes.resolve('haiku')`）：
  抓取的文档经转换后与 prompt 一起送入该廉价 lane 上的一次性摘要调用，工具只返回提取结果。
  字符串形式别名（`haiku: deepseek-v4-flash`，仅 model）会从调用方 agent 的 request-header 继承缺失的 provider；
  没有调用方 agent（即无父 provider）时工具直接失败。
- **传 `prompt`** 但 `haiku` 别名未配置（无 `ccModelRoutes` 服务或 resolver 返回空）：
  工具抛出 `web_fetch: prompt requires a configured haiku model alias`，且**在任何抓取之前**——
  页面不会被抓取、流式调用或返回。

摘要调用不携带 `purpose` 字段：harness `GenerateOptions.purpose` 是封闭联合
（`'compaction' | 'session-title'`）。摘要模型请求工具或未产出文本时，调用以
`isError` 工具结果失败。

## Provider 要求

CC 部署使用 dsh-base 自带的 stock `@deepseek-ai/dsh-web-fetch-http` 执行器
(DNS 钉定、逐跳仅公网),CC 出口上限由 cc-shell bundle 重述。本工具在调用
seam 之前把 `http:` URL 升级为 `https:`(CC WebFetch 对齐);自身不注册
provider,测试通过 fake `ctx.web.fetch` 进行。

## Prompt 指引的相互影响

将 `tool-web` 设为 `fetch: false` 同时会从 `web_search` 的 system-prompt 段落中
移除 stock 的 "Follow up with web_fetch" 子句。本包重新注册 `tool:web_fetch`
段落（order 111）补齐 fetch 指引。

## 已知限制

- 本包无 host allowlist:SSRF 策略在执行器一侧——stock provider 解析并钉定
  仅公网地址、逐跳重校验,DNS rebinding 窗口已在上游(rc.1)关闭。更严格的
  限制应放在执行器,而不是本工具。
- Tavily / Firecrawl 是插件/skill，不是本工具的 fetch 后端。
