# 文献发现失败模式

## 常见错误与修正

- **把 `impact_boost` 写成 JIF**：只称其为影响力排序倾向，并记录查询日期；不要虚构期刊指标。
- **按年份排序后宣称是最权威结果**：权威候选检索用 `sort_by_year: "none"` 保留相关性；新颖性另做时间排序。
- **只搜索 review 标题词**：同时检索 Review、Systematic Review、Roadmap、Perspective 与领域特定综述术语，再用全文确认类型。
- **只用一篇综述**：默认加入 1–2 篇校准综述，检查团队、scope 和方法口径差异。
- **从发表日开始更新**：优先读取自报 cutoff，缺失时使用重叠边界。
- **只追 citations**：并行关键词、日期、related works 与 arXiv 分支。
- **将摘要或 chunk 作为最终证据**：先 Fetch，再用 `SearchDocument` 与 `Read` 取得精确上下文。
- **把不同版本算成独立证据**：合并 arXiv、accepted manuscript 与期刊版。
- **搜索零命中就宣称 Gap**：扩展同义词、实体、方法、endpoint 和相邻圈层，并公开覆盖范围。
- **R3 类比直接外推**：只生成 provisional Hypothesis，并记录 analogy break。
- **分页或容量中断却当作饱和**：区分工具失败、访问限制与真实边际信息下降。

## 低召回诊断

依次检查：

1. 查询是否混合多个意图；
2. 材料命名、缩写、化学式与旧名称；
3. endpoint 或机制是否有领域同义词；
4. 时间/venue/subject 过滤是否过窄；
5. 是否应从 metadata search 切换到 full-text evidence search；
6. 是否需要 citation graph 或相邻性轴扩展。

每次放宽条件只改变一个主要维度，才能解释召回变化。
