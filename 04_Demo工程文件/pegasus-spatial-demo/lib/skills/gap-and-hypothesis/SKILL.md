---
name: gap-and-hypothesis
description: >
  将综述 Gap seeds 与相邻文献张力更新为有范围、有状态、可反向检索的 research gap，并形成可证伪假设和长期研究方向。用于判断 gap 是否已回答、部分回答、条件性回答、争议或重构，以及设计判别性实验/计算时；不用于无证据 brainstorming、把综述旧观点直接当当前 gap、只做文献发现或在全文和可比性不足时宣称 unresolved。
---

# Research Gap 与可证伪假设

Gap 是带日期、scope 和检索覆盖的研究判断，不是论文里的一句话。综述提出的未来方向只生成 `candidate`；相邻文献中的张力只有通过比较、独立来源和反向检索后才可升级。

## 更新 Gap 状态

使用以下 Markdown 状态词汇：

- `candidate`
- `unresolved`
- `attempted`
- `partially_answered`
- `conditionally_answered`
- `contested`
- `answered`
- `reframed`
- `indeterminate`

每个 `G-###` 记录 origin、scope、status、as-of date、review cutoff 或相邻文献范围、支持/反驳 C/E IDs、独立来源组、检索覆盖、confidence、remaining scope、successor Gap 与状态历史。

完整状态定义、升级门槛和 Gap Register 模板见 `/skills/gap-and-hypothesis/references/gap-register.md`。

## 运行反向 Novelty 检索

- 将候选 Gap 改写成可能已经解决它的论文标题、方法名、机制词和 endpoint。
- 检索 cutoff 后关键词、引用图、related works 和最新 arXiv；不要只搜索“gap”或原综述措辞。
- 主动搜索否定候选 Gap 的证据：成熟方案、复现、benchmark、条件限定或已有长期验证。
- 获取关键全文，使用 Paper × Gap 响应矩阵更新状态。
- `unresolved` 只能表述为：“截至某日期，在已记录的检索范围内尚未找到满足条件的解决方案。”
- 全文、解析、来源独立性或可比性不足时使用 `indeterminate`。

## 从 Gap 形成 Hypothesis

只有满足以下条件才将张力升级为 Gap 或 `H-###`：

- 至少两条独立来源链；
- 相似条件下仍存在未协调差异，或已识别明确 boundary condition；
- 反向检索未发现成熟解决方案；
- 能提出判别性实验、计算或数据分析；
- 对科学理解或应用有明确意义。

为 Hypothesis 写出变量、机制、方向性预测、适用边界、替代解释、反证条件和最低验证路径。R3 相邻文献只能支持 provisional Hypothesis，不能证明目标材料 Claim。

长期方向评估与模板见 `/skills/gap-and-hypothesis/references/hypothesis-and-directions.md`。

## 完成检查

- 不把 `answered` 当“有一篇论文回应”。
- 保留部分、条件性和争议范围，不把旧 Gap 整体关闭。
- 由条件解释的冲突形成 successor Gap，而不是消失。
- 最终 G/H 至少关联两条独立来源链；否则标记 `single-source / provisional`。
- 记录负检索证据的范围与停止理由，不声称穷尽所有文献。
