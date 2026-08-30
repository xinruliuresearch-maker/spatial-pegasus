# 多 Agent 执行契约

本文描述 Pegasus Spatial 的持久多 Agent 协作边界。团队能力服务于空间规划、参考图制作、资产审查与场景复核，但不会把某种固定团队结构强加给每个项目。

## 持久对象

- `AgentTeam`：一个 Conversation 对应一个团队，保存 Root、成员、策略版本和监督游标。
- `Agent` / `DelegationGrant`：稳定身份、角色、状态、能力和工具 allowlist。
- `AgentSessionRuntime`：每个 Agent 独立的消息历史、上下文管理和当前 Run lease。
- `AgentTask` / `AgentRun`：可恢复任务、依赖、验收条件和一次具体执行。
- `AgentMailboxMessage`：成员之间的消息、文件和证据引用。
- `AgentResult` / `WorkspaceProposal`：成员结果与公共 Workspace 发布提案。
- `TeamEvent`：带单调序号的 append-only 状态事件，用于界面回放和断线恢复。

## 生命周期

Agent 状态：

```text
running / idle / paused / completed / failed
```

成员每轮自然结束后回到 `idle`，表示当前 Run 已释放，不代表身份关闭。只有 Root 显式关闭成员时才进入 `completed`。

Task 状态：

```text
queued → running → submitted → accepted
            ├→ waiting
            ├→ rework
            ├→ failed
            └→ cancelled
```

同一 Agent 一次只执行一个 Run，其他任务按依赖和创建顺序排队。Session lease、Run lease 与 Team fence 共同防止失租执行器继续调用模型、工具或写入 Workspace。

## 模型可见协作工具

- `Agent`：Root 创建成员并发送第一条完整任务。
- `SendMessage`：向已有成员发送追问、纠偏、文件引用或下一轮工作。
- `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet`：需要持久依赖、验收或所有者时使用的共享任务账本。
- `ReviewWorkspaceChanges`：Root 审批成员产生的公共文件变更。
- `ManageAgent`：Root 中断、关闭或重新开启成员。

简单协作不要求创建 Task。成员的最终回复会自动保存为不可变结果并投递给调用者，模型不需要轮询邮箱或重复“提交结果”。

## 空间工具授权

- Root 默认拥有空间生成、Scene 修改与截图工具。
- Member wildcard 不会自动获得 `GenerateImage`、`CreateObject3D`、`CreateWorld3D` 或 Scene 修改工具。
- Root 可以在成员的 `allowed_tools` 中明确加入所需能力。
- 执行层以持久 grant 为准，不使用“成员永远禁止”的二次硬编码。
- 输入图片仍按成员 Workspace 读取范围校验；公共资产发布由专用 publication scope 完成。

## Workspace 隔离

- 公共区只允许 Root 或经过批准的系统发布路径写入。
- 成员草稿保存在内部私有命名空间，其他成员只能读取消息或任务精确引用的文件。
- 成员本轮文件变更自动形成 proposal，由 Root 使用目标 revision CAS 逐项发布。
- Workspace head 与不可变 revision 是唯一权威；聚合投影只用于读取和兼容。
- 公共发布失败时不得形成半套可见资产。

## 状态投递

成员完成、阻塞或失败会立即唤醒调用者。Root 正在运行时，更新在安全消息边界作为内部 reminder 注入；Root 不在运行时，持久 runner 会创建可恢复的新 Run。

团队界面通过：

- `GET /api/conversations/:id/team` 读取精简快照；
- `GET /api/conversations/:id/team/stream?after_seq=` 按 TeamEvent 序号断线回放。

界面只展示身份、角色、状态、最后切换时间和计数，不公开成员私有消息全文。

## 运行配置

```env
AGENT_RUNTIME_BACKGROUND_RUNNER=1
AGENT_RUNTIME_WORKERS=8
AGENT_RUNTIME_INTERNAL_BASE_URL=http://127.0.0.1:3200
AGENT_RUNTIME_INTERNAL_SECRET=<random-secret-at-least-32-characters>
```

## 验证

```bash
npm run multi-agent:verify
npm run multi-agent:verify:mongo
npx tsc --noEmit
npm run lint
npm run build
```

Mongo 单机模式不依赖副本集事务。唯一键、command receipt、append-only event、lease fence 和 maintenance repair 共同提供幂等与恢复。
