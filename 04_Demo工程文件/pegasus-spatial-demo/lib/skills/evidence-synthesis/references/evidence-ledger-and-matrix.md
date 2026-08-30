# Evidence Ledger 与响应矩阵

## Evidence 条目

```markdown
## E-### — <atomic observation>

- Source: title, DOI/arXiv ID/doc_id
- Version/source group:
- Evidence type: experiment | computation | dataset | review synthesis
- Full-text path:
- Location: page/section/line/chunk/byte offset
- Short excerpt:
- Observation in own words:
- Material/sample:
- Process/history:
- Structure/state:
- Environment/boundary:
- Measurement/model:
- Endpoint, value and unit:
- Data/statistical treatment:
- Author interpretation:
- Agent inference, if any:
- Quality: full-text | provisional
- Limitations:
- Related C/G/H IDs:
```

一条 E 只表达一个可定位 Observation。短摘录用于定位，不替代上下文。

## Claim 条目

```markdown
## C-### — <synthesized claim>

- Scope:
- Status: supported | qualified | contested | provisional
- Supporting E IDs:
- Contradicting E IDs:
- Qualifying E IDs:
- Independent source groups:
- Comparability notes:
- Confidence and why:
- Remaining uncertainty:
- Related G/H IDs:
```

最终 Claim 至少关联两个独立来源组。若只有一个，写 `single-source / provisional`，即使该论文引用数很高。

## 来源独立性

以下通常不独立：

- 同一研究的 arXiv、会议、accepted manuscript 与期刊版本；
- 多篇综述重复转述同一 primary study；
- 同一数据集被不同论文重复分析但没有新观测；
- 高度重叠的作者团队和同一实验批次，除非有明确独立复现。

记录 `source_group` 与判断依据，不要只靠 DOI 去重。

## Paper × Gap 响应矩阵

| Paper/source group | Gap | Response | E IDs | Scope matched | Scope not matched | Notes |
|---|---|---|---|---|---|---|
| P-### | G-### | direct_response | E-### | ... | ... | ... |

标签定义：

- `direct_response`：研究直接测试 Gap 的关键问题和判别标准。
- `partial_response`：只覆盖部分 scope、条件或 endpoint。
- `indirect_response`：提供相关机制/方法证据，但未直接测试 Gap。
- `contradict`：在可比条件下得到相反方向、机制或方法结论。
- `qualify`：说明原 Gap 仅在某些边界条件成立。
- `no_response`：主题相关但没有回答该 Gap；不能因标题相似而提升。

## 质量优先级

优先使用可定位全文、方法与条件完整、数据透明且能判断来源独立性的 primary evidence。摘要、新闻、搜索 snippet、单个 retrieval chunk 或综述的二手转述不能单独关闭 Gap。
