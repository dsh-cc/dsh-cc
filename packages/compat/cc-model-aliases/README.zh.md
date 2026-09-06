# @dsh-cc/model-aliases

[English](README.md) | 中文

面向 DeepSeek Harness 的 Claude Code 兼容 model alias 解析。把 CC frontmatter 的 model alias(`model: opus`、`model: sonnet`)映射为 dsh 的 `{provider, model, reasoningEffort?}` 路由。本 package 现在以两种形态提供:

- **`ccModelRoutes` 宿主服务**(cordis 插件入口),拥有 `model-aliases` settings 命名空间的注册,并暴露派发时的解析器;
- **纯 helper**(`mergeAliasMaps` / `createModelResolver`),在不挂载服务的情况下内嵌同样的解析语义。

## 为什么

Claude Code 的 agent/CLAUDE.md frontmatter 用 alias 命名模型。没有 alias 层时,`model: opus` 会被原样当作 provider model id 透传,因此不认识该 id 的 adapter(如 `llm-pi-ai`)抛 `UNKNOWN_MODEL`;而 `model: inherit`——CC 中意为「用父模型」的合法哨兵——也会被当作字面 id 交给 `prepareCall` 然后报错。

本 package 补上这层:alias 解析为 `{provider, model, reasoningEffort?}` 路由,不可解析的情形回退为*继承父路由*(不 override),而 `deepseek-chat` 之类的字面 id 原样透传不受影响。

## `ccModelRoutes` 服务

插件入口(`name: 'cc-model-routes'`、`apply`)即 CC preset 通过 `cc-model-routes` 行挂载的东西。它:

- 注册 `model-aliases` **settings 命名空间**——但**仅当**存在 settings provider(`ctx.get('settings')`)时,因此无 settings 的宿主降级为 config 默认 + builtin fallback(该命名空间注册是此名的唯一属主;重复注册 harness 会 throw,见 `dsh-settings`);
- 以**写时 `validate`** 注册该命名空间,拒绝半写的 `{provider, model}` 路由(dict schema 本身无法表达的非空跨字段校验);
- 并把派发时解析器以 **`ccModelRoutes`** 值(`ctx.provide`)提供,其 `resolve(model)` 每次调用**现读** settings scope——settings 写回即在下次派发生效,无需重新注册。

消费者在每次派发时**惰性** `ctx.get('ccModelRoutes')`。惰性意味着挂载顺序无关:provider fiber 激活之前,`ctx.get` 返回 `undefined`,解析为「继承父路由」(与之前的 no-override 行为相同)。

## How the cc-shell bundle wires it(如何接线)

- `Config.modelAliases` 提供**部署默认**(alias 名 → model id 或 `{provider, model}`)。
- `model-aliases` **settings 命名空间**的注册现在住在 `ccModelRoutes` 服务里,与其它 settings section 一样分层(user/project/local/flags)。
- cc-shell 的 `AgentProvider` 通过**trampoline** 获得 `resolveModel`:`(model) => ctx.get('ccModelRoutes')?.resolve(model)`——**每次派发惰性查询**、现读(apply 时不快照),服务未挂载时降级为继承(`undefined` 解析 = 继承父路由,与旧 no-resolver fallback 字节兼容)。cc-shell 自己不再注册该命名空间。
- Task 工具(`@dsh-cc/subagent-task`)是另一消费方:它在派发时以同一个 `ccModelRoutes` 解析器解析 subagent 定义 frontmatter 的 `model`。

## 配置

```yaml
# ccModelRoutes 服务配置(预设的 cc-model-routes 行)
modelAliases:
  sonnet: deepseek-v4-flash                      # 字符串形式:仅 model,provider 继承
  opus:   { provider: deepseek-official, model: deepseek-v4-pro }  # 显式路由
```

```jsonc
// settings 命名空间 "model-aliases"
{
  "fable":  { "provider": "anthropic", "model": "claude-fable-5" },
  "sonnet": null     // null = 删除同名的 config-default alias
}
```

## 解析语义

alias 的查找顺序:**settings overlay → config 默认 → builtin fallback**。alias key 匹配**大小写不敏感**(merge 与 lookup 时 key 折叠为小写)。

