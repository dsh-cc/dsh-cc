# @dsh-cc/settings-cascade

[English](README.md) | 中文

面向 `ctx.settings` 的 Claude Code 风格五级设置级联提供方。五级来源按优先级从低到高合并——用户设置、项目设置、本地设置、flag 设置、策略设置——其下是插件默认基底。合并后的原始文档进入用户设置 seam，其 namespace 解析按 schema 默认、注册方 `base`、本用户层依次叠放。

## 配置

| 字段 | 含义 | 默认 |
|---|---|---|
| `userSettingsPath` | 用户设置文件 | harness home 下的 `settings.json` |
| `projectSettingsPath` | 项目设置文件 | `<project>/.claude/settings.json` |
| `localSettingsPath` | 本地（被 git 忽略的）设置文件 | git 主检出根（linked worktree）或 git 顶层目录下的 `.claude/settings.local.json` |
| `flagSettingsPath` | 命令行 `--settings` 文件 | 无 |
| `flagSettingsInline` | 内联 `--settings` 内容，在 flag 文件之上合并 | 无 |
| `projectDir` | 决定**项目**设置路径，并作为本地设置路径 git 探测的启动目录 | 当前工作目录 |
| `dshHome` | 默认用户设置路径所用的 harness home | `$DSH_HOME` 或 `~/.dsh` |
| `policy.remoteSettings` | 托管策略设置；策略最高优先级 | 无 |
| `policy.systemPath` | 系统级托管设置文件 | 无 |
| `policy.userPath` | 用户可写的托管设置文件 | 无 |

默认值解析是一步显式的 `resolveSpec(config)`。

## 行为

- **优先级从低到高。** user < project < local < flag < policy。各来源递归深合并；高层来源补上低层缺失的键，并替换其携带的值。
- **插件默认位于最底层。** 注册 `base` 与 schema 默认值解析于每个文件来源之下，因此文档缺失时解析结果与叶子提供方完全一致。
- **权限数组取并集，`deny` 优先。** `allow`、`deny`、`ask` 规则数组跨层拼接去重，合并后的 `deny` 集合会从 `allow` 中剔除——高层 deny 始终压过低层 allow。空的权限数组被省略。其余数组（例如 `additionalDirectories`）由高层整体覆盖。
- **策略是首个来源胜出。** 策略层按其子来源优先级取第一个非空者：remote > 系统文件 > 用户文件。较高来源为空或缺失时回退到下一来源。
- **flag 设置先文件后内联。** 若同时存在 `--settings` 文件与内联内容，内联内容在 flag 层内部覆盖文件。
- **坏配置加载期明确报错。** 存在但非法的设置文档（不可解析的 JSON，或非对象根）使插件加载失败；来源文件缺失不算错误，不贡献任何内容。
- **提供方经用户层可写。** `writable` 为 `true`，seam 的进程内 `update()`/`replace()`/`mutate()` 路径被接受。写入以 surgical delta（外科手术式增量）应用到用户层设置文件（默认 `$DSH_HOME/settings.json`）：只有调用方实际改动的键才落入用户文件。写入未触及的值——即使源自更高层——也不会被带进来。校验、修订号与更新事件仍由 seam 负责；project/local/flag/policy 来源仍是只读侧贡献者。
- **本地设置文件路径按 git 语义上提。** 启动目录位于 git worktree 或 git 仓库子目录时，`.claude/settings.local.json` 改从 git **主检出根**（worktree）或**顶层目录**（子目录启动）读取，与 Claude Code 一致。项目 `settings.json` 仍留在启动目录，会话 cwd 与 git 操作不受影响，文件内部的路径仍相对启动目录解析。以下情形回退到启动目录本身：非 git 仓库、Windows（`win32`）、仓库根为 `$HOME`、上提目标缺少 `.git` 的裸主仓库、git 探测失败，或仓库根 / `.git` / `.claude` 的属主未确认为当前用户（fail-closed）。worktree 本地的 `settings.local.json` 不会被读取（两者合并的行为在 Claude Code 中未确认）。无热重载：会话中途进入 worktree 不会重新解析。
- **`env` 分两阶段应用。** 顶层 `env` 分节从合并文档中拆出，经 `getEnv()` 暴露，所有值已强制转为字符串。`applyEnv()` 赋值普通变量；`applyTrustedEnv()` 另赋值改变环境的变量（`LD_PRELOAD`、`PATH`、`DYLD_INSERT_LIBRARIES` 及其余 `DANGEROUS_ENV_VARS`），仅在用户授予信任后运行。

## 权限 schema

`permissions` 字段 schema（`allow`、`deny`、`ask`、`defaultMode`、`disableBypassPermissionsMode`、`additionalDirectories`、`protectedFiles`、`dangerousPatterns`）与 Claude Code 的 settings.json 一致，以 `PermissionsSchema` 导出（连同 `PermissionRuleSchema` 与 `PERMISSION_MODES`），供权限规则引擎使用。

## 模型体验

间接生效：组合仍是读模型，写入经用户层得到支持；任何模型效果都经由 `ctx.settings` 的消费方产生，并由各消费方自己的接口文档说明。

#### KV Cache 影响

无直接失效；请求前缀的任何变更均由消费方插件负责。

## 已知限制与暂缓事项

- **仅 JSON 来源。** 来源必须是 `.json`（settings.json 惯例）；YAML 暂缓实现。
- **取消继承键不落盘。** 取消一个来自更低优先级来源（project/local/flag/policy）的键无法写入用户文件；该取消对运行中的进程生效，但重启后该值重现。此外，`describe()` 的 `user` 字段反映合并段而非用户文件实含量，因此 GUI 的 override 标记为近似（既有行为）。
- **并发写入可能丢更新。** 多个 dsh 进程并发写同一个用户设置文件可能静默丢失更新——原子 rename 只防文件损坏、不防丢写；原生提供方的跨进程锁已在本移植中移除。单进程配置（通常情况）不受影响。
- **写入仍走用户层，而非上提后的本地文件。** `persist()` 写入用户设置文件（既有行为）；因此在 worktree 中授予的 always-allow 仍不会更新主检出的 `settings.local.json`。
- **无文件热重载。** 任何来源文件的外部编辑均在重启后才生效（既有）。
- **无逐来源出处。** 合并结果不记录每个解析值来自哪个来源，`describe()` 也无法像单一用户层那样标注字段在五层之间的出处。
- **危险环境变量是静态白名单。** `DANGEROUS_ENV_VARS` 命名固定集合；部署专属变量在首次使用前需要显式的扩展点。
