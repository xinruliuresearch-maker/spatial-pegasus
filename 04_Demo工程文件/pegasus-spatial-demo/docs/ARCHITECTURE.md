# 系统架构

Pegasus Spatial 是一个单体 Next.js 应用。对话、Agent 执行、空间任务、Workspace、Scene Revision 与媒体索引统一持久化到 MongoDB；耗时的供应商任务由独立后台 worker 接管，不依赖某个浏览器请求一直保持连接。

```text
Browser
  ├── Chat Workspace
  ├── File / Image / GLB preview
  └── Spatial Stage
          │
Next.js APIs
  ├── Conversation + Agent Loop
  ├── Workspace + Media
  ├── Spatial Scene + Observation
  └── Render command bridge
          │
MongoDB
  ├── conversations / Agent runtime
  ├── workspace revisions
  ├── spatial jobs / receipts
  ├── scenes / scene revisions
  └── media metadata / GridFS
          │
Spatial Worker
  ├── NewAPI image generation
  ├── Lux3D object generation
  ├── Aholo World generation
  └── artifact validation + publication
```

## Agent 执行层

- `lib/agent/`：Root Agent 主循环、模型调用、工具结果准入、消息队列和上下文管理。
- `lib/agent-runtime/`：持久 Run、lease、崩溃恢复、后台执行和失败隔离。
- `lib/agent-team/`：Agent 身份、显式工具授权、成员协作、任务与消息投递。
- `lib/skills/`：按需加载的空间创作和图像生成方法说明。

Root 默认拥有完整空间能力。成员 Agent 只有在 `allowed_tools` 中被明确授权后才能调用生成或 Scene 修改工具；wildcard 不会隐式获得昂贵能力。

## 空间任务层

`SpatialBuildJob` 统一承载图像、物体与 World 任务：

```text
prepared → submitting → submitted → running → materializing → published
                         ├→ failed
                         ├→ unknown
                         └→ cancelled
```

主要设计：

- 幂等键为 `project_id + run_id + tool_use_id`。
- 外部任务 ID 一旦获得，必须先持久化再返回。
- 已知外部任务可在重启后继续轮询、下载和发布。
- 供应商是否已接受无法确认时进入 `unknown`，系统不会自动再次提交。
- 供应商短期地址会立即镜像到本方媒体存储，并验证 MIME、文件 magic、大小和 SHA-256。
- `published` 任务可以重建相同 ToolResult，不重复调用供应商。

## Scene 与 Revision

`SpatialScene` 只保存当前 revision 指针；每次成功修改都会创建不可变的 `SpatialSceneRevision`。Revision 冻结 World、物体 artifact、来源 Job、SHA、Workspace path 和变换。

```text
SpatialScene
  └── SpatialSceneRevision vN
        ├── World source
        ├── SceneObjectInstance[]
        │     ├── GLB editable truth
        │     └── optional PLY visual substitute
        ├── Agent viewpoint
        └── change summary
```

并发修改使用 current revision CAS。恢复旧版本不会覆盖历史，而是以旧版本内容创建一个新的 current revision。

## 混合空间舞台

空间舞台同时加载：

- Aholo World SPZ/PLY：整体环境与远景氛围；
- Lux3D GLB：可选择、移动、旋转、缩放的结构真值；
- 可选 Lux3D PLY：高质量视觉替身，不参与选择和场景结构判断。

用户相机与 Agent 相机互相独立。Agent 截图通过持久 render command 交给活动舞台执行；舞台切换到 Agent 视角、读取真实像素、上传观察图后恢复用户视角。没有活动舞台时，截图工具返回 `viewer_unavailable`。

## Workspace 与媒体

用户可见产物使用稳定逻辑路径：

```text
output/spatial/images/
output/spatial/objects/<build-id>/
output/spatial/worlds/<build-id>/
output/spatial/reviews/<observation-id>/
```

Workspace 以路径级 head 和不可变 revision 作为权威，写入通过 CAS 避免静默覆盖。媒体默认存储在 GridFS，也可以配置 OSS/CDN；浏览器只接收受控的公开 URL。

## 恢复边界

系统允许恢复：

- 已持久化 external ID 的供应商任务；
- 已下载但尚未发布的临时资产；
- 已发布但 ToolResult 尚未返回的任务；
- 中断的 Agent Run 和后台成员任务；
- Scene、Revision、Agent viewpoint 与 Observation。

系统不会自动恢复为新的付费提交：

- 无法证明供应商未接受的 `unknown` 任务；
- 用户已经获得成功候选后的额外候选；
- 输入、供应商或模型快照已经改变的任务。

## 部署边界

- Web 默认监听 `127.0.0.1:3200`。
- Mongo 默认监听 `127.0.0.1:27019`，数据库名为 `pegasus_spatial`。
- Docker 网络、volume、GridFS bucket 与 OSS prefix 都使用 `pegasus-spatial` 命名空间。
- 公网部署必须由外部网关提供 HTTPS、身份认证和请求限制。

## 当前非目标

- CAD 精度与真实米制；
- 碰撞、重力和物理仿真；
- OpenUSD / RenderCloud Scene Compiler；
- 对 Aholo 3DGS 世界进行局部语义编辑；
- 服务端无头 3D Viewer。
