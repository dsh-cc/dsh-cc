# dsh-cc-writing 文档类型扩展：genre 体系与工程战略文档

- Date: 2026-11-19
- Status: Proposed（设计稿，未实现）
- Target: `packages/plugin/dsh-cc-writing`（可选 marketplace 插件）
- Baseline: worktree `writing-skill-enhancement`，基于 origin/main
- Scope: 在现有 profile 体系上新增文档类型（technical-essay / academic / natural-prose / engineering-strategy），并引入轻量结构骨架（structure）能力

## 1. 问题与目标

dsh-cc-writing 目前只有四个 profile：`technical`、`research`、`opinion`、`technical-ste`。用户的实际写作需求远超这四类：

1. **技术散文/技术文档**（technical-essay）：讲清一个技术问题的长文，比 `technical` 更偏叙事，比 `research` 更少文献负担。
2. **学术论文**（academic）：严格的论证结构、术语纪律、引用与限定语保护。
3. **日常自然文章**（natural-prose）：去模板化、口语可读的非正式文章——现有 profile 全是正式文体，这一类没有承接者。
4. **工程战略文档**（engineering-strategy）：高级工程师/架构师向管理层汇报技术战略与路线选择。这是一类结构化程度最高的新文体：Rumelt 核（诊断/指导方针/连贯行动）、SCQA 开头、倒置阅读顺序、防 fluff 校验。

目标：

1. 新增文档类型不需改动写作工作流的状态机（9 phase、3 operation 不动）。
2. 前三类用纯 profile 落地（只扩 enum + 加 JSON）；第四类引入一个可选的 `structure` 字段承载结构骨架。
3. 保持既有承诺：「profile 是 prompt 不是 gate」——机械检查只验证结构与保义，不判定判断正确与否。
4. 所有同步面（双语 README、i18n 哈希、测试 pin、marketplace 描述）一次改齐。

非目标：

- 不新增 skill 入口（不破坏 `cc-plugin-loader` 的 4-skill pin），不新增 operation 类型。
- 不做 DOCX/PDF 排版输出；仍只管 Markdown 正文。
- 不做机器风格打分（不用 LLM judge 给文章打分并 gate 交付）。

## 2. 文献结论与设计映射

### 2.1 两篇论文

**WritingBench（arXiv:2503.05244）**：LLM 生成式写作基准，6 域 × 100 子域。它的核心构造不是固定维度表，而是**按查询动态生成的实例化评审标准**——每条标准有名称、扩展描述、10 分制 rubric、由 critic 模型独立评分并给出理由；固定轴只有 style / format / length 三个粗粒度维度。

映射：dsh-cc-writing 的 profile 规则（`{id, instruction, rationale, severity}`）与 WritingBench 的 criterion（name/description/rubric）同构。**新 profile 的规则应写成可独立判定的标准**：每条 rule 陈述一个可观察的文本性质（如「每个 H2 小节开头一句话概括本节结论」），而不是笼统风格口号。学术与技术散文两类的规则密度照此校准。

**Self-Refine（arXiv:2303.17651）**：单模型生成→自反馈→迭代精化循环，反馈维度是任务特定的。它没有提供风格分类学，唯一可迁移的是循环本身。

映射：writing-workflow 已经就是这个循环（draft→review→proposal→apply→check，finding 不可变 + addressed 派生标签）。**genre 的角色就是给这个循环喂任务特定的反馈维度**——profile 替代 Self-Refine 里的 few-shot 反馈提示词。无需新机制。

### 2.2 四本书（工程战略文档的体裁规格）

四本书在「战略文档长什么样」上高度收敛，可提炼出 engineering-strategy 的体裁规则：

**骨架（Rumelt《Good Strategy Bad Strategy》Ch5 + 两本 Larson 直接采用）**：
- Diagnosis（诊断）：定义并解释挑战的本质，从复杂现实中挑出关键方面。
- Guiding Policy（指导方针）：应对诊断所指障碍的总体方法，**必须隐含真实的取舍**。
- Coherent Actions（连贯行动）：互相配合、共同落实方针的协调步骤。

**反模式 lint（Rumelt Ch3-4）**：
- Fluff：空洞的高级词汇堆砌（「以客户为中心的中介服务」）。
- 不直面挑战：没有可评估的挑战定义。
- 把目标当战略：愿望清单不是克服障碍的计划。
- 坏目标：不针对关键问题、不可执行。

