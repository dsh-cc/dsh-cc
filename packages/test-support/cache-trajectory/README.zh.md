# @dsh-cc/cache-trajectory

[English](README.md) | 中文

内部测试基础设施，不对外发布。缓存命中率基准测试：标准轨迹模式（zod 校验）、确定性运行器、报告折叠与回归阈值——外加针对已记录会话日志的离线取证。它是校准工具而非门禁：bin 永远以 0 退出，结论在报告中（`verdict`/`failures`）。

## 用法

对 DeepSeek API（或 mock 服务器）运行基准：

```sh
pnpm exec tsx packages/test-support/cache-trajectory/src/bin.ts \
  --out report.json            # 写出报告 JSON
  --trajectory path.json       # 默认：内置 trajectories/standard.json
  --base-url http://localhost:PORT   # OpenAI 兼容 mock 服务器（免密钥）
  --provider deepseek --model deepseek-chat   # 路由覆盖
  --api-key <key>              # 注入 DEEPSEEK_API_KEY（mock 运行）；env/.env 亦可
  --no-cc-plugins              # 跳过 dsh-cc agent 平面插件
  --no-cache-expected          # 仅结构判定（mock usage 无缓存桶）
  --report-only report.json    # 校验并渲染已有报告，不执行运行
```

针对会话日志的离线取证（纯 JSONL，`-` 表示 stdin，`.zstd` 经 zstd CLI 解压）——不启动组合栈：

```sh
pnpm exec tsx packages/test-support/cache-trajectory/src/bin.ts analyze-log session.jsonl
pnpm exec tsx packages/test-support/cache-trajectory/src/bin.ts compare-fork parent.jsonl child.jsonl
```

- `analyze-log` — 每请求缓存模式、按路由的 token 明细、间隔分桶与发现项。
- `compare-fork` — fork 父/子头部字节一致性：路由是否一致、系统提示是否逐字节一致、首个分歧字节位置。

库接口（`./index.ts`）导出轨迹模式与加载器（`parseTrajectory`、`loadStandardTrajectory`）、运行器（`runCacheTrajectory`）、报告折叠与阈值（`foldReport`、`hitRate`、`thresholdsFromEnv`，含 `CACHE_E2E_MIN_HIT_RATE_ENV` 覆盖），以及日志分析辅助（`analyzeSessionCache`、`compareForkPrefix`）。第二个入口（`./testing`）暴露 bin 与测试使用的组合栈。
