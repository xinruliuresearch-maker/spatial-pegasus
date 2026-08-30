# 科学措辞与报告失败模式

## 推荐措辞

- `unresolved`：截至 `<date>`，在 `<recorded search scope>` 内尚未找到满足 `<criteria>` 的解决方案。
- `indeterminate`：由于 `<missing full text / comparability / provenance / coverage>`，当前证据不足以判断状态。
- `conditionally_answered`：证据支持在 `<boundary>` 内回答；`<remaining scope>` 仍开放。
- `contested`：在 `<comparable scope>` 下，独立来源组 `<groups>` 给出未协调结果。
- `agent-inferred`：这是基于 `<E/C IDs>` 的综合推断，尚未被直接实验检验。
- `provisional`：目前仅有一个独立来源组或 R3 类比支持。

## 避免措辞

- “这是影响因子最高/最权威的综述”——除非有明确指标、年份和权威来源。
- “arXiv 已验证该结论”——平台不是验证等级。
- “检索分数证明……”——分数只用于召回排序。
- “没有任何研究……”——改写成带 as-of date 与检索范围的负检索陈述。
- “研究已经彻底解决……”——除非 Gap 原 scope 满足 `answered` 门槛。
- “作者证明机制是……”——若仅来自 Discussion，应写 `author-proposed`。

## 常见失败模式

- **报告先于账本**：先补 E/C/G/H 和审计路径，再写叙述。
- **只列论文不回答问题**：围绕状态变化、冲突和判别性下一步组织。
- **只列正证据**：加入反驳、限定、负结果与 failed branches。
- **Gap 没有 scope**：写明材料、条件、endpoint、cutoff 和 remaining scope。
- **引用 ID 无法解析**：在交付前逐个检查 Workspace 定义和路径。
- **多 Agent 结果直接拼接**：先统一来源组、条件、ID 和状态，再综合。
- **把停止包装成饱和**：区分边际信息下降、预算停止、工具失败和全文不可得。
- **长期方向只有宏大叙事**：加入首个判别性研究、失败价值和终止证据。