**方针质量门（Exec Primer Ch3）**：每条 policy 须 Applicable（能用于真实取舍）、Enforced（会真正执行问责）、Creates Leverage（复利/放大效应）。

**阅读顺序倒置（Crafting Engineering Strategy Ch11）**：写作顺序（explore→diagnose→refine→policy→operate）不等于阅读顺序。给管理层的审批文档 Policy 在前（防止审批会跑偏成研究讨论），给组织的落地文档 Policy+Operation 在前，思考过程（refine/diagnose/explore）殿后但**不能删**（新成员要能追溯推理，否则会认为前人愚蠢）。

**开头与长度（Staff Engineer）**：开头段落用 SCQA（Situation/Complication/Question/Answer）；愿景类文档 1-2 页封顶（读者在 5-6 页掉线）；假设没人读到结尾。

**文档自带过程（Exec Primer Ch11）**：元数据（日期、审批状态、去哪提问）、唯一 canonical source、具名联系人；发布前请未参与者标出不清楚的地方；发布后关闭文档内评论（开放的评论串=未获批的战略）。

**具体性（Staff Engineer）**：具体的陈述创造对齐，泛化的陈述创造对齐的幻觉；Show your work——保留理由让别人能在形势变化时修改扩展。

## 3. 现状与扩展缝（代码锚点）

- Profile 的唯一闭集：`skills/writing-workflow/scripts/schema.lib.mjs:141` `PROFILES = ['technical','research','opinion','technical-ste']`。`brief.profile` 在 `brief-run.lib.mjs:104` 走 `readEnum`，未知 id 在文件查找前即报 `INVALID_INPUT`。
- Profile 加载：`state.lib.mjs:51-59` 从 `profiles/` 目录按 id 读文件；**缺文件是静默的**（返回 null profile）——enum 与磁盘文件是两道独立门。
- Profile schema：`check-profile.lib.mjs:121-147`——`schemaVersion:"1"`、`id`、`description`、`applicableLanguages:string[]`、`rules:[{id,instruction,rationale,severity}]`、`protectedTerms:string[]`；未知字段拒绝。
- **genre 分支在代码中只有一处**：protectedTerms 进机械比对（`preservation.lib.mjs:107-108`）。phase 推导、record 门控全部按 `operation`（write/review/edit）分支，从不按 profile。
- 同步面（改动清单）：`schema.lib.mjs` enum；`references/contracts.md:33` 与 §6；`article-writing/SKILL.md:40,67-73` 路由表；`language-editing/SKILL.md:37`；`article-review/SKILL.md:33-41`（目前无 profile 行，本次补上）；`README.md:17-18,129` + `README.zh.md:16,113`（双语必须同 commit，`pnpm check:readme --write` 重录哈希）；`tests/package-shape.spec.ts:23` `PROFILE_IDS`（驱动 schema 校验循环）；`tests/contracts.spec.ts:294`（enum pin：`profile:'poetry'` 必须失败）；`.claude-plugin/marketplace.json:17` 描述。
- 语义约束：profiles 是「prompts, not gates」（`references/review-rubric.md:53-55`）；脚本只验证结构、身份与保义，「不证明判断正确」。

## 4. 概念模型：genre 仍是 profile，分两档能力

**决策 D1：不引入新的「文档类型」概念。** 文档类型 = profile id。理由：

1. 现有架构中 profile 已经承载了 genre 的全部职责（风格规则、术语保护、语言适用面），且代码面只有 protectedTerms 一处消费——扩展成本极低。
2. 新开概念（如 `genre` 字段或独立目录）会造出与 profile 并列的第二套元数据，两套元数据的组合语义（genre × profile）没有任何消费者。
3. 前三类新文档（technical-essay/academic/natural-prose）所需的全部能力都在现有 profile schema 内。

**决策 D2：分两档交付。**

- **Tier A（纯 profile）**：technical-essay、academic、natural-prose。只动 enum、加 JSON、改文档与测试，零逻辑变更。
- **Tier B（结构骨架）**：engineering-strategy 需要的「必须有诊断节/方针节/行动节、SCQA 开头、阅读顺序约束」超出了 rules 文本的表达力。给 profile schema 增加一个**可选** `structure` 字段，承载结构骨架，check 阶段做有限机械验证。

