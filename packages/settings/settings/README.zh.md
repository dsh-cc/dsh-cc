# @dsh-cc/settings

[English](README.md) | 中文

设置层收在一个包里，三个入口：

| 入口 | 是什么 |
|---|---|
| `@dsh-cc/settings` | vendored 的 `SettingsProvider` 契约（harness 0.1.5-rc.1 缝），带一个 no-op 的 `configure()` 门面。 |
| `@dsh-cc/settings/ns` | 建在该 provider 上的幂等命名空间注册：`registerNamespaceSafe`、`installSectionSafe`、`readUserSection`。 |
| `@dsh-cc/settings/cascade` | Claude Code 设置级联：分层合并、env 拆分、热重载、持久化。 |

这三者原本是三个包（`settings-provider`、`settings-ns`、`settings-cascade`），依赖链严格线性——ns 与 cascade 都只是为了建在 provider 之上，外部不可能只消费其中一个而不带另一个。现在合成一个包、三个入口；消费方唯一需要改的是子路径名。

`@dsh-cc/settings/cascade` 另带三个更窄的入口，供不需要整条级联的消费方使用：`./cascade/local-root`（项目解析到哪个设置目录）、`./cascade/permissions` 与 `./cascade/worktree`（Claude Code 兼容的 `worktree` 设置节：`baseRef` 与 `cleanupPeriodDays`）。

## 来历：这是一份 fork，不是 vendored 副本

本包起自 harness `@deepseek-ai/dsh-settings` 在 pin `1ef9c1fa9a`（0.1.5-rc.1）的契约，此后双向漂移：

- **向前。** `mutate` / `SettingsPathOp` / `applyPathOp` 并非 0.1.5 的 API，而是随本仓 0.1.7-rc.2 迁移（PR #172）进来的——写面是 0.1.7 形态，架在 0.1.5 的内核上。
- **向外。** `configure()` 在此是刻意的 no-op（dsh-cc 的设置是 CC JSON 级联，不是 profile-patch 表单）；`register()` 带一处 harness 从未有过的 schema 可调用性加固；`redactSecrets` 是本地移植，其 walker 对齐**当前**上游算法（穿透 union/intersect/transform 并对 secret 路径去重）。

### 为什么不能「升级」

上游把整个类换掉了：提交 `601d6761e4`（2026-09-21，#4587）把 `SettingsProvider` 变成 `SettingsForms`，并删掉了本包存在所依赖的那一半——`register()`、`installSection()`、`get(ns)`、`watch()` 以及 `SettingsScope` / `SettingsRegistration` / `SettingsWatcher` 三个类型。`SettingsForms` 的命名空间来自 loader entry、取值来自 profile patch 文档；本 fork 在运行时注册命名空间、从 CC 五层 settings JSON 取值。换过去是架构变更，不是版本号前进。

连「引入上游复用其中一块」也关闭了，且有两个独立原因：上游根 barrel 声明 `Context.settings: SettingsForms`，与本包自己的 `Context.settings: SettingsProvider` 增强冲突（`TS2717`）；且它发布的 `files` 不含源码，深引在仓内能解析、在真实安装里必挂。

## provider 面

`SettingsProvider` 是 vendored 契约，与 harness 设置包解耦，便于 dsh-cc 自行演进。`configure(presentation, owner)` 是刻意的 no-op 门面（dsh-cc 的设置是 CC JSON 级联，不是 rc.2 的 profile-patch 形态），接受参数是为了让上游调用方原样挂载。

命名空间按 provider 实例注册——未注册时 `get(ns)` 返回 `undefined`，`update(ns, …)` 抛错。重复注册时 `register()` 抛 `settings namespace "<ns>" is already registered`；这句话只有一个作者 `duplicateRegistrationMessage`，判定用的 `isDuplicateRegistration` 同时被抛出点与 `@dsh-cc/settings/ns` 使用。

## 命名空间面（`./ns`）

preset 插件每次会话挂载都向 app 级共享 provider 注册自己的设置命名空间；harness 的 `register()` 遇重复命名空间即抛，而 `/clear` 前后「先建后拆」的重叠窗口里两次挂载会撞车，导致整个 preset 挂载失败。此入口提供两个辅助函数——`registerNamespaceSafe` 与 `installSectionSafe`——把重复降级为实时读取，并惰性重新取得所有者 fiber 已退出的命名空间。

契约：

- **推迟。** 尚无 provider 时（其异步 init 在挂载扫描期间才收拢），注册推迟到 provider 可注入的时刻，而不是永久降级为读到 undefined。
- **重复容忍。** 重复 `register()` 抛错降级为实时读 provider。值保真警告：双模块副本 schema 不同时，降级路径读到的是另一副本的解析值。
- **重新取得。** 所有者 fiber 退出后，下一次读取会重新注册该命名空间；绝不服务前任所有者冻结的 scope。
- **卸载中。** fiber 卸载中（`INACTIVE_EFFECT`）返回 `undefined` 而不是抛错。

## 级联面（`./cascade`）

分层解析（managed → user → project → local → env）、CC 键名别名白名单、保留最后一份可用文档的热重载，以及带冲突检测的持久化（修订号过期时抛 `SettingsConflictError`）。
