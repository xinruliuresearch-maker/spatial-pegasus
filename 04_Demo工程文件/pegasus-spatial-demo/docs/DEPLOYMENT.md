# 本地与容器部署

## 1. 本地单用户部署

### 前置环境

- Node.js 20+
- npm 10+
- Docker Engine 或 Docker Desktop
- Docker Compose v2

安装依赖并创建本地配置：

```bash
npm install
cp .env.example .env.local
```

至少填写模型网关、Root 模型 Key、工具模型 Key、Aholo Key 和 Lux3D Key。`CRON_SECRET` 与 `AGENT_RUNTIME_INTERNAL_SECRET` 必须替换为不同的随机字符串，不能继续使用示例值。

运行：

```bash
npm run local:up
```

这个命令会：

1. 检查 Docker 与 Compose；
2. 拒绝远程或名称不匹配的 Mongo URI；
3. 启动并等待 Mongo 健康检查；
4. 在 `127.0.0.1:3200` 启动 Next.js；
5. 保存受管进程 PID 与本地日志路径。

```bash
npm run local:status
npm run local:down
```

`local:down` 只停止服务，不删除容器和数据卷。

## 2. 开发模式

```bash
docker compose up -d mongo
npm run dev
```

开发模式适合直接观察终端日志。不要同时运行 `npm run local:up`，否则 3200 端口的进程所有权检查会拒绝接管。

## 3. 完整容器部署

```bash
cp .env.example .env.production
docker compose up --build -d
docker compose ps
```

Compose 会启动：

- `app`：Next.js standalone image，容器端口 3200；
- `mongo`：MongoDB 7，宿主机仅暴露 `127.0.0.1:27019`；
- 独立 network 与持久 volume。

停止但保留数据：

```bash
docker compose down
```

删除 volume 会永久移除本地对话、Workspace、任务和 Scene 数据，不应作为普通重启步骤。

## 4. 配置分组

### 模型网关

```env
LLM_BASE_URL=https://newapi.example.com/v1
LLM_API_KEY_ORCHESTRATOR=...
LLM_API_KEY_TOOLS=...
PEGASUS_SPATIAL_IMAGE_MODEL=GPT-image-2
```

生产环境必须使用 HTTPS。明文 HTTP 只允许非生产回环地址；临时兼容开关不能让公网 HTTP 通过生产 readiness。

### 空间供应商

```env
AHOLO_API_BASE_URL=https://api.aholo3d.cn
AHOLO_API_KEY=...
AHOLO_ASSET_HOST_ALLOWLIST=...

LUX3D_API_BASE_URL=https://api.aholo3d.cn
LUX3D_API_KEY=...
LUX3D_ASSET_HOST_ALLOWLIST=...
```

allowlist 只能填写真实成功响应中出现的精确 hostname，不使用通配符。

### 后台任务

```env
SPATIAL_WORKER_ENABLED=1
SPATIAL_WORKER_CONCURRENCY=8
SPATIAL_WORKER_POLL_MS=2000
SPATIAL_WORKER_LEASE_MS=90000
```

并发值限制本机提交、轮询和物化吞吐，不代表供应商配额。设置过高可能触发供应商限流。

### 媒体存储

本地默认：

```env
MEDIA_STORAGE_DRIVER=gridfs
MEDIA_PUBLIC_BASE_URL=http://localhost:3200
NEXT_PUBLIC_PEGASUS_SPATIAL_MEDIA_PREFIX=raster-assets/pegasus-spatial
```

OSS 模式还需要配置：

```env
MEDIA_STORAGE_DRIVER=oss
OSS_REGION=...
OSS_BUCKET=...
OSS_ACCESS_KEY_ID=...
OSS_ACCESS_KEY_SECRET=...
OSS_ENDPOINT=...
OSS_CDN_BASE_URL=https://media.example.com
NEXT_PUBLIC_MEDIA_CDN_BASE_URL=https://media.example.com
```

## 5. 首次供应商校验

只读预检：

```bash
npm run spatial:preflight:local
```

真实 smoke 必须显式执行，不会被普通 build 或单元测试自动触发：

```bash
npm run spatial:smoke:image -- --help
npm run spatial:smoke:lux -- --help
npm run spatial:smoke:aholo -- --help
```

确认真实成功后，记录供应商任务 ID、产物 hostname、MIME、magic、字节数与 SHA-256，再更新 allowlist。

## 6. 发布前验证

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

## 7. 公网部署要求

应用内置的是本地单用户身份，不是公网账号系统。对局域网或公网开放前必须增加：

- HTTPS；
- 用户身份认证；
- 访问频率与请求体限制；
- 独立密钥管理；
- Mongo 备份与恢复；
- OSS/CDN 的最小权限与跨域策略；
- 供应商费用监控。
