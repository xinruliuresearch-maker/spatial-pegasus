# 冲突与条件依赖分析

## 先判断是否可比

对候选冲突逐项比较：

1. `material/sample`：来源、组成、纯度、缺陷、批次；
2. `process/history`：合成、退火、压力、冷却、前处理；
3. `structure/state`：相、界面、形貌、应变、取向；
4. `environment/boundary`：温度、气氛、浓度、载荷、边界条件；
5. `measurement/calibration`：仪器、标定、分辨率、检测限；
6. `data/statistics`：预处理、样本量、排除、误差、拟合；
7. `theory/causal assumption`：模型、先验、机制解释、因果方向；
8. `metric/baseline`：endpoint 定义、单位、归一方法、对照；
9. `replication/source dependence`：团队、样品、数据和版本独立性；
10. `scale/integration`：实验尺度、器件集成、放大条件；
11. `aging/degradation`：时间窗、循环、老化与失效历史。

## 根因认识状态

对每个候选根因标记：

- `observed`：差异由论文方法或数据直接显示。
- `author-proposed`：作者在 Discussion 中提出，但未直接验证。
- `agent-inferred`：综合比较后的推断，必须给出 E/C IDs 和替代解释。
- `experimentally-tested`：研究直接操纵该因素并检验冲突是否消失。

不得把 `author-proposed` 或 `agent-inferred` 写成已验证机制。

## 冲突条目模板

```markdown
## X-### — <conflict>

- Related C/G IDs:
- Source groups:
- Comparable scope:
- Direction/magnitude/mechanism disagreement:
- Root-cause candidates:
  - dimension:
    epistemic status:
    E/C IDs:
- Boundary-condition explanation:
- Alternative explanations:
- Discriminating test:
- Current judgment: substantive conflict | condition-dependent | not comparable | indeterminate
```

## 失败模式

- **单位或 endpoint 不同却直接比较数值**：先转换或声明不可比。
- **条件不同导致的表面冲突**：把 moderator 写成 boundary-condition Gap。
- **用多数票压过少数反例**：比较质量、独立性和适用 scope。
- **作者 Discussion 被当作结果**：保留 `author-proposed` 标签。
- **模型与实验的结论混成同类证据**：分别记录假设、可观测量和验证程度。
- **缺全文时强行归因**：标记 `indeterminate` 并记录所缺 Methods/Results。
