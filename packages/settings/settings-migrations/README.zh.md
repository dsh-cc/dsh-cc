# @dsh-cc/settings-migrations

[English](README.md) | 中文

面向 DeepSeek Harness 的 Claude Code 式设置迁移机制。`defineMigration` 定义一个带版本号的迁移，`runMigrations()` 对原子写入的 `settings.json` 应用迁移，对齐 CC 启动时运行的 migration。打包的插件在挂载时自动运行待办迁移，且绝不让宿主崩溃。

## 状态：机制就绪，尚无真实迁移

本批只交付机制，**不落地具体迁移** —— cc/dsh 目前都没有旧版设置格式需要迁移。首个真实迁移将随首个 settings 格式变更（例如更名或删除某个键）落地。在此之前注册表为空，挂载插件是一个空操作。

## 机制

```ts
import { defineMigration, runMigrations, readMigrationState } from '@dsh-cc/settings-migrations'

defineMigration({
  version: 1,
  name: 'rename-field',
  migrate: (ctx) => {
    ctx.settings.theme = ctx.settings['ui-theme']   // 原地改写原始 settings 文档
    delete ctx.settings['ui-theme']
  },
})

await runMigrations()   // 应用所有已注册迁移
```

- **`defineMigration({ version, name, migrate(ctx) })`** 将迁移注册进模块注册表（按 `version` + `name` 去重）。`ctx.settings` 是可变的原始 JSON 文档，迁移在其中原地改写。
- **`runMigrations(migrations?, options?)`** 应用所有 `version` 大于已记录 `migrationVersion` 的迁移，按版本升序。测试/直调可传入显式列表，省略则使用注册表。选项：`home`（harness 家目录）、`settingsPath`、`statePath`。
- **`readMigrationState(statePath)`** 返回 `{ migrationVersion }`，状态文件缺失时默认 `0`。

## 版本存储

已记录版本存放在 harness 家目录下的**独立状态文件**里（经 harness 的 home-paths 工具解析——`$DSH_HOME` 或 `~/.dsh`），默认 `<home>/migrations.json`；settings 文档默认 `<home>/settings.json`。状态形如 `{ "migrationVersion": N }`。测试或受限部署可按次运行/按插件配置覆盖这两个位置。

## 语义（即契约）

- **版本升序。** 待办 = 满足 `version > migrationVersion` 的迁移，低到高排序。
- **整批原子性。** 仅当所有待办迁移都完成，批次才算成功，随后版本推进到最新待办版本。任一次抛错即中止运行：不写任何内容、版本保持不变，下次运行会重试失败的幸存者。
- **迁移器必须幂等。** 因为批次中途失败会留下旧版本，批次中较早的迁移在下次尝试时会再次运行（CC 的启动运行器同样会重跑整套）。请把迁移写成“跑两次也无害”——CC 自身正是为此在源数据上编码了自守条件。
- **`guard` 跳过不阻塞版本。** `guard(ctx)` 返回 `false` 会跳过该迁移，但仍被当作成功计入版本推进（CC 把跳过视为完成整套）。返回 `true` 则执行迁移。
- **原子写路径。** settings 与状态均通过同级临时文件再 `rename` 写入，读取方永远不会看到半写文档，也不会残留临时文件。

## 插件

`name`、`Config`、`apply(ctx, config)`：

```ts
await ctx.plugin(SettingsMigrations, { dshHome, autoRunOnMount: true })
```

| Config | 含义 | 默认 |
|---|---|---|
| `dshHome` | 用于默认路径的 harness 家目录 | `$DSH_HOME` 或 `~/.dsh` |
| `settingsPath` | `settings.json` 覆盖 | `<home>/settings.json` |
| `statePath` | 迁移状态文件覆盖 | `<home>/migrations.json` |
| `autoRunOnMount` | 挂载时运行待办迁移 | `true` |

挂载即运行待办已注册迁移（等价于 CC 启动时运行迁移）。失败的批次绝不会让宿主崩溃：错误仅记录为警告并保留已记录版本，下次挂载重试幸存者。

## 安装 / 注册

```ts
import * as SettingsMigrations from '@dsh-cc/settings-migrations'
await ctx.plugin(SettingsMigrations)
```

## 构建顺序

`settings-migrations` 只依赖 harness 基础包（`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-invariants`），不依赖任何 workspace 包，这些就绪即可构建。

## 已知限制

- **仅机制。** 尚未携带任何迁移；是否植入用于本地验证的迁移由各环境自行决定。
- **单份 settings 文档。** 运行器只针对用户 `settings.json`；project/local/flag 各层（见 `settings-cascade`）暂不是迁移目标。
- **尽力而为的失败上报。** 失败时插件只警告并保留版本，不向 seam 上报结构化的迁移报告。
