# @dsh-cc/session-forensics

[English](README.md) | 中文

`/learn` 特性背后的纯分析库：遍历持久化会话 JSONL 存储，蒸馏反复出现的 失败→成功 修正。它不依赖 cordis，也没有任何运行时依赖 —— 宿主注入 `decompress(file): Promise<string>` 缝（默认的 `decompressJsonl` 通过子进程调用 `zstd` 二进制，沿用审计脚本的先例），因此单元测试可以直接跑普通 fixture 文本。

## 它做什么

- **扫描器**（`scan.ts`）：遍历 `<DSH_HOME>/sessions/<projectKey>/<sessionId>/session.jsonl.zstd`，读取会话头（`origin`、`delegationDepth`、`parentSession`），并将 `tool/call` + `tool/result` 事件归一化为记录。`tool/call` 的 arguments 以 JSON 编码字符串到达，解析时容忍解析失败。截断的实时尾行被忽略；损坏的中间行被跳过并计数 —— 绝不抛异常。`days` 新近度过滤优先使用目录 mtime，仅在 mtime 缺失或不合理时回退到头时间戳；窗口内的会话只解压一次。
- **审批配对**：`approval/asked` 事件按 `data.id` 与 `approval/decided` 配对；`approval/policy` 事件（如 `policy: "never"`）标记被排除在拒绝分析之外的会话。
- **分析器**（`analyze/`），全部确定性 —— v1 无 LLM：
  1. `path-correlation` —— 同工具失败（路径形态错误门：ENOENT / "No such file" / "not found"）与行序上首个后继成功共享同名文件但目录不同进行相关；bash 对要求相同首 token 且 ≥1 个不同的路径形态 token。
  2. `env-facts` —— 相同首 token 的命令失败与成功且错误签名不同（如 `python3` 下 ModuleNotFoundError，`uv run python` 下成功）。
  3. `search-scope` —— 窄根 grep 失败后紧跟相似 pattern 的更宽根 grep 成功。
  4. `permission-denials` —— 只计 `rejected` 审批结果（`cancelled` 与 `unavailable` 不算拒绝）；`approval/policy: never` 的会话排除在分母之外。
  5. `large-files` —— 超过大小阈值的读取结果 → "对 X 始终使用 offset/limit"。
- **聚合**（`runForensics`）：findings 按 `(kind, title)` 合并，按出现次数排序，并过 `minOccurrences` 门（默认 2）。每个 finding 携带 `session:<id>#turn=<n>` 证据锚点。

## 组合

这是一个库而非插件 —— 直接 import。把它挂载为用户可见命令的消费者是 [`@dsh-cc/command-learn`](../command-learn/README.md)。

## 已知限制与暂缓事项

- 仅确定性分析器 —— 对 findings 的可选 LLM 摘要 pass 刻意排除在 v1 之外。
- bash 路径形态 token 规则刻意保持简单（含 `/` 或文件扩展名形态的 token）；`minOccurrences` 才是真正的精度机制。升级该规则是后续工作。