**决策 D3：不新增 skill、不新增 operation。** engineering-strategy 由 `article-writing` 的 profile 路由承接（新增触发描述「技术战略、路线汇报、给管理层的战略文档」）。理由：`packages/compat/cc-plugin-loader/tests/dsh-cc-writing.spec.ts:41` 钉死 4-skill；工作流的 research 阶段恰好可以承载战略文档的 explore/diagnose 材料收集；新增 operation 会牵动 `OPERATIONS`、`BRIEF_FIELDS`、`derivePhase`、`nextRequiredStage` 四处 operation-keyed 分支，收益不成比例。

**决策 D4：record/derivePhase 继续不按 genre 分支。** engineering-strategy 的诊断材料走 research stage（同一个「收集上下文」阶段，材料类型由 profile 规则约定，不由代码门控）。academic 的文献综述同理复用。

## 5. 新 profile 规格

### 5.1 `technical-essay`（技术散文）

定位：讲清一个技术主题的长文，有叙事线但保持术语精确。介于 `technical`（偏说明书）与 `opinion`（偏论辩）之间。

规则要点（每条写成可独立判定的标准）：
- 单一主线：全文能用一句话说出「本文让读者明白什么」；每个 H2 服务于这条主线。
- 概念先于机制：新术语在首次使用前用一句日常语言定义；术语首次出现处加粗或行内定义。
- 示例配比：抽象论述连续超过两段必须落到具体例子（代码、数据、事故、场景）。
- 图示纪律：每张图在正文中有指涉（「如图 N」）且图题自足——图被单独截走也能看懂。
- 不确定性如实：性能/成本/风险主张标注条件与量级，不裸断言。
- `protectedTerms`：留空数组（由 brief 按具体主题注入技术术语）。

`applicableLanguages: ["zh","en"]`。

### 5.2 `academic`（学术论文）

定位：论证结构严格的学术文体（论文、长综述、技术报告的学术写法）。

规则要点：
- 论文骨架：Abstract/引言（贡献清单）、相关工作、方法、评估/论证、限制、结论。缺限制节即缺陷。
- 主张-证据配对：每个非平凡主张有引用、数据或形式论证支撑；表述强度与证据强度匹配（证据是相关性的不得写因果）。
- 限定语保护：may/suggest/consistent with 一类限定语在 copy edit 中不可削弱或删除（这是 protectedTerms 之外的语义规则，进 review rubric）。
- 术语一致：同一概念全文一个名字；同义改写仅在首次定义时出现。
- 引用纪律：每条引用在正文有承载句（不是括号堆叠）；引用支撑的是句子实际说的话。
- 时态与人称：方法用过去时/被动或既定惯例；贡献清单用现在时。

`applicableLanguages: ["zh","en"]`。

### 5.3 `natural-prose`（日常自然文章）

定位：博客、随笔、 newsletter 一类口语可读的非正式文章。与 `opinion` 的区别：opinion 服务论证，natural-prose 服务「像人说话」。它是对现有四个正式 profile 的补充面，规则以「减法」为主：

- 禁模板化开头（「在当今快速发展的时代」「随着…的普及」）与模板化结尾（「总之…让我们共同期待」）。
- 段落呼吸：平均段长不超 5 句；连续三段等长即缺陷（节奏单一）。
- 不做三连排比凑数；删除不承担信息的三段式总结。
- 语气与读者距离一致：全文同一个「说话人」，不中途从聊天切换到布道。
- 首段话头：第一句把读者放进具体场景或问题，不从背景综述开始。
- 每句能读出来不拗口（朗读测试）。

`applicableLanguages: ["zh","en"]`。zh 侧与 lieflat/humanizer 类本地技能的分工：本 profile 只在 writing-workflow 内生效（规则化），不调用那些一次性清理技能；两者可先后使用，不冲突。

### 5.4 `engineering-strategy`（工程战略文档）——Tier B

定位：向管理层汇报技术战略/路线选择的文档。规格直接来自 §2.2 的书摘。

**structure 骨架**（新字段，见 §6）：

