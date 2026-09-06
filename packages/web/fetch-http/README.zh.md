# @dsh-cc/web-fetch-http

[English](README.md) | 中文

CC 宿主侧 HTTP(S) 抓取提供者。它把 `CcHttpFetchProvider` 注册到 `ctx.web` 的 fetch 注册表（id 为 `'http'`，即 `LOCAL_FETCH_PROVIDER_ID`），在 harness 的 `HttpFetchProvider` 外包一层字面量 SSRF 门禁和可选的 `http:` → `https:` 升级。它不会调用 stock `web-fetch-http` 插件的 `apply()`，因此每个 context 只能挂载一个 id 为 `'http'` 的提供者。

## 工作方式

每个 `ctx.web.fetch` 的请求 URL 都先经过纯函数门禁 `gateAndRewrite`，才会交给内层提供者——被拒绝的 URL 不会建立任何连接：

1. 空的、无法解析的或非 `http(s)` 的 URL → `WEB_INVALID_URL`。
2. 带凭据的 URL（`user:pass@`）→ `WEB_BLOCKED_URL`。
3. 超过 `maxUrlLength` 的 URL → `WEB_INVALID_URL`。
4. 当 `blockPrivateNetwork`（默认 `true`）时，私有/非公网目标 → `WEB_BLOCKED_URL`，消息为 `blocked: private or non-public destination`。
5. 当 `upgradeInsecure`（默认 `true`）时，公网 `http:` URL 会改写为 `https:`（保留 host/path/query/hash）。私有主机永远不会被升级。

`isBlockedDestination` 只检查解析后的主机名。WHATWG URL 解析器已经把十进制/八进制 IPv4 主机折叠（`http://2130706433/` 的 hostname 是 `127.0.0.1`），因此整数主机混淆已被覆盖。阻断类别：

| 类别 | 示例 |
|---|---|
| 回环名 | `localhost`、`*.localhost`、`localhost.` |
| 回环 IP | `127.0.0.0/8`、`::1`、IPv4 映射 `:ffff:127.0.0.1` |
| 链路本地 | `169.254.0.0/16`（含 `169.254.169.254`）、`fe80::/10` |
| RFC1918 | `10/8`、`172.16/12`、`192.168/16` |
| CGNAT | `100.64.0.0/10` |
| IPv6 ULA | `fc00::/7` |
| 未指定 / 组播 | `0.0.0.0`、`::`、`224.0.0.0/4`、`ff00::/8` |

## 配置

```ts
export const Config = z.object({
  maxUrlLength: z.number().default(2048),
  maxResponseBytes: z.number().default(2_000_000),
  maxBodyChars: z.number().default(100_000),
  timeoutMs: z.number().default(20_000),
  maxRedirects: z.number().default(3),
  userAgent: z.string().default('dsh-cc/0.4.1 (+https://github.com/dsh-cc/dsh-cc)'),
  upgradeInsecure: z.boolean().default(true),
  blockPrivateNetwork: z.boolean().default(true),
})
```

非法的数值配置会在插件构造时抛出（上限须为正有限数，`timeoutMs` 在 Node 定时器范围内，`maxRedirects` 须为非负整数）。`blockPrivateNetwork: false` 是面向气隙/内网文档的部署逃生阀——本包不提供生产用的 `allowTestLoopback` 开关；需要回环服务器的传输测试只在测试夹具中设置该配置。

## 安装 / 注册

```ts
import * as WebFetchHttpCc from '@dsh-cc/web-fetch-http'

await ctx.plugin(WebRuntime)          // @deepseek-ai/dsh-web
await ctx.plugin(WebFetchHttpCc, {})  // 注册带门禁的提供者
```

不要同时挂载 stock `@deepseek-ai/dsh-web-fetch-http` 插件：重复 id → `WEB_DUPLICATE_PROVIDER`。

## 已知限制

- **不做 DNS 查询。** 门禁是纯字面量检查。解析到私有地址的公网主机名（DNS rebinding，包括同源重定向之后的逐跳 rebinding）是**残留风险**：包装层看不到内层重定向的每一跳（同源重定向主机名不变，但 DNS 会在每次连接时重新解析）。修复需要在 harness `web-fetch-http` 提供者内部做 DNS 固定（`webfetch-ssrf-allowlist` 缺口）；本包只记录该缺口，不宣称 SSRF 防护已完整。
- **Tavily / JS 渲染抓取不属于本包。** Tavily 是独立的 MCP/skill（markdown 的 `POST /extract`），永远不是 `WebFetchProvider`，也不是本地抓取失败时的回退。
- 包装层不会在内层重定向的每一跳上重新运行门禁；harness 提供者会在每一跳重新校验传输卫生（scheme、凭据、长度），跨源重定向会被拒绝。
