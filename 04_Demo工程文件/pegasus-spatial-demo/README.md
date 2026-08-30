# Pegasus Spatial

**Pegasus Spatial（飞马空间 Agent）**是一个自然语言驱动的空间创作工作台。用户可以从同一个对话入口完成概念图生成、3D 资产创建、场景组装、视角观察和持续修订。

Agent 不依赖固定执行顺序。它会根据目标、现有资产和观察结果，自主组合图像生成、Lux3D 造物、Aholo World、Scene Revision 与空间截图工具，并持续记录任务状态和资产来源。

## 核心能力

- 从文字或参考图生成概念美术和资产参考图。
- 使用 Lux3D 创建可独立选择、移动、旋转和缩放的 GLB 资产。
- 使用 Aholo World 生成环境背景，并与 GLB 资产组成混合空间。
- 在空间舞台中浏览场景、选择物体、调整变换并自动保存 Revision。
- 保存用户视角与 Agent 视角，从真实渲染画面继续提出修改。
- 将耗时的外部 3D 任务持久化到后台，完成后自动通知并恢复 Agent 工作。
- 通过幂等 receipt、外部任务接管和 `unknown` 状态避免重复付费提交。

## 本地快速配置部署

### 环境要求

- Node.js 20+
- npm 10+
- Docker Desktop 或 Docker Engine
- Docker Compose v2

### 1. 安装与配置

```bash
git clone https://github.com/xinruliuresearch-maker/spatial-pegasus.git
cd spatial-pegasus/04_Demo工程文件/pegasus-spatial-demo
npm install
cp .env.example .env.local
```

编辑 `.env.local`，至少配置：

```env
LLM_BASE_URL=https://your-newapi.example.com/v1
LLM_API_KEY_ORCHESTRATOR=...
LLM_API_KEY_TOOLS=...

AHOLO_API_KEY=...
LUX3D_API_KEY=...
```

首次接入供应商后，还应把真实产物域名写入：

```env
AHOLO_ASSET_HOST_ALLOWLIST=...
LUX3D_ASSET_HOST_ALLOWLIST=...
```

默认媒体存储为本地 Mongo GridFS，无需额外对象存储。需要使用 OSS/CDN 时，再配置 `.env.example` 中的 `OSS_*` 与 `NEXT_PUBLIC_MEDIA_CDN_BASE_URL`。

### 2. 一键启动本地环境

```bash
npm run local:up
```

该命令会检查配置，启动本地 Mongo，并在回环地址启动 Web 应用：

```text
http://localhost:3200
```

常用维护命令：

```bash
npm run local:status   # 检查配置、Mongo 与 Web 状态，不打印密钥
npm run local:down     # 停止 Web 和 Mongo，保留本地数据卷
```

应用采用本地单用户模式，不需要注册、登录或手工建表。默认只监听 `127.0.0.1`；如需开放到局域网或公网，应在反向代理或网关层增加 HTTPS 与身份认证。

### 3. 分步开发启动

需要直接查看 Next.js 日志或调试代码时，可以分开启动：

```bash
docker compose up -d mongo
npm run dev
```

### 4. 容器化部署

```bash
cp .env.example .env.production
# 填写生产配置与密钥
docker compose up --build -d
```

生产环境必须使用 HTTPS 的模型网关和媒体地址，并在外层网关提供访问控制。完整说明见 [本地与容器部署](docs/DEPLOYMENT.md)。

## 关键配置

| 配置 | 用途 | 默认值 |
|---|---|---|
| `MONGODB_URI` | 对话、任务、Scene Revision 与 Workspace 持久化 | `mongodb://127.0.0.1:27019/pegasus_spatial` |
| `LLM_BASE_URL` | NewAPI 模型网关 | 无 |
| `LLM_API_KEY_ORCHESTRATOR` | Root Agent 模型调用 | 无 |
| `LLM_API_KEY_TOOLS` | 工具模型与图像生成 | 无 |
| `PEGASUS_SPATIAL_IMAGE_MODEL` | 图像模型精确别名 | `GPT-image-2` |
| `AHOLO_API_KEY` | Aholo World | 无 |
| `LUX3D_API_KEY` | Lux3D 资产生成 | 无 |
| `SPATIAL_WORKER_CONCURRENCY` | 后台空间任务处理并发 | `8` |
| `MEDIA_STORAGE_DRIVER` | `gridfs` 或 `oss` | `gridfs` |

`LLM_BASE_URL` 不得包含内嵌账号、密码、query 或 fragment。非生产环境只有回环地址允许明文 HTTP；公网与生产部署必须使用 HTTPS。

## Agent 工具

空间创作的主要工具包括：

- `GenerateImage`
- `CreateObject3D`
- `CreateWorld3D`
- `GetSpatialJob` / `WaitSpatialJob`
- `InspectSpatialArtifact`
- `CreateSpatialScene` / `InspectSpatialScene`
- `SetSceneWorld`
- `AddSceneObject` / `TransformSceneObject` / `RemoveSceneObject`
- `SetSceneViewpoint` / `FocusSceneObject` / `CaptureSceneView`

外部生成任务采用异步提交：工具在供应商正式接受任务后立即返回，后台 worker 负责轮询、下载、校验、发布和完成通知。Agent 可以在等待 3D 资产时继续生成下一组参考图或处理其他场景工作。

## 资产与版本

```text
output/spatial/images/
output/spatial/objects/<build-id>/
output/spatial/worlds/<build-id>/
output/spatial/reviews/<observation-id>/
```

每次成功的 Scene 修改都会自动创建新 Revision。Agent 只操作当前 Scene，不需要手工管理 revision ID；并发修改通过 CAS 防止静默覆盖。资产关系可记录 `derived_from`、`revision_of`、`conditioned_by` 和 `compared_with`。

## 验证

提交代码或制作发布包前运行：

```bash
npm run project-prompt:verify
npm run spatial:verify
npm run spatial:verify:mongo
npm run spatial:verify:local-e2e
npm run tool-contracts:verify
npm run multi-agent:verify
npx tsc --noEmit
npm run lint
npm run build
npm audit --audit-level=high
```

上述验证不会发起真实付费生成。供应商真实调用应通过单独的 smoke 命令完成：

```bash
npm run spatial:preflight:local
npm run spatial:smoke:image -- --help
npm run spatial:smoke:lux -- --help
npm run spatial:smoke:aholo -- --help
```

## 架构文档

- [系统架构](docs/ARCHITECTURE.md)
- [本地与容器部署](docs/DEPLOYMENT.md)
- [多 Agent 执行契约](docs/AGENT_TEAM_V1.md)
- [空间 Scene 系统](docs/SCENE_SYSTEM.md)

## 能力边界

当前版本不宣称 CAD 精度、真实米制、碰撞正确性、物理仿真或 OpenUSD 场景编译。Aholo World 主要承担整体环境表现；可编辑空间结构以独立 GLB 实例和 Scene Revision 为准。

## 许可

本仓库目前未声明开源许可证。未经项目所有者明确许可，不得以 MIT、Apache-2.0 或其他开源许可证重新分发。