```json
{
  "structure": {
    "openingPattern": "scqa",
    "sections": [
      {"id": "summary",     "headingHint": "TL;DR / 摘要", "required": true,  "order": 1},
      {"id": "policy",       "headingHint": "指导方针",     "required": true,  "order": 2},
      {"id": "operations",   "headingHint": "落实机制",     "required": false, "order": 3},
      {"id": "diagnosis",    "headingHint": "诊断",         "required": true,  "order": 4},
      {"id": "explore",      "headingHint": "背景与调研",   "required": false, "order": 5}
    ],
    "audienceVariantNote": "审批场景 policy 前置；组织落地场景 policy+operations 前置；diagnosis/explore 殿后但不可删"
  }
}
```

规则要点（structure 之外的风格规则）：
- 方针三问：每条 guiding policy 通过 Applicable / Enforced / Creates Leverage 三问（Exec Primer 质量门）。
- 取舍显性：方针必须写明放弃了什么（「选择 A 意味着不做 B」）；无取舍的方针是 fluff。
- 反模式四禁（Rumelt）：fluff、不直面挑战、目标当战略、坏目标——review 时逐条对照。
- 具体性：政策用比例/阈值/机制表述（「新服务默认 Rust，除非 X」「每季度 20% 平台时间」），不写方向形容词。
- 长度纪律：正文 1-2 页起步假设（愿景类封顶 2 页），细节外链；假设读者在第三页消失。
- Show your work：诊断保留数据与推理（roadmap、竞争压力、财务约束、1:1 收集的问题），供未来读者追溯。
- 文档自带元数据：日期、审批状态、canonical source 链接、去哪提问（具名渠道或人）。
- 发布前由未参与者读一遍标出不清楚处（写作流程中的 review 阶段承载，进 SKILL.md 路由说明）。

`applicableLanguages: ["zh","en"]`。

## 6. Schema 变更（Tier B）

`check-profile.lib.mjs` 的 `validateProfile` 增加对可选 `structure` 字段的校验：

```
structure?: {
  openingPattern?: "scqa" | "none",
  sections: [{ id, headingHint, required: boolean, order: number }],
  audienceVariantNote?: string
}
```

约束：
- `sections` 非空时 `id` 唯一、`order` 严格递增、`order` 从 1 起。
- `openingPattern` 目前仅 `"scqa" | "none"` 两个值——枚举保持最小，未来有书证再扩。
- 无 `structure` 字段的 profile（全部既有 profile 与三个 Tier A 新 profile）行为不变。**加法、可选、向后兼容**；`schemaVersion` 保持 `1`（旧 reader 读新 profile 只是忽略未知字段失败——注意：现有 `readObject` 拒绝未知字段，所以这不是「旧 reader 兼容」而是「同版本内加可选字段」。若未来有跨版本 profile 流转需求再升 v2，当前 profile 只在包内分发，无此需求）。

**机械验证边界（关键决策 D5）**：check 阶段对 `outline`（结构骨架，刻意不叫 `structure`——那是既有 review stage 的名字，见下）只验证两件事：
1. `required:true` 的节在最终正文中存在（按 heading 匹配，见下）；
2. 出现的骨架节之间保持声明的相对顺序。

**不验证**：节的写作质量、SCQA 是否真的写成了 SCQA、方针是否隐含取舍——这些是 review 阶段的模型判断，写进 profile rules 与 review rubric。这条边界是对「prompts, not gates」承诺的延续。

**概念命名（P1-4 折叠）**：新概念统一叫 `outline`（profile 的字段名仍为 `structure`，因为它描述文档结构本身；但 finding/检查结果类别叫 `outline`）。`structure` 一词已被 review stage（`STAGES`，`schema.lib.mjs:156`）与 proposal intent（`PROPOSAL_INTENTS:177`）占用，二者都是模型判断面（`reviews/` 工件）；新检查是机械面，混名会让实现者把它挂进 structure review 流。

**工件归属与回放契约（P0-1 折叠）**：outline 检查结果**不进** check 工件的 `changes` 数组。`changes` 的每一项是 `{type ∈ CHANGE_TYPES, before, after, disposition, reason}`（`check-profile.lib.mjs:44-90`），由 `compareBodies` 独家生产，`record.lib.mjs:390-408` 的 `verifyMechanicalChanges` 会拒绝任何机械重放无法复现的 change——「required 节缺失」是 after-body 的绝对属性，没有自然的 before/after 表示，塞进 `changes` 要么过不了重放校验、要么被迫伪造 diff。改为在 check 工件增加一个**顶层 `outline` 字段**：

