# @dsh-cc/vwa-eval

可验证工作区代理（VWA）的评测工具（设计文档
`docs/plans/2026-10-12-verifiable-workspace-agent.md` §8）。纯 node 工具，
**绝不作为插件挂载启动**；在仓库根目录用下述脚本或包脚本运行。

## 内容

- `gold-set.json` — 固定的 30 篇文档金标集（15 篇 `docs/**` + 15 个包
  README），每条为 `{path, sha256, bytes}`；固定的字节快照存放在
  `fixtures/gold/<path>`。校验或有意重新固定：
  ```
  node packages/evaluation/vwa-eval/scripts/select-gold.mjs --check
  node packages/evaluation/vwa-eval/scripts/select-gold.mjs --write
  ```
  `--check` 只校验快照：快照文件缺失、被改或多余时大声失败（打印路径与原因）；
  从不读取仓库里的实时文档，因此文档增删改不会让它变红。`--write` 从实时仓库
  重新选择并替换快照。
  选择过程不依赖正则、与 locale 无关（仅用码元比较排序）。
- `scripts/annotate.mjs` — 句级标注通道：`export` 导出金标集全部句子
  （使用 `@dsh-cc/vwa-evidence` 的分句与冻结的四族检测器），`merge` 将
  标注者 A/B 文件与用户裁决合并为 `annotations/gold-annotations.json`，
  `recall` 打印检测器召回（人标可验证句中被检测到的比例），防止静默的
  低检测率虚增覆盖率。
- `src/annotation.ts`：标注通道的实现，由 `src/index.ts:1-8` 重新导出。
  它覆盖金标集加载、使用冻结四族检测器的分句、合并为
  `vwa-eval/gold-annotations@1` 的双标注合并，以及检测器召回。
- `scripts/baseline.mjs` — P0(3) 覆盖率基线：对金标集跑抽取器，写入
  `baselines/<date>-P0-coverage-baseline.json`（各族检测命中数、含断言
  的文档数、候选覆盖率分母）。按 §8 在一周 dogfood 后重新校准。

- `src/scorer.ts` —— 冻结的 `humanities-scorer@1`（设计
  `docs/plans/2026-10-16-vwa-evidence-argument.md` §22.2）：纯函数实现原子
  claim 匹配（编辑相似度与 span IoU）、拆分/合并计分、核心召回、重大缺陷召回、
  clean 样本误报率、基于 `direct | inferential | partial | contradicted |
  irrelevant` 的 support macro-F1，以及确定性 bootstrap 置信区间（种子
  `20261016`，重采样 10,000 次；置信区间仅披露，不作阈值判断）。无 fs、无模型调用。
- `humanities/` + `scripts/build-humanities-manifest.mjs` —— 人文类金标 manifest
  （`gold-manifest.json`，schema 为 `gold-manifest.schema.json`），由
  `humanities/cases/*.json` 构建（目前为三个合成开发用例）：每个用例的 SHA-256、
  领域分层，以及冻结的 dev/holdout 划分（按 id 排序，每第三个用例为 holdout）。
  `--check` 重新计算并与已提交的 manifest 比对。

## 测试

`pnpm vitest run packages/evaluation/vwa-eval` 覆盖两个测试套件。
`tests/gold-set.spec.ts` 校验 30 条已排序的金标集条目、每个快照文件被钉定的
sha256，以及 `--check` 不读取仓库实时文档。`tests/scorer.spec.ts` 覆盖冻结的
humanities scorer 原语、含拆分/合并计分的 claim 指标、重大缺陷召回与 clean
样本误报率、support macro-F1、确定性 bootstrap 置信区间，以及已提交的
humanities manifest 往返。
