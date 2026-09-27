# cc-codex-bridge

dsh-cc 官方插件：一条**免审批的 Codex 救援通道**。安装后，dsh-cc 会话可以运行唯一一种
规范、锁死的 Codex 救援调用 —— `node <launcher> [--last] <prompt>` —— 无需人工审批：
PreToolUse 钩子只对这一种命令形态自动放行。

核心思路是**状态搬迁，而非放宽沙箱**：Codex 以关闭内部沙箱的方式运行（嵌套沙箱无法
叠加），同时 dsh 外层沙箱仍是唯一的写入边界 —— 仅限工作区与临时目录。

## 工作原理

- 唯一的规范调用形态，逐字节锁定：解释器与启动器路径必须是不含展开的字面量，与插件的
  规范锚点逐字节相等 —— 不走 PATH 查找、不允许符号链接跳板、禁止 `~`/glob/`$VAR` 展开、
  禁止复合命令、单引号之外禁止命令替换。
- PreToolUse 钩子只对这一形态降级权限判定；其他一切形态一律失败关闭（fail-closed），
  回落到原有需审批的流程。
- 每次运行前，Codex 凭据会被同步到一个位于临时目录、权限为 `0700` 的专属 home；Codex
  CLI 本身在启动时解析为经过校验的绝对路径。

## 使用方法

1. **会话开始时的状态块。** SessionStart 钩子在每次会话启动时触发（startup 与 resume
   均包括），注入一个以 `cc-codex-bridge:` 开头的块：说明通道是否 **已启用（ARMED）** ——
   并给出可照抄的规范调用 —— 或 **未启用（NOT armed）** 及其白话原因。
2. **发起救援**，使用插件命令：

   ```sh
   /cc-codex-bridge:rescue review the failing spec
   ```

   裸名 `rescue` 可能与 Codex 插件的同名命令冲突；冲突时裸名注册会被跳过 —— 上面的
   带作用域名称加上始终存在的 SessionStart 规范块，保证通道在任何情况下都可用。
3. **多行提示词** 走 `--prompt-file`：先用文件工具把提示词写入工作区内（或规范临时
   目录）的文件，再使用 SessionStart 块中的 `--prompt-file <path>` 形态。
4. **`--last` 仅在明确要求续聊时使用**：只有当用户明确要求继续上一次救援时才加该标志。
5. **失败即关闭。** 若 SessionStart 块缺失或显示未启用，模型不得猜测或自行拼造规范调用
   —— 救援回落到正常的需审批路径（原生 `/codex:rescue`）。

## 开发会话降级

在 dsh-cc 自身的仓库开发会话中，启动器锚点位于会话工作区内，启用会被拒绝
（`anchor-under-writable-root`），通道降级为正常审批路径。预期行为，已有文档。

## 安全模型（能力隧道，直言不讳）

启用本桥接意味着明确放弃这一种命令形态的人工检查点。无人值守的 Codex 可以运行外层
沙箱允许的任何子进程 —— 包括权限分类器本会升级处理的操作（git push、ssh、云 CLI）以及
不受限的网络访问。**只有文件系统写入边界仍然成立**（工作区 + 临时目录），除此之外不作
任何承诺。本插件通过安装进行选择加入；**卸载或禁用插件即是一键关闭**。

## 当前状态

PR-1 交付骨架，PR-2 激活闸门（对且仅对规范救援调用自动放行的 PreToolUse 钩子），
PR-3 补齐入口表面：SessionStart 状态/规范块钩子与最终的 `/cc-codex-bridge:rescue`
命令 —— 插件一旦安装，通道即完整可用。

## 安装 / 卸载

从 dsh-cc marketplace 安装，插件名 `cc-codex-bridge`：

```sh
claude plugin install cc-codex-bridge@dsh-cc
```

卸载（或禁用）插件即彻底移除该通道：

```sh
claude plugin uninstall cc-codex-bridge@dsh-cc
```

## 已知限制

- 在 dsh-cc 自身的仓库开发会话中，启动器锚点位于工作区内，桥接会拒绝启用并降级为手动
  流程（预期行为，已有文档）。
- 环境变量 `BASH_ENV` 或 `ENV` 非空时通道自动失效（防御 shell 函数劫持）。
- v1 的续聊支持仅有 `--last`。
