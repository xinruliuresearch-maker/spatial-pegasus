---
name: scientific-review
description: >
  对材料科学研究的综述选择、全文证据链、来源独立性、冲突归因、Gap 状态和 Hypothesis 做独立对抗性复核。用于重要结论发布前、复杂多 Agent 结果合并后、存在争议或需要同行式质量检查时；不用于代替初始文献检索、只做语言润色、机械复述已有报告或在没有可审计 C/E/G/H 与检索记录时给出通过结论。
---

# 科学独立复核

从原始 artifacts 重建关键判断，不默认接受 Root 或成员的叙述。目标是发现会改变结论、Gap 状态或研究方向的错误，而不是追求措辞一致。

## 复核顺序

1. 读取 `analysis/research-scope.md`，确认实际问题、as-of date、路径与排除项。
2. 抽样回读关键 E 的全文位置，检查 Observation、作者解释与 Agent inference 是否分开。
3. 审核 C/G/H 的独立来源组，合并预印本/期刊版和综述转述。
4. 检查锚点综述的 scope、类型、cutoff、校准综述和 authority 表述。
5. 检查 post-review 查询是否同时包含关键词、日期、引用图与适用的 arXiv 分支。
6. 检查相邻文献的八轴、transfer bridge 和 analogy break；R3 不得证明目标 Claim。
7. 重新判断表面冲突是否能由材料、工艺、条件、测量、数据或模型差异解释。
8. 检查 `answered`、`unresolved`、`contested` 与 `indeterminate` 是否满足定义。
9. 主动寻找反例、成熟解决方案、遗漏 moderator 和无法复现的证据链。

执行完整审查时读取 `/skills/scientific-review/references/review-checklist.md`；需要压力测试时读取 `/skills/scientific-review/references/adversarial-cases.md`。

## 输出复核结论

为每个发现给出：

- severity：`critical / major / minor`
- affected C/E/G/H IDs 与文件路径
- 可复现证据
- 为什么会改变科学判断
- 最小修正或需要补充的检索/实验
- disposition：`pass / revise / indeterminate`

没有证据的问题不要自行补全；把缺失项标为 `indeterminate`。若复核者与原团队结论不同，保留两套依据并指出判别性下一步。

## 通过门槛

- 最终 C/G/H 至少两条独立来源链；单源项已明确 provisional。
- 关键 E 可回到全文，摘要/chunk 没被当最终证据。
- Gap 状态、scope、as-of date 和检索覆盖一致。
- 权威性没有被引用数、venue 或 `impact_boost` 单独替代。
- 冲突与 boundary condition 被正确区分。
- 报告公开负结果、限制、未决项和停止理由。
