---
name: literature-discovery
description: >
  为材料科学命题发现锚点综述、综述 cutoff 后的新研究、引用图与相邻文献，并保存可复现的检索审计。用于建立领域地图、追踪旧 review 提出的 gap、搜索 arXiv 最新进展或为新材料扩展可比文献时；不用于只阅读一篇已提供论文、仅做全文证据抽取、直接判定科学结论真假或凭检索分数宣称 gap 已解决。
---

# 科研文献发现

把检索设计成能改变研究判断的 query families。Sciverse 负责元数据、全文证据和引用关系，arXiv 负责扩展更新与更广的相关研究；来源平台本身不等于证据强度。

## 先做小规模探测

1. 将命题拆成材料、结构、机制、方法、endpoint 和限制条件。
2. 分别探测综述、直接 primary papers 与最新 preprints 的密度。
3. 记录 as-of date、查询、过滤器、排序、分页和审计路径。
4. 根据结果采用 `review_update`、`adjacent_tension` 或 `hybrid`；三者可并行或切换。

## 发现锚点综述

- 默认选择一篇 scope 最匹配的主锚点综述，加 1–2 篇不同团队、时间或方法口径的校准综述。
- 综合判断 scope、类型确认、全文、方法透明度、覆盖、引用信号、venue 认可度与团队独立性。
- 除非存在明确的外部权威指标，不得声称“影响因子最高”或“最权威”。
- Sciverse `impact_boost` 是保留相关性的影响力排序倾向，不是 Journal Impact Factor (JIF)。用它发现候选时显式设置 `sort_by_year: "none"`；最新论文用单独的时间排序查询。
- 获取全文后再确认 Review/Systematic Review/Roadmap 类型、scope、cutoff 与 Gap seeds。

执行综述发现、Review Card、cutoff 和 post-review 更新前，读取 `/skills/literature-discovery/references/review-update.md`。

## 更新综述后的研究

- 从综述自报检索截止日期开始；缺失时按既定回退规则重叠搜索，不能只从发表日开始。
- 为每个 Gap seed 创建独立 query family：原表述/同义词、材料+机制、方法+endpoint、限制/异常、cutoff 后日期检索。
- 用 `SciverseListRelations` 扩展 `CITATIONS`、`RELATED_WORKS` 和必要的 `REFERENCES`，但不要只查引用综述的论文。
- 用 `ArxivSearchPapers` 的 `newest` 分支补充最新研究；arXiv 是证据扩展源，不是自动“验证源”。
- 对候选全文使用 `SciverseFetchPaper` 或 `ArxivFetchPaper` 落盘；摘要和 chunk 仅用于入选筛查。

## 扩展相邻文献

- 按 R0→R1→R2 同心扩展；仅在 transfer bridge 清楚时进入 R3。
- 沿八个可解释轴分别记录相邻性，不合并成单一“相关分数”。
- 每篇文献同时记录 `transfer bridge` 与 `analogy break`。
- 在条件可比性下降且没有产生新张力时停止扩圈。

执行相邻检索前读取 `/skills/literature-discovery/references/adjacent-search.md`；处理低召回、重复版本、类型误判等问题时读取 `/skills/literature-discovery/references/failure-modes.md`。

## 交付

将查询前沿写入 `analysis/search-frontier.md`，锚点写入 `analysis/anchor-reviews.md`，相邻文献写入 `analysis/adjacent-literature-map.md`。保留文献工具生成的 Workspace 路径 references/searches/*.json、论文 metadata、provenance 和全文路径，不手工篡改。
