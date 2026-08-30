# Workspace 与最终报告模板

## 语言与原文边界

- 最终研究报告及其他面向用户的综合交付默认使用中文。只有用户明确要求其他语言时，才切换对应交付物的语言；英文问题或英文文献本身不构成英文交付要求。
- 报告标题、章节名、表头、图注、结论与解释性正文使用交付语言。论文题名、必要的原文引文、参考文献、代码、路径、C/E/G/H ID、公式和化学式保留原文，并在需要时用中文解释，不机械翻译或改写。
- `review_update`、`adjacent_tension`、`hybrid`、Gap 状态值和稳定 ID 是协议值，不因报告语言而改名。

## 最低文件

```text
analysis/research-scope.md
references/evidence-ledger.md
output/research-report.md
```

按需增加：

```text
analysis/anchor-reviews.md
analysis/search-frontier.md
analysis/literature-map.md
analysis/research-gaps.md
analysis/conflict-matrix.md
analysis/adjacent-literature-map.md
output/hypotheses.md
```

文献工具生成的 `references/searches/*.json` 与 `references/papers/**` 是 provenance 和全文载荷，不改写其格式或内容。

## 证据账本索引

```markdown
# 证据账本

## 来源组
| 来源组 | 版本/论文 | 独立性说明 |
|---|---|---|

## 证据索引
| E ID | 原始观察 | 来源组 | 全文位置 | 质量 |
|---|---|---|---|---|

## 综合结论索引
| C ID | 综合结论 | 状态 | 支持/反驳 E IDs | 独立来源组 |
|---|---|---|---|---|
```

完整 E/C 字段使用 `evidence-synthesis` 的 reference，不在报告中复制全文账本。

## Gap 状态表

```markdown
| G ID | 归一化 Gap | 状态 | 范围 | 关键 C/E IDs | 独立来源组 | 剩余范围 | 截至日期（as-of date） |
|---|---|---|---|---|---|---|---|
```

## 最终报告模板

```markdown
# 科研发现报告

## 核心结论
- 研究问题：
- 截至日期（as-of date）：
- 主要路径：review_update | adjacent_tension | hybrid
- 高置信度发现：
- 最重要的剩余不确定性：

## 范围与方法
- 纳入与排除范围
- 路径选择及变更
- 检索服务、查询族与审计路径
- 综述检索截止时间（review cutoff）或相邻圈层覆盖
- 停止理由

## 领域地图与锚点综述
- 主锚点综述与校准综述
- 权威性判断依据与局限
- 综述卡片（Review Card）或相邻文献地图引用

## 证据支持的发现
### C-### — <综合结论>
- 判断与适用范围
- 支持/反驳 E IDs
- 独立来源组
- 条件与置信度

## Gap 状态更新
| G ID | 原始 Gap 种子/张力 | 当前状态 | 状态变化及原因 | 剩余范围 |
|---|---|---|---|---|

## 冲突与边界条件
- 冲突 ID、候选根因与认识状态
- 仍需补充的判别性证据

## 假设与研究方向
### H-### — <可证伪假设>
- 预测、反证条件与首个判别性研究
- 长期延展与终止证据

## 限制与负结果
- 缺失或获取失败的全文
- 可比性与来源追溯限制
- 未产生状态变化证据的检索分支
- 无法判断（indeterminate）的事项

## 复现路径索引
- 检索审计路径
- 论文与全文路径
- Evidence/Gap/Hypothesis 文件
- 独立复核产物
```

## ID 契约

- `E-###`：单篇来源的原始 Observation 与精确位置。
- `C-###`：跨来源综合 Claim。
- `G-###`：带状态历史的 Gap。
- `H-###`：可证伪 Hypothesis。

不要在最终报告中重新分配已经存在的 ID。合并 Agent 结果时先解决重复或冲突 ID，再更新索引。
