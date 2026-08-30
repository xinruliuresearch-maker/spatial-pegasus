# 路径选择与切换

## 初始探测

用少量、互补的查询回答四个问题：

1. 是否存在与命题 scope 直接匹配的 Review、Systematic Review 或 Roadmap？
2. 直接 primary papers 是否足够形成至少两个独立来源组？
3. 研究对象是否只是新命名，而其上位材料/机制已有成熟文献？
4. 相邻研究能否在明确条件下比较，而不是仅有词面相似？

把探测结果写入 `analysis/research-scope.md`，包括检索时间、查询、命中类型和不确定性。

## 路径判定

| 观察 | 首选路径 | 同时保留的备选 |
|---|---|---|
| 直接领域有 scope 匹配且可取全文的综述 | `review_update` | 对综述遗漏或最新对象使用 `adjacent_tension` |
| 只有上位领域综述，具体对象文献稀少 | `hybrid` | 用直接论文随时校正综述地图 |
| 无合格综述，但有可比 primary studies | `adjacent_tension` | 若后续发现上位综述，升级为 `hybrid` |
| 直接与相邻文献都不足 | `adjacent_tension` 探索模式 | 降低结论等级，只产出 provisional Hypothesis |

不要把路径判定成一次性状态。出现以下情况时切换或并行：

- 锚点综述 scope 与用户命题错位；
- 综述 cutoff 后出现新的材料类别或方法范式；
- 直接文献数量少，但相邻文献形成稳定的可比轴；
- 原以为是冲突，归一实验条件后变成 boundary condition；
- 新发现的上位综述能解释相邻研究为何可迁移或不可迁移。

## 研究范围模板

```markdown
# Research scope

- Research question:
- As-of date:
- Intended decision/output:
- Included material/composition:
- Structure/interface/morphology:
- Mechanism/phenomenon:
- Synthesis/process:
- Characterization/computation:
- Application/function/endpoint:
- Operating regime/scale/failure mode:
- Exclusions:
- Initial path: review_update | adjacent_tension | hybrid
- Why this path:
- Evidence limitations:
- Open questions:
```

## 失败模式

- **见到一篇综述就锁定 `review_update`**：先检查 scope、类型和全文，再用校准综述检查偏差。
- **把“没有直接命中”当作没有文献**：拆解目标 tuple，沿多个相邻轴扩展。
- **为了完整而机械执行三条路径**：只运行能减少当前关键不确定性的分支。
- **开局同时创建大量 Agent**：先确认可并行的独立认知任务，保留复核槽位。
- **路径切换后遗失旧证据**：保留旧 C/E/G/H IDs，记录状态变化原因，不覆盖历史。