```
outline?: {
  status: "compliant" | "non-compliant",
  missingRequiredSections: string[],   // section id 列表
  orderViolations: [{section, declaredOrder, actualOrder}]
}
```

- `outline` 是 after-body 的纯函数：check 记录时计算，重放时按 body hash 重新计算比对——与 `checks/` 工件「可独立验证」的契约同构，且**完全不动** `CHANGE_TYPES`、`compareBodies`、`verifyMechanicalChanges` 与 `mechanicalStatus`（`clean` 仍只表示机械 diff 为空，不再隐含 outline 合规——二者分离，各自诚实）。
- `outline.status === "non-compliant"` 产生一个类别为 `outline` 的 open finding，走既有 proposal→apply→re-check 循环（finding 不可变 + addressed 派生标签语义原样复用），不新增状态机状态。
- `outline` 字段仅当 profile 声明了 `structure` 时出现；其余 profile 的 check 工件形状不变。

**匹配器规格（P1-3 折叠，钉死为纯 heading 匹配）**：
- 只匹配 **H2**（ATX `##`）。setext 标题按 `markdown.lib.mjs:136` 现状视作 prose，不参与匹配——这是已知限制，写进 contracts.md。无 H2 的文档 ⇒ 所有 required 节报 missing。
- `headingHint` 是 `/` 分隔的备选标题列表（如 `"TL;DR / 摘要"`）；匹配规则：对每个 H2 标题文本 trim + 小写化后，与每个备选的 trim + 小写化做**相等**比较（不做子串、不做语言归一）。命中即认为该骨架节存在。
- 相对顺序：**只对命中了骨架节的 H2 之间**比较 declaredOrder 严格递增；未命中任何骨架节的 H2（作者自己的章节）位置任意，不影响判定。optional 节缺失合法。
- 无位置回退。作者换了标题写法导致漏检 ⇒ 判 compliant（软匹配漏检），由 review 阶段的 profile rule 兜底——这保持判定确定性且可回放，代价（漏检）在 contracts.md 里如实声明。`synonyms` 数组留作 profile 作者的手动扩备选手段（`headingHint` 的 `/` 列表本身就够用），不做模糊匹配。

## 7. 实现清单（按文件）

| # | 文件 | 变更 |
|---|---|---|
| 1 | `scripts/schema.lib.mjs:141` | PROFILES 增加 4 个 id |
| 2 | `profiles/technical-essay.json` 等 ×4 | 新 profile（§5 规格） |
| 3 | `scripts/check-profile.lib.mjs` | validateProfile 增加 structure 校验 |
| 4 | `scripts/commands.lib.mjs` / check 相关 | check 工件增加顶层 `outline` 字段（§6 规格：纯函数计算 + 按 body hash 重放；`CHANGE_TYPES`/`compareBodies`/`verifyMechanicalChanges`/`mechanicalStatus` 全部不动） |
| 5 | `references/contracts.md` | Brief.profile enum 文案 + §6 增 structure 契约 |
| 6 | `article-writing/SKILL.md` | 路由表加 4 行（:40）+ profile 描述段（:67-73）+ 触发描述加「技术战略/路线汇报」 |
| 7 | `article-review/SKILL.md` | 补 profile 行（现缺） |
| 8 | `language-editing/SKILL.md:37` | 「closest profile」文案列举更新 |
| 9 | `README.md` + `README.zh.md` | genre 句 + profile 数（four→eight）双语同步 |
| 10 | `README.i18n.yaml` | `pnpm check:readme --write` 重录哈希（记忆里的坑：`pnpm docs:parity` 不透传，用 check:readme 的 write 通道） |
| 11 | `tests/package-shape.spec.ts:23` | PROFILE_IDS 加 4 id（驱动 schema 校验循环） |
| 12 | `tests/contracts.spec.ts` | enum pin 补新 id 用例 + structure 校验正反用例 + poetry 仍失败 |
| 13 | `tests/workflow.spec.ts` / fixtures | 增加 engineering-strategy 的 structure lint 用例（节缺失→open finding→apply→绿） |
| 14 | 仓库根 `.claude-plugin/marketplace.json:16-19`（注意：**不在**插件包内——插件包只带 `.claude-plugin/plugin.json`；评审 P2-5 纠正了原稿的错误路径） | 描述句更新（无测试 pin，纯文案） |

