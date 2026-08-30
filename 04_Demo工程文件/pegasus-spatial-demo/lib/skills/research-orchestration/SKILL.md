---
name: research-orchestration
description: >
  为材料科学的实质性文献研究选择 review_update、adjacent_tension 或 hybrid 路径，并动态组织 Agent、研究产物与停止条件。用于用户给出科研命题、要求系统调研、发现 research gap、评估原创方向或规划长期研究时；不用于简单事实解释、产品讨论、纯文件操作、文案润色或只摘要一篇已提供的论文。
---

# 科研研究编排

把研究方法当作可切换的探索策略，不要当作固定流水线。先界定命题和证据缺口，再选择最小但充分的路径与团队；发现新证据时允许回退、并行或改路。

## 建立研究契约

1. 将用户命题操作化为材料/组成、结构或界面、机制或现象、方法、应用 endpoint、环境/尺度与排除范围。
2. 记录 as-of date、已有输入、未知项、成功标准和证据限制。
3. 对实质性调研至少维护：
   - `analysis/research-scope.md`
   - references/evidence-ledger.md
   - `output/research-report.md`
4. 在首次实质检索前调用所需方法 Skill；至少加载 `literature-discovery`，随后按任务加载 `evidence-synthesis`、`gap-and-hypothesis`、`scientific-review` 与 `research-reporting`。

## 选择并组合路径

- `review_update`：直接领域已有可用综述。用综述建立领域地图和 Gap seeds，再更新其检索 cutoff 之后的研究。
- `adjacent_tension`：直接研究稀少或没有合格综述。沿材料、结构、机制、方法和场景寻找可比文献，从尚未协调的张力中生成 Gap。
- `hybrid`：具体对象很新但存在上位领域综述。用综述限定问题空间，用相邻文献生成、检验和缩小具体 Gap。

先小规模探测再选路。直接文献密度、综述质量或可比性判断改变时，切换或并行路径，不要为了保持原计划忽略新证据。具体判据与回退方式见 `/skills/research-orchestration/references/path-selection.md`。

## 守住证据底线

- 单篇论文的可定位结果可以成为 `E-###` 单源 Observation。
- 最终 `C-###` Claim、`G-###` Gap 和 `H-###` Hypothesis 必须关联至少两条独立来源链。
- 未满足时明确标记 `single-source / provisional`，不得写成已验证结论。
- 预印本与其期刊版、多个综述对同一 primary study 的转述只算一个独立来源组。
- 摘要、retrieval chunk 和排序分数只用于筛选；关键判断必须回到可定位的全文上下文。全文或可比性不足时保留 `indeterminate`。

## 动态组织 Agent

- 窄问题且能在单一上下文内完成：Root 独立执行。
- 有独立检索、全文抽取或复核分支：创建 1–3 个 Agent。
- 多 Gap、多材料体系或争议显著：初始创建 3–5 个 Agent。
- 不在开局占满执行槽；至少保留一个成员槽给后置复核或新证据分支。
- 按当前认知任务分派，不建立永久角色表；优先复用职责相符的 idle Agent。
- 首条任务写清目标、边界、证据标准、输入引用、可写产物、协作对象、完成与停止条件。
- 允许成员用 `SendMessage` 直接交换 C/E/G/H IDs、问题和文件引用；Root 观察、纠偏并负责最终综合。

详细团队决策、停止标准和常见失败见 `/skills/research-orchestration/references/team-and-stopping.md`。

## 独立科学复核门槛

- 任何实质性最终研究报告在标记完成前，必须加载 `scientific-review`，完成并持久记录至少一次独立科学复核；没有复核记录的产物只能称为 draft，不能称为最终报告。
- 多 Agent、多个 Gap、结论争议显著或拟关闭重要 Gap 的任务，必须由未主导相关检索/综合分支的隔离成员，从原始 Workspace artifacts 重建关键判断并复核，不能只审核 Root 的摘要。
- 窄问题由 Root 独立完成时，允许 Root 在冻结证据账本与报告草稿后，切换到明确的对抗性复核 pass，按 `scientific-review` 从原始 C/E/G/H、全文位置和检索审计重新检查，而不是边写边自我确认。
- 将复核结论持久记录在 `analysis/scientific-review.md`，或记录为最终报告可精确引用的不可变 Agent result / 私有复核 artifact；至少包含 reviewer、reviewed scope、证据路径、critical/major/minor findings、disposition 与未决项。
- 复核发现会改变 C/G/H、来源独立性或检索覆盖的 critical/major 问题时，先修订相应 artifacts，再对受影响判断复核。只有关键问题已处理，或明确降级为 provisional / indeterminate 后，才通过完成门槛。

## 完成前检查

- 范围足以支持实际结论，而不是支持最初想象。
- 高优先级论文已核查全文；来源版本与独立性已去重。
- 最终 C/G/H 满足多源底线，矛盾和限定条件没有被平均掉。
- Gap 已做反向 novelty 检索，并记录查询覆盖。
- 已存在可追溯的独立 `scientific-review` 记录；多 Agent/争议任务由隔离成员完成，窄 Root-only 任务已完成冻结草稿后的对抗性复核。
- 连续扩展的边际信息已降低，或停止是由明确资源限制导致。
- 报告公开 as-of date、未决项、解析限制、检索覆盖和停止理由。
