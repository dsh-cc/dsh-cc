# @dsh-cc/settings-provider

dsh-cc 内置的 `ctx.settings` 契约：原样移植 harness `@deepseek-ai/dsh-settings`
（pin `1ef9c1fa9a`，0.1.5-rc.1）的 settings seam，使 dsh-cc 的 Claude Code
settings.json 级联与 rc.2 的 profile-patch 设置模型解耦（迁移方案 Q3，Option A）。

导出 `SettingsProvider` 基类（命名空间注册、分层解析、校验、串行化写入、
`settings/updated` 提交事件、watcher 机制）、`SettingsConflictError`、
`parseSettingsNamespace` 以及 secret 脱敏辅助。

唯一的有意新增：**no-op `configure({ auto }, fiber)` 门面**，与 rc.2
`SettingsForms.configure` 调用形状签名兼容，供 harness 基础行
（`agent-default-model`、`permission-presets`、`agent-preset-registry`）启动时
调用。dsh-cc 设置是 CC JSON 级联而非 profile-patch 表单，"presentation policy"
无对应语义：门面接受并忽略该策略，返回 disposer，并以 debug 级别记录一次。

纯库包：无 preset 行、无 capability manifest 条目。由
`@dsh-cc/settings-cascade`（继承该基类）及按此契约重新定型的消费方使用。
