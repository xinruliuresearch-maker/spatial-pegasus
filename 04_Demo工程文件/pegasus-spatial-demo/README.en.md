# Pegasus Spatial

**Pegasus Spatial** is a natural-language workspace for concept generation, 3D asset creation, scene assembly, visual inspection, and iterative spatial editing.

The Agent is not tied to a fixed execution order. It can combine image generation, Lux3D objects, Aholo World environments, Scene Revisions, and rendered observations according to the user's goal and the assets already available.

## Highlights

- Generate concept art and asset references from text or Workspace images.
- Create selectable and transformable GLB assets with Lux3D.
- Combine Aholo World environments with independently editable GLB objects.
- Browse scenes, select objects, edit transforms, and preserve revision history.
- Capture real rendered viewpoints and continue editing from visual feedback.
- Run long 3D jobs asynchronously and resume the Agent when results arrive.
- Prevent duplicate paid submissions with durable receipts and explicit `unknown` states.

## Quick local setup

Requirements: Node.js 20+, npm 10+, Docker, and Docker Compose v2.

```bash
git clone https://github.com/xinruliuresearch-maker/spatial-pegasus.git
cd spatial-pegasus/04_Demo工程文件/pegasus-spatial-demo
npm install
cp .env.example .env.local
```

Configure at least the model gateway and spatial providers in `.env.local`:

```env
LLM_BASE_URL=https://your-newapi.example.com/v1
LLM_API_KEY_ORCHESTRATOR=...
LLM_API_KEY_TOOLS=...
AHOLO_API_KEY=...
LUX3D_API_KEY=...
```

Then start the local stack:

```bash
npm run local:up
```

Open `http://localhost:3200`.

```bash
npm run local:status   # configuration, Mongo, and Web health without secrets
npm run local:down     # stop services while preserving the local data volume
```

For direct development logs:

```bash
docker compose up -d mongo
npm run dev
```

For a containerized deployment:

```bash
cp .env.example .env.production
# Fill in production credentials and HTTPS endpoints.
docker compose up --build -d
```

The application uses a local single-user mode and listens on loopback by default. Put an authenticated HTTPS gateway in front of it before exposing it to a LAN or the public Internet. See [Deployment](docs/DEPLOYMENT.md) for the complete configuration.

## Main Agent tools

- `GenerateImage`
- `CreateObject3D`
- `CreateWorld3D`
- `GetSpatialJob` / `WaitSpatialJob`
- `InspectSpatialArtifact`
- `CreateSpatialScene` / `InspectSpatialScene`
- `SetSceneWorld`
- `AddSceneObject` / `TransformSceneObject` / `RemoveSceneObject`
- `SetSceneViewpoint` / `FocusSceneObject` / `CaptureSceneView`

External 3D generation is asynchronous. Once a provider accepts a request, the tool returns immediately while a durable worker polls, validates, mirrors, publishes, and reports the finished artifact.

## Workspace outputs

```text
output/spatial/images/
output/spatial/objects/<build-id>/
output/spatial/worlds/<build-id>/
output/spatial/reviews/<observation-id>/
```

Every successful scene mutation creates a new immutable revision. Concurrent updates use CAS, and restored history is written as a new revision rather than overwriting the past.

## Verification

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

These checks do not submit paid provider jobs. Run live provider smoke tests separately after reviewing configuration and cost.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Multi-Agent runtime contract](docs/AGENT_TEAM_V1.md)
- [Spatial Scene system](docs/SCENE_SYSTEM.md)

## Scope

The current release does not claim CAD precision, real-world metric scale, collision correctness, physics simulation, or OpenUSD scene compilation. Aholo World is used primarily for environmental presentation; editable spatial structure is represented by GLB instances and Scene Revisions.

## License

No open-source license is currently declared for this repository. Redistribution under MIT, Apache-2.0, or another open-source license requires explicit permission from the project owner.