| `model` frontmatter | 结果 |
|---|---|
| `undefined` / 空 | 无 override——child 继承父路由 |
| `inherit`(任意大小写) | 无 override——child 继承父路由(**修复旧的透传 bug**) |
| 已配置 alias(字符串形式) | `{ model: <target> }` |
| 已配置 alias(对象形式) | `{ provider?: <p>, model: <m>, reasoningEffort?: <effort> }` |
| 未配置的 builtin alias(`fable`/`opus`/`sonnet`/`haiku`) | 无 override——child 继承父路由(「当前模型」) |
| 未配置的 dsh-cc lane(`sketch`/`draft`/`blueprint`/`masterplan`) | 跟随 CC 对标名(`haiku`/`sonnet`/`opus`/`fable`);对标也未配置则 inherit |
| 未配置的 `architect` | 无 override——继承父(主线程)路由 |
| 其它 | **原样**作为字面 model id 透传;裸小写单词形式(如 `turbo`)记录一条「看起来像未配置 alias」的告警 |

### 对象形式 alias 的 `reasoningEffort`

对象形式 alias 可声明可选的 `reasoningEffort`:一个不透明的非空字符串,其合法拼写属于**目标模型的适配器**(`max`、`xhigh`、`high`、…——此处不对任何适配器目录做校验)。存在时,spawn 侧(Task 工具与 plugin-loader 的 `AgentProvider`)把它 stamp 到 child 的 options 上,routes 服务的宿主 `agent/request` listener 会把它应用到该 child 的**每一个**请求上,覆盖任何从 fork 父 header 恢复的 effort。字符串形式 alias 无法携带 effort;`inherit` / 未配置 builtin 不 stamp 任何东西。目标模型不支持的 effort 会让请求以 `UNSUPPORTED_REASONING_EFFORT` 失败——有意 fail-loud。

```jsonc
// settings 命名空间 "model-aliases"
{
  "opus":   { "provider": "orchestrix", "model": "glm-5.3",       "reasoningEffort": "max" },
  "sonnet": { "provider": "orchestrix", "model": "glm-5.3-flash", "reasoningEffort": "max" }
}
```

把 opus 的目标换成 effort 词表不同的模型,只需改这一条 settings(`"reasoningEffort": "xhigh"`);agent markdown 无需改动。

### 空删除

只有 **settings** 层可把条目置为 `null`;这会**整条删除同名 config-default 条目**(entry-shallow)。删除 *builtin* alias 仍落到 builtin fallback——`null` 无法让 `sonnet` 变成错误,因为 builtin fallback 是**继承父路由**。config 层永不允许 `null`(被 config schema 拒绝)。

### Merge 规则

- **config vs settings 是 entry-shallow**:settings 条目整体替换 config 条目,绝不 field-merge `{provider, model}` 对象——因此 `config { provider: A, model: X }` + `settings { model: Y }` 得到 `{ model: Y }`,而不会是没有任何单层声明的混合 `{ provider: A, model: Y }`。
- **settings 5 级 cascade 内是递归深 merge**(既有 cascade 行为)。因此对象形式 alias 跨 settings 层必须**整写或完全不写**,否则 cascade 会像上面描述的那样 field-blend `{provider, model}`——这是本 package 不改变的 cascade 层行为。优先用字符串形式 alias,或在提及该 alias 的每一层重复完整路由。

### Builtin fallback

**零配置**的全新安装也能工作:`model: sonnet` / `model: opus` / `model: draft` 的 agent 解析为*继承父的当前模型*(lane 未配置时跟随已配置的 CC 对标)而非报错。builtin 名(CC 家族 + dsh-cc lane)享受该 fallback;未配置的自定义 alias(`turbo`、`gpt`、…)**没有** fallback,原样透传(带上面的告警)。

## `inherit` 修复说明

本 package 之前,`model: inherit` 会一路原样当作字面 model id 传给 `prepareCall` 然后失败。在 CC 模式下,派发时解析器(来自 `ccModelRoutes` 服务,经 cc-shell trampoline 与 Task 工具消费)把 `inherit` 映射为「无 override」,child 因此继承父路由,符合 CC 语义。未挂载任何解析器时(`@dsh-cc/plugin-loader` 中不设置 `resolveModel` 的非 cc 消费者),行为与之前字节一致——包括旧的 `inherit` 透传——因为无解析器 fallback 被原样保留。CC preset 无条件挂载 cc-shell(以及 routes 服务),因此 CC 模式下该修复始终生效。

## API

