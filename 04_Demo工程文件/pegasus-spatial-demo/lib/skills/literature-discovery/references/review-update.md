# 锚点综述与 Post-review 更新

## 权威性不是单一分数

按以下维度比较候选，不以一个数字替代判断：

1. 与用户命题的 scope 匹配度；
2. Review/Systematic Review/Roadmap 类型是否由摘要、全文或出版页确认；
3. 全文可访问性；
4. 纳入范围和方法透明度；
5. 领域覆盖和关键 primary studies；
6. Sciverse citation / influential citation 信号及查询日期；
7. venue 的领域认可度；
8. 与其他锚点综述的作者、语料和观点独立性。

`impact_boost` 只帮助相关性排序中的影响力偏好，不提供 Journal Impact Factor。若使用，调用 `SciverseSearchPapers` 时显式传 `sort_by_year: "none"`。JIF 只有在外部权威数据明确给出指标名称、年份和来源时才可报告。

## Review Card 模板

```markdown
## RV-### — <title>

- Role: primary anchor | calibration
- Identity: DOI / unique_id / doc_id
- Publication: venue, date
- Full-text path:
- Type confirmation: confirmed | probable | unclear
- Type evidence:
- Scope included:
- Scope excluded:
- Review method/transparency:
- Citation signal: value, field, queried_at
- Reported search cutoff:
- Latest included-reference date/year:
- Effective update boundary:
- Selection rationale:
- Independence from other anchors:
- Known bias/limitations:
- Gap-seed locations:
```

## Cutoff 判定

Post-review 搜索起点按以下顺序：

1. 综述明确声明的检索截止日期；
2. 最新纳入参考文献的日期或年份，并从该年份开始重叠搜索；
3. 两者都不可得时，从综述发表日期前十二个月开始，并标记 `estimated boundary`。

记录原始依据与推导过程。不能只用正式发表日，因为投稿和审稿期间可能已有新工作。

## Gap Seed 抽取

从 Discussion、Limitations、Future Outlook 和正文综合抽取。每个 seed 只标记 `candidate`，并记录：

- 原始全文位置与短摘录；
- 规范化问题；
- 材料、条件、机制和 endpoint scope；
- 类型：knowledge / mechanism / method / data / validation / translation；
- 来源综述与 cutoff；
- 隐含假设；
- 什么证据可以回答或反驳它。

## Post-review 查询族

每个 seed 至少覆盖：

- 原表述、关键词拆分与同义词；
- 材料实体 + 机制；
- 方法 + endpoint；
- 限制条件、异常或失败模式；
- effective boundary 之后的关键词与日期查询；
- 主综述 `CITATIONS`；
- `RELATED_WORKS`，必要时回查 `REFERENCES`；
- 最新性敏感主题的 arXiv `newest` 查询。

不要只追踪引用综述的论文。真正回应 Gap 的研究可能采用不同术语，也可能未引用该综述。

## 检索记录模板

```markdown
### Q-###
- Gap IDs:
- Query family:
- Provider/tool:
- Query and filters:
- Sort/boost:
- Date executed:
- Audit path:
- New independent sources:
- State-changing evidence:
- New moderator/conflict:
- Next branch or stop reason:
```