不做：`OPERATIONS`、`BRIEF_FIELDS`、`derivePhase`、`nextRequiredStage`、capability manifest（`docs/claude-code-capabilities.yaml` 无 dsh-cc-writing 行，已核实）、cc-plugin-loader 测试（4-skill 不变）。

## 8. 验证计划

1. **单测**（vitest，包内）：structure 校验正反用例（缺失 required 节 / 顺序颠倒 / 无 structure 的 profile 不受影响）；profile 循环校验（package-shape 自动覆盖 4 个新 JSON）；enum pin（新 id 接受、`poetry` 拒绝）。
2. **端到端**（fixtures 驱动 `writing.mjs`）：init(profile=engineering-strategy) → record research/plan/draft → check 报 `outline.status="non-compliant"`（missingRequiredSections 非空，`changes` 为空且 `mechanicalStatus:"clean"`——二者分离各自诚实）→ proposal+apply 补节 → re-check `outline.status="compliant"` → finalize。断言 exit code、finding 类别与重放一致性（重算 outline 与记录值逐字段相等）。
3. **门禁**：`pnpm check:readme`、包内 vitest、（docs-only 部分不涉及）capability/parity 与本包无关已核实。
4. **活体验收**（实现后另行会话）：用一段真实技术战略素材走 article-writing + engineering-strategy profile，人工核对 SCQA 开头、policy 前置、诊断殿后是否符合 §5.4 规格。

## 9. 分期交付

**Phase 1（小 PR，纯数据，只含三个 Tier A profile）**：#1（enum 只加 technical-essay/academic/natural-prose 三个 id）、对应 #2 三个 JSON、#5-#10 文档同步、#11/#12。**engineering-strategy 整体推迟到 Phase 2**（评审 P1-2 折叠：`validateProfile` 的 `readObject` 拒绝未知字段，Phase 1 若带上含 `structure` 的 engineering-strategy.json 会直接红在 `package-shape.spec.ts:153-163` 的 profile 校验循环上；enum 条目与 profile 文件必须与 schema 能力同 PR 落地）。预计 diff ~450 行。

- **Phase 2（逻辑 PR，叠在 Phase 1 上）**：#3/#4 `structure` schema + check 工件 `outline` 字段与匹配器（§6 折叠后规格）+ engineering-strategy profile 与 enum 条目 + #13 端到端用例 + contracts.md §6。预计 diff ~400 行。
- 两期一个 worktree 栈式 PR，Phase 2 base Phase 1。

## 10. 风险与开放问题

1. **heading 匹配的脆性**（已在 §6 折叠定案：纯 headingHint 相等匹配 + 无位置回退，漏检走 review 兜底，contracts.md 声明）。剩余开放问题只有：中文标题的全角/半角差异是否先做 NFC 归一——倾向做（一行代码，判定仍确定）。
2. **profile 静默缺失**（现状 `state.lib.mjs:56` 缺文件返回 null）：enum 扩到 7-8 个后，「enum 有、文件缺」的配置错会更常见。建议 Phase 1 顺手把 loadProfile 对「enum 内 id 缺文件」改为响亮失败。折叠补充（P2-6）：失败码用 `INVALID_INPUT`，在 `loadRun` 边界抛出；影响面=同 run 的所有状态加载命令，但 profile 随包分发、包内不缺文件，实际触发仅限插件降级/手改磁盘的病态场景；单列 commit，message 里声明预期可观察变化。
3. **natural-prose 与既有本地清理技能的边界**：文档面需写清分工（workflow 内规则化 vs 一次性成稿清理），避免用户困惑双通道。仅 README/SKILL 文案，无代码。
4. **双语规则撰写成本**：profile 的 instruction 是语言无关还是 zh/en 双写？现状 `technical-ste` 只有 en。决定：三个日常文体 rules 写英文（模型消费，语言无关），headingHint 与面向用户的提示双写。engineering-strategy 的中文战略文档市场很大，其 rules 用英文写但 examples 双语。
5. **structure 字段的长期形态**：若未来 academic 也要骨架（IMRaD），该字段须支持 per-language 变体（中文论文骨架）。当前只有 engineering-strategy 消费，先不做变体机制，YAGNI。