- `apply(ctx, config?)` / `name` — **cordis 插件入口**(插件 id `cc-model-routes`,另以 `applyRoutes` / `routesPluginName` 再导出)。挂载服务;config 形状为 `{ modelAliases?: Record<string, AliasTarget> }`(部署默认)。
- `ModelRoutes` — `ctx.get('ccModelRoutes')` 的值类型(`resolve(model): { provider?, model?, reasoningEffort? } | undefined`)。
- `overlayStampedEffort(resolved, stamped)` / `stampedEffortOf(options)` — 服务 `agent/request` listener 使用的宿主侧 effort overlay;为测试与宿主内嵌而导出。
- `mergeAliasMaps(config, settings)` — 带 `null` 删除与大小写不敏感 key 折叠的 entry-shallow merge;返回只含已配置 alias 的有效 `ReadonlyMap`。
- `createModelResolver(getAliases, { warn })` — 构建 `resolveModel` 闭包。`getAliases` 是**每次调用**求值的 thunk(liveness)。可选 `warn` 替换默认的 `console.warn`(用于未配置自定义 alias 告警)。
- `BUILTIN_ALIASES` — CC 家族(`fable`/`opus`/`sonnet`/`haiku`)加上 dsh-cc lane(`sketch`/`draft`/`blueprint`/`masterplan`/`architect`)。
- `LANE_PEERS` — 未配置 lane → CC 家族映射(`sketch→haiku`、`draft→sonnet`、`blueprint→opus`、`masterplan→fable`;`architect` 无对标)。
- `toAgentOptions(route)` — 丢弃 resolved route 中的 `undefined` 字段以保住按字段继承(绝不把 child 请求的字段写成 `undefined`);`undefined` 进 → `undefined` 出,全 `undefined` 的 route 收敛为 `undefined`(「无 override」)。由 Task、cc-plugin-loader、hooks bridge 与 memory recall 共享。
- `toOneShotRoute(route, parent?)` — 把 resolved alias 填成完整的 `{provider, model}` 二元组,供独立的 one-shot `ctx.llm.stream` 调用使用:alias 字段优先,缺失字段从 `parent` 继承;补不完整(继承后仍无 model)返回 `undefined`,调用方视为「未配置」。session-title overlay 与 WebFetch summarizer 使用。
- `ConfigAliasesSchema` / `SettingsAliasesSchema`(及其 record 形式)— config 层(无 `null`)与 settings 层(允许 `null`)的 schemastery schema,外加 `AliasTarget` / `ResolvedRoute` 类型。

## dsh-cc lane

五个额外 builtin 名与 Claude Code 家族并列,不是第二套 settings 命名空间。未配置时,除 `architect` 外每个 lane 跟随其 CC 对标,因此已经映射了 `haiku` 的部署不必再写一份 `sketch`:

| Lane | 角色 | 未配置时的对标 |
|---|---|---|
| `sketch` | 快速轻量执行 | `haiku` |
| `draft` | 日常均衡编码 | `sonnet` |
| `blueprint` | 深度推理 | `opus` |
| `masterplan` | 最强推理 | `fable` |
| `architect` | 规划与编排 | inherit(主线程) |

已配置的字符串目标若指向另一个 alias,会**跟随一跳**(`sketch: haiku` 共用 haiku 的对象路由,含 `reasoningEffort`)。对象形式目标是具体路由,不作为名字再跟。第二跳不跟,因此 `sketch: draft` + `draft: haiku` 停在字面 `"haiku"`(防环)。

frontmatter 两套词都可以写(`model: opus` 或 `model: blueprint`)。后台分类器低价车道仍是 `resolve('haiku')` —— hooks 与 recall 不会改走 `sketch`。

## 低价(small-fast)车道

没有第二个 alias 名,也没有 `ANTHROPIC_SMALL_FAST_MODEL`。低价后台车道**就是**已配置的 `haiku` alias:需要小型独立 one-shot 分类器模型的消费者调用 `resolve('haiku')` —— 配置了 haiku 即其路由,未配置即继承父路由(builtin fallback)。当前消费者:hooks bridge(未写 `model:` 的 `prompt`/`agent` hook)、开启 `recallUseSmallFast: true` 的 memory recall、session-title overlay 与 WebFetch summarizer。

## 非目标(在 parity matrix 中跟踪)

`/model` 交互命令、`ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` 环境变量、以及给主会话默认模型加 alias 仍是 follow-up。
