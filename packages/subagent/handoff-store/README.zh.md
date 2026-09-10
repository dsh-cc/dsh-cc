# @dsh-cc/handoff-store

[English](README.md) | 中文

子代理交接存储：`handoff_put` / `handoff_get` 工具对让被沙箱化或只读的子代理把大体量产物（长评审、计划、报告）存入持久存储，并回传一个内嵌 `handoff://<id>` 句柄的简短摘要；编排者或后续子代理用 `handoff_get` 取回全文。这补上了 dsh-cc 委派纪律下的残余体量缺口——critic（无 Write）无法把评审写进仓库文件，而父级唯一的另一通道是完整最终消息文本。

## 存储

`$DSH_HOME/handoff/<projectKey>/<id>.md`，每个项目平铺（无每会话子目录；会话只进台账）。`projectKey = sha256(会话 cwd)` 前 16 位，取自【取回方】会话的 cwd（CCR `context_retrieve` 先例）。`id = sha256(内容 utf8)` 前 16 位 + 4 位十六进制随机后缀——相同内容存两次得到不同 id。文件是纯 UTF-8 JSON 信封 `{v, ts, text, label?, agent?}`，原子写入（temp + rename）。

**同 cwd 要求**：句柄只对 cwd 哈希到同一 projectKey 的会话可解析。跨项目取回刻意返回 `unknown_id`。**git worktree 注意**：同一仓库的两个 worktree 是不同的键——在不同 worktree 中生成的子代理无法取回别处存入的句柄。

## 保留策略

TTL 24 小时（每次读取依据信封内存储的 `ts` 校验；过期 → 类型化 `expired` 错误并惰性删除），加上每项目 500 条的 LRU。两次清扫都基于磁盘（对 projectKey 目录 `readdir` + 信封/mtime，在 put 时运行）——刻意不做内存 LRU，因为派生的子进程是独立进程，新建的 store 实例必须看到相同的逐出状态。读取会 bump mtime（LRU touch）；清扫的 TTL 判定用 mtime 作廉价代理，信封 `ts` 仍是读取路径上的权威判据。

## 台账

`$DSH_HOME/handoff/ledger.jsonl`，只追加行 `{ts, project, sessionId, id, label?, agent?, chars}`。可重建的观测索引，绝不在读取路径上；容忍兄弟子进程交错追加。所有台账 I/O 错误都被吞掉。

## 设置

命名空间 `cc-handoff`（每次 put 重读——CCR settings 模式）：

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 禁用 `handoff_put`。 |
| `threshold-chars` | `8192` | 工具描述引用的建议尺寸阈值。仅供参考：put 永不据此强制或拒绝。 |

## 工具

- `handoff_put({ content, label?, agent? })` → 含 `handoff://<id>` 与字符数的摘要文本。以存入方会话的 cwd 为键。
- `handoff_get({ id, maxChars? })` → 内容；给定 `maxChars` 时按头部截断并附截断说明。类型化错误 `unknown_id` / `expired` / `corrupt`。封闭失败：id 必须匹配 `^[0-9a-f]{20}$`，且只在当前 projectKey 目录内解析——绝不读出存储根之外。

本插件是普通 cordis 插件（不发布 Service，memory 模式）；宿主缺少 tools 服务、fs 缝隙或 `dshHomePath` 时整体 no-op。
