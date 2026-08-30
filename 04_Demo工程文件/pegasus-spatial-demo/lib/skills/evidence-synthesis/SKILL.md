---
name: evidence-synthesis
description: >
  从材料科学论文全文构建可定位的 E/C 证据链，归一实验条件，判断论文对 Gap 的响应并分析真实冲突。用于多篇论文比较、Claim–Evidence 综合、Paper × Gap 响应矩阵、条件依赖或结论不一致分析时；不用于只发现文献、只读元数据、凭摘要或检索分数定论、无来源自由写作或最终报告排版。
---

# 科学证据综合

把论文里的 Observation 与跨论文 Claim 分开。先保存原始条件和精确位置，再综合；不要让顺畅叙述覆盖不确定性。

## 从全文建立 Evidence

1. 用 `SciverseFetchPaper` 或 `ArxivFetchPaper` 保存候选全文。
2. 用 `SearchDocument` 定位 Results、Methods、Discussion 与 Limitations，再用 `Read` 获取上下文。
3. 为每个原始观察创建 `E-###`，记录论文身份、版本组、全文路径、页/章节/行或 byte offset、短摘录、条件、单位、作者解释与证据质量。
4. 将预印本与期刊版归入同一来源组；综述对 primary study 的转述不能成为新的独立来源。
5. 摘要或无法取得全文的内容只能形成 `provisional Evidence`。

完整 Evidence Ledger 和 Paper × Gap 响应矩阵模板见 `/skills/evidence-synthesis/references/evidence-ledger-and-matrix.md`。

## 综合 Claim

- 为跨论文判断创建 `C-###`，明确支持、反驳、限定和独立来源组。
- 最终 Claim 至少需要两条独立来源链；否则标记 `single-source / provisional`。
- 不按论文数量投票。先判断研究是否独立、条件是否可比、终点是否同义、证据质量是否相当。
- 保留负结果、异常、置信区间和作者未解决的解释，不只抽取摘要式正面结论。

## 归一比较条件

比较前统一记录样品来源/成分/缺陷、制备与热历史、结构状态、环境/边界、测量/标定/分辨率、endpoint/单位、数据处理/统计、模型假设/baseline、时间/老化/尺度。

若差异可由条件解释，生成 boundary-condition Claim 或 Gap；只有在相似条件下仍存在方向、量级、机制、方法排名或复现性差异时，才称实质冲突。

冲突根因维度、认识状态与反例见 `/skills/evidence-synthesis/references/conflict-analysis.md`。

## 判断论文如何回应 Gap

对每篇全文与每个 Gap 标注：

- `direct_response`
- `partial_response`
- `indirect_response`
- `contradict`
- `qualify`
- `no_response`

每个标签必须有 E IDs 和适用 scope；retrieval score 不能决定响应关系。将矩阵交给 `gap-and-hypothesis` 更新 Gap 状态。

## 交付检查

- 每条 E 都能回到全文位置。
- 每条 C 都区分 observation、author interpretation 与 agent synthesis。
- 来源组去重，并解释独立性。
- 单位、条件和 endpoint 已归一，无法归一处显式标记。
- 冲突未被平均，条件差异未被误称为冲突。
