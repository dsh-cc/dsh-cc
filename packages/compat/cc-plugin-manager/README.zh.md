# @dsh-cc/plugin-manager

[English](README.md) | 中文

在会话内管理 Claude Code 插件状态：marketplace、安装、按作用域的启用——读写与真正的 `claude plugin` CLI 相同的磁盘文件（以及字节形状），两者保持互操作。

## 状态根：双 home（兼容读 `~/.claude`，写入 `~/.dsh`）

插件状态是双 home 的：

- **写根——`$DSH_HOME` / `~/.dsh`。** 每个变更操作（install / uninstall / enable / disable / update / marketplace add / remove / update）只写在 dsh home 之下（`plugins/{known_marketplaces.json, installed_plugins.json, marketplaces/, cache/}`，user 作用域的 `enabledPlugins` / `extraKnownMarketplaces` 写在 `~/.dsh/settings.json`）。按仓库的 project/local 作用域文件（`<cwd>/.claude/...`）保持 Claude Code 原来的位置不变。
- **读根——`$CLAUDE_CONFIG_DIR` / `~/.claude`，完全可见。** 既有的 Claude home 状态照常工作；不迁移，也绝不删除 Claude home 里的任何东西。
- **按 key 合并、dsh 优先。** 两个 home 携带同一 key（marketplace 名或插件 id）时，dsh 条目胜出；仅 claude 的 key 直接透传。dsh `known_marketplaces.json` 中的 `null` 值是私有墓碑，用来隐藏仅存在于 claude 的 marketplace。dsh `installed_plugins.json` 的条目列表——包括空列表——遮蔽该 id 的 claude 列表。

后果：

- **单向分叉。** dsh-cc 能看到两个 home；真正的 Claude Code 只看得到自己的。被 dsh 接管的插件对 `claude` CLI 不可见，除非在那边重新安装。
- **接管陈旧性。** 一旦 dsh-cc 把某个 id 写进 dsh 的 `installed_plugins.json`，之后 claude 侧对该 id 的改动对 dsh-cc 不可见——dsh 管理它碰过的东西。
- **`CLAUDE_CONFIG_DIR` 不再决定写入位置。** 设置了 `$CLAUDE_CONFIG_DIR` 时，写入跟随 `$DSH_HOME`（以前跟随 `CLAUDE_CONFIG_DIR`）；曾把它当作重定位旋钮的用户应改设 `DSH_HOME`。
- **旧版单根。** 只传 **`claudeHome`**（不传 `dshHome`）的调用方与双 home 之前的行为逐字节一致：该目录既是读根也是写根。

解析链为：显式 `dshHome` → 显式 `claudeHome`（旧版单根）→ `resolveDshHome()`（`$DSH_HOME` → `~/.dsh`）。解析发生在构建 deps 之前，因此无选项的生产调用方总是解析为双 home。

## 接口

`createCcPluginManager({ claudeHome?, dshHome?, cwd?, runGit? })` 返回带 `list`、`install`、`uninstall`、`enable`、`disable`、`update`、`listMarketplaces`、`addMarketplace`、`removeMarketplace`、`updateMarketplaces` 的管理器。变更基于合并视图解析；每次操作都重读两个 home，真正的 CC 改动在下一次操作即可见（已接管的 id 除外，见上）。claude 拥有的内容（marketplace 克隆、cache 目录）绝不被删除、移动或打孤儿标记；对 claude 拥有的 git marketplace 做 update 由 promote-on-write 服务（向 dsh home 做一次全新克隆，claude 条目原样不动）。

## 已知限制与延后工作

- 没有交互式菜单 UI、信任对话框、`details/eval/init/prune/tag/validate` 子命令、`managed` 作用域或孤儿清扫（CC 形状对齐范围见 `docs/plans/2026-09-06-plugin-management.md`）。
- `extraKnownMarketplaces` 的 user 作用域声明写入 `~/.dsh/settings.json`；删除仅存在于 claude 文件中的声明对 dsh-cc 自身视图是 no-op（无人读取），claude 文件保持不动。
- 没有批量迁移命令（`/plugin migrate`）；有用户需求时再议。
