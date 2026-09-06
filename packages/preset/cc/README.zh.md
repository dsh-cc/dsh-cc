# @dsh-cc/preset-cc

[English](README.md) | 中文

DeepSeek Harness(dsh)的 **CC 模式** agent preset:除内置 `standard`、`minimal` 等之外的第 5 个 agent preset。它在完整标准 preset 之上组合出 Claude Code 行为面——Claude hooks、磁盘上的 CC 插件目录、斜杠命令、memory、CC 输出样式、CC 风格 WebFetch。本包**纯配置**:无 TS 运行时代码,只有 `agent.cordis.yml`(平铺的 agent 组合 entry list)加 `preset.yml` 元数据。

## 作用

- **完整标准基底**。`agent.cordis.yml` 以标准 `standard` preset 的逐字拷贝开头(16 个基座行),CC 模式会话因此具备标准编码 agent 的全部能力。
- **作用域化的 CC 表面**。`cc rows` 段挂载 Claude Code 对齐插件——hook 桥(30 个 hook 事件中的 18 个)、CC 插件目录 glue、`ToolSearch`、memory 与 consolidation、输出样式、coordinator、21 个斜杠命令,以及 worktree/sleep/notebook/structured-output 与 git 工具。WebFetch:stock `tool-web` 以 `fetch: false` 运行,搜索超时沿用 60s;`web_fetch` 由 cc-services 里的 `tool-web-fetch` 行(`@dsh-cc/tool-web-fetch`,可选 `prompt` 在廉价 lane 上摘要)替代。cc-shell bundle 额外挂载带 SSRF 门禁的 fetch 执行器(`@dsh-cc/web-fetch-http`);没有 `haiku` 路由时,可选 `prompt` 会在任何 fetch 之前硬失败。
- **会话标题与 `/rename`**。cc-shell bundle 用 `@dsh-cc/session-title-provider` 替换原生 `session-title-llm` 宿主行——first-prompt 标题提供方,配置了 `haiku` 廉价通道时盖印该路由(否则继承主路由);本 preset 还挂载 `@dsh-cc/command-rename`,`/rename <title>` 即可固定用户标题。
- **隔离的服务 realm**。承载服务的行(工具搜索、microcompactor、插件注册表、MCP 连接、hook-bridge 状态)放进 `cc-services` 组并带六个必需的 `isolate` 键,发布到 entry-local realm 而非进程全局 root realm(否则会触发 preset 挂载门禁)。
- **CC Task 委派(`tool-task` + `cc-model-routes`)**。`cc-services` 组还挂载 `@dsh-cc/subagent-task`(CC Task 工具,对按工作区的 `.claude/agents` 定义做 `subagent_type` 派发)与 `@dsh-cc/model-aliases`(`cc-model-routes`,拥有 `model-aliases` settings 命名空间与派发时别名解析器)。本 preset 里 harness 的 `tool-subagent` 与 `tool-subagent-fork` 两行被**禁用**,改用这个替代 Task,它是**前台一次性**——不再提供 `tool-subagent-fork` 之前暴露的 durable 后台/`continuable` 流程(`report`/`send_message`)。已知限制见 task 包 README 与 parity matrix。

这些行此前位于全局 `cc-shell` patch(`packages/bundle/cc-shell/cordis.patch.yml`),会泄漏进每个 agent preset;把它们 scope 到本 preset 正是隔离各行为面的手段。

## 安装

```bash
bash scripts/sync-local-profile.sh web   # 把 @dsh-cc/* 包镜像到 profile
bash scripts/sync-cc-preset.sh           # 把 cc preset 装进 ~/.dsh/.agent-presets/
```

两个脚本都是拷贝而非软链;插件代码与 preset 文件在启动时读取,因此首次安装后需**重启 dsh**(之后的文件改动也在下次重启生效)。

## 选用

- **Web UI**:预设选择器里选「CC mode」;或
- **settings**:`~/.dsh/settings.json` → `"agent-presets": { "default": "cc" }`。

## Known limits(已知限制)

1. **standing 挂载 + host-plane 单例**。preset 在每个进程挂载一次并处于 standing scope。MCP 连接、glue 装载的磁盘 CC 插件目录、subagent provider 名册、CC 插件对 `settings.json` 的写入都落到进程共享的 host-plane 单例(与上游 `subagents`/`goals` 相同的判据),因此不会因同时挂载的多个 preset 而按会话隔离。
2. **基座 vendored,靠漂移闸**。标准基座是 vendored 的。升级 dsh 后运行漂移闸(`pnpm vitest run packages/preset/cc`,或直跑二进制)重新 diff 新标准 preset 并合入上游改动。CI 机器无 dsh 安装时闸通过 `it.runIf` 自动跳过。
3. **卸载即删除**。删掉 `~/.dsh/.agent-presets/cc`(或你的安装方式);四个内置模式不受影响——user root 下同 id 的 preset 也盖不掉已安装的 system root 条目。
4. **`DSH_COORDINATOR_MODE=1` 使本 preset 挂载失败**。coordinator 需要 agent `ctx`,而 standing 挂载点没有;该失败现在只影响本 preset 的会话创建。在旧全局 patch 时代整个 app 起不来——影响面已收窄,但此模式在此处仍不受支持。
5. **settings 指向不存在的 preset 会报错**。若默认指向不存在的 preset,建会话报 `agent-preset-not-found`(`details.available` 列出可用 id)。把 `~/.dsh/settings.json` 的 `agent-presets.default` 改回 `standard` 即复位。

## 链接

- 源组合:`agent.cordis.yml`(基座 + `cc rows`)
- 元数据:`preset.yml`
- 行来源:`packages/bundle/cc-shell/cordis.patch.yml`
- 组合契约:`tests/composition.spec.ts`
