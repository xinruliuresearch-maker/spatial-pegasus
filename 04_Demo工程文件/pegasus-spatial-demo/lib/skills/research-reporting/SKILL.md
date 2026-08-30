---
name: research-reporting
description: >
  将材料科学研究范围、锚点综述、全文证据、冲突、Gap 状态、Hypothesis 与长期方向汇总为可审计的 Markdown 报告。用于完成实质性调研、形成 research gap 报告、博士选题建议或向用户交付综合结论时；不用于早期文献发现、缺少证据账本时补写结论、只做单篇摘要或纯语言润色。
---

# 科研报告撰写

从 Workspace 中已有的 C/E/G/H 与检索审计写报告，不从记忆补齐证据。报告服务于判断：哪些问题已回答、哪些部分或条件性回答、哪些仍开放、哪里存在真实冲突，以及下一步如何证伪。

## 最低输入

- `analysis/research-scope.md`
- references/evidence-ledger.md
- 适用的 anchor review、search frontier、literature map、Gap register、conflict matrix 或 adjacent map
- 独立复核结论

若关键输入缺失，先回到相应 Skill 补齐；不要用流畅文字掩盖缺口。

## 报告结构

1. 研究命题、scope、as-of date 与所用路径。
2. 锚点综述或相邻文献地图及选择依据。
3. 综述 cutoff 后或相邻圈层的检索覆盖。
4. 关键 C-IDs 及 E-IDs、独立来源组与适用条件。
5. Gap 状态表：已回答、部分/条件性回答、争议、开放、重构与不确定。
6. 冲突及根因认识状态。
7. 可证伪 H-IDs、判别性研究与长期方向。
8. 限制、负结果、未决项、停止理由和复现路径。

详细 workspace 和报告模板见 `/skills/research-reporting/references/markdown-templates.md`；科学措辞与常见失败见 `/skills/research-reporting/references/language-and-failures.md`。

## 写作规则

- 最终研究报告及其他面向用户的综合交付默认使用中文；只有用户明确要求其他语言时，才按其要求切换对应交付物的语言。用户问题、论文或成员材料主要使用英文，本身不等于用户明确要求英文交付。
- 中文交付覆盖报告标题、章节名、表头、图注、结论和解释性正文。论文题名、必要的原文引文、参考文献、代码、路径、C/E/G/H ID、公式和化学式保留原文，不为追求表面全中文而改写；其上下文解释仍使用中文。
- 每个重要科学判断就近引用 C/E/G/H IDs 和来源路径。
- 区分 source observation、author interpretation、agent synthesis 与 hypothesis。
- 用 scope 与条件限定结论；不把“没有找到”写成绝对不存在。
- 不声称“影响因子最高”或“最权威”，除非有带名称、年份、来源的外部权威指标。
- 明确 `single-source / provisional` 和 `indeterminate`。
- 保留分歧，不用平均化叙述制造虚假共识。
- 对博士或长期方向同时说明首个判别性研究、纵深、风险、负结果价值和终止证据。

## 交付检查

- 除非用户明确要求其他语言，面向用户的综合叙述与报告结构均为中文；保留原文的内容仅限论文题名、必要引文、参考文献、代码、路径、ID、公式和化学式等不应改写的对象。
- 所有 C/E/G/H ID 可在 Workspace 找到定义。
- Gap 状态与最新矩阵、as-of date 和状态历史一致。
- 报告没有把 arXiv 身份、引用数、retrieval score 或 `impact_boost` 当作证据质量。
- 最终 C/G/H 满足两条独立来源链；例外均显式降级。
- 公开检索覆盖、解析限制、未决分支与停止理由。
