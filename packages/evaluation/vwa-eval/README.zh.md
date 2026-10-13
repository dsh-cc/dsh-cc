# @dsh-cc/vwa-eval

可验证工作区代理（VWA）的评测工具（设计文档
`docs/plans/2026-10-12-verifiable-workspace-agent.md` §8）。纯 node 工具，
**绝不作为插件挂载启动**；在仓库根目录用下述脚本或包脚本运行。

## 内容

- `gold-set.json` — 固定的 30 篇文档金标集（15 篇 `docs/**` + 15 个包
  README），每条为 `{path, sha256, bytes}`。确定性重生成或校验：
  ```
  node packages/evaluation/vwa-eval/scripts/select-gold.mjs --check
  ```
  任何被固定的文件发生变更时 `--check` 会大声失败（打印路径与原因）。
  选择过程不依赖正则、与 locale 无关（仅用码元比较排序）。
- `scripts/annotate.mjs` — 句级标注通道：`export` 导出金标集全部句子
  （使用 `@dsh-cc/vwa-evidence` 的分句与冻结的四族检测器），`merge` 将
  标注者 A/B 文件与用户裁决合并为 `annotations/gold-annotations.json`，
  `recall` 打印检测器召回（人标可验证句中被检测到的比例），防止静默的
  低检测率虚增覆盖率。
- `src/sampling.ts` — §8 的回执行抽样：dogfood 20%（min 5，向上取整），
  验收后 5%；`K = 20` 期望原子事实（SAFE 惯例，arXiv 2403.18802——是
  指标参数，绝不是抽样比例）；标签 `supported | partially | unsupported |
  irrelevant`；`F1@K` 计算；评审通道预算表（数字为首次预算估计，由
  dogfood 重新校准）。P2 不接评审模型调用（§4.4）——仅接口与 schema。
- `scripts/baseline.mjs` — P0(3) 覆盖率基线：对金标集跑抽取器，写入
  `baselines/<date>-P0-coverage-baseline.json`（各族检测命中数、含断言
  的文档数、候选覆盖率分母）。按 §8 在一周 dogfood 后重新校准。

## 测试

`pnpm vitest run packages/evaluation/vwa-eval` — 选择器确定性与
`--check` 往返、对活文件的 sha256、抽样数学（ceil/min 规则、预算钉住、
手工 F1@K）、句子导出形状。
