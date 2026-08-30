# Gap Register

## 状态定义

- `candidate`：来自综述、Discussion 或文献张力，尚未完成当前状态核查。
- `unresolved`：在记录的充分检索范围内未找到满足判别标准的解决方案。
- `attempted`：已有研究直接尝试，但证据不足以回答。
- `partially_answered`：只回答部分材料、条件、机制或 endpoint。
- `conditionally_answered`：在明确边界内回答，范围外仍开放。
- `contested`：可比的独立来源给出尚未协调的结论。
- `answered`：原 scope 被多条独立 primary evidence 覆盖，关键结果得到复核，重大反证已处理。
- `reframed`：原问题的假设、scope 或 endpoint 被证据改写；必须链接 successor Gap。
- `indeterminate`：全文、解析、来源独立性、可比性或检索覆盖不足，不能可靠判断。

## 状态转换原则

- 不以发表数量决定状态，以响应关系、scope、独立性和质量决定。
- 一篇直接响应通常最多支持 `attempted` 或 `partially_answered`，除非还有独立复核链。
- `answered` 需要至少两个独立 primary source groups，并处理主要反证。
- 条件差异解释冲突时，使用 `conditionally_answered` 或 `reframed`，并把剩余范围写成 successor Gap。
- 访问失败不是 `unresolved`；应为 `indeterminate`。
- 每次变化追加历史，不覆盖旧状态和 as-of date。

## G-### 模板

```markdown
## G-### — <normalized gap>

- Origin: review seed | adjacent tension | successor gap
- Origin E/C IDs:
- Scope:
- Gap type: knowledge | mechanism | method | data | validation | translation
- Status:
- As-of date:
- Review cutoff / adjacency range:
- Supporting E/C IDs:
- Contradicting E/C IDs:
- Independent source groups:
- Paper × Gap responses:
- Query families and audit paths:
- Citation/related/arXiv coverage:
- Full-text coverage:
- Confidence and why:
- Remaining scope:
- Discriminating test:
- Successor G IDs:
- Status history:
  - date, old → new, evidence/reason
- Stop reason:
```

## Gap Seed 与当前 Gap 的区别

综述原文、作者 future work 或一个异常结果只创建 seed。只有完成 post-review/adjacent 检索、全文核查、来源去重和反向 novelty 检索后，才可判断当前状态。

## 失败模式

- **把综述发布日期当知识截止日期**：使用自报 cutoff 或重叠边界。
- **没搜到就写 unresolved**：先证明查询、图扩展、同义词和全文覆盖足够；不足则 `indeterminate`。
- **部分回答被写成 answered**：明确 remaining scope。
- **条件依赖被写成冲突或被直接关闭**：保留 moderator 和 successor Gap。
- **同一研究多版本被当作复核**：按 source group 去重。
- **Gap 太宽无法证伪**：拆成材料、条件、机制和 endpoint 明确的子 Gap。
