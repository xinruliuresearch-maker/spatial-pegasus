# 相邻文献同心扩展

## 相邻圈层

- `R0`：材料、问题和关键条件直接对应。
- `R1`：同材料但方法/场景不同，或问题相同且材料非常接近。
- `R2`：结构、机制、方法或应用上存在明确可迁移性的类比。
- `R3`：跨材料类别的机制或方法类比；只能生成 Hypothesis，不能直接证明目标材料结论。

默认检索至 R1/R2。进入 R3 前写出 transfer bridge；不能写出则停止扩展。

## 八个相邻性轴

逐轴记录，不压缩成单一相关分：

1. `material/composition`
2. `structure/interface/morphology`
3. `mechanism/phenomenon`
4. `synthesis/process`
5. `characterization/measurement`
6. `computation/model/data treatment`
7. `application/function/metric`
8. `operating regime/scale/failure mode`

## 相邻文献条目模板

```markdown
## A-### — <paper>

- Ring: R0 | R1 | R2 | R3
- Identity/version group:
- Full-text path:
- Axes matched:
  - material/composition:
  - structure/interface/morphology:
  - mechanism/phenomenon:
  - synthesis/process:
  - characterization/measurement:
  - computation/model/data treatment:
  - application/function/metric:
  - operating regime/scale/failure mode:
- Transfer bridge:
- Analogy break:
- Comparable endpoints/conditions:
- Candidate tension:
- Permitted use: observation | boundary clue | hypothesis only
```

## 检索策略

1. 先锁定目标 tuple，再为每个轴建立同义词与实体变体。
2. 从 R0/R1 的高可比结果抽取新的材料名、方法名、异常现象和作者术语。
3. 对每次扩圈记录新增的独立来源、条件边界与张力，而非只记录命中数。
4. 用 cited/citing/related 路径补足关键词检索盲区。
5. 连续两圈可比性下降且没有新 tension 时停止。

## 使用边界

- R3 证据不能升级成目标材料的 Claim。
- 词面相似但 endpoint、物理机制或操作区间不同，不算可迁移。
- “同一种测量方法”不自动意味着结果可比较；检查标定、分辨率和数据处理。
- 对每个 transfer bridge 同时寻找 analogy break，防止选择性类比。
