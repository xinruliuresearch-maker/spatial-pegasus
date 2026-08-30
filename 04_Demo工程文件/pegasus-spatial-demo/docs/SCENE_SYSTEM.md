# 空间 Scene 系统

## 目标

Scene 系统把环境、独立 3D 资产、相机和视觉观察组织成可持续修改的空间事实，而不是把一次生成结果当成不可变播放器。

## 三类空间内容

1. **Environment**：Aholo World 或全景背景，负责天空、远景和整体氛围。
2. **Editable Object**：Lux3D GLB，负责建筑、地形模块、家具与装饰物，是位置和结构的真值。
3. **Visual Substitute**：可选 Lux3D PLY，提供高质量预览，但不参与选择、碰撞和结构判断。

## Revision

Agent 和用户不直接维护 revision ID。每次成功的 Scene 修改自动创建新版本：

```text
Scene v1 → add object → v2 → transform object → v3 → restore v1 → v4
```

恢复历史会产生新版本，不覆盖旧版本。修改工具使用 current revision CAS；如果 Scene 在观察或计算后已经变化，工具返回 `scene_changed`，调用方需要重新检查最新版本。

## Object Transform

Agent 工具输入使用：

```ts
{
  position: [x, y, z],
  rotation_deg: [x, y, z],
  scale: [x, y, z]
}
```

服务端把欧拉角转换为规范化 quaternion，并拒绝 NaN、无限值、零缩放和负缩放。所有变换都是绝对值，不提供语义含糊的“向左一点”增量接口。

GLB 发布时会记录 bounds、mesh/primitive/vertex/triangle 数、texture 依赖、up-axis、字节数和 SHA。Viewer 使用底部中心 pivot 进行放置；GLB 与 PLY 通过各自本地坐标基归一化后共享外层 Scene transform。

## 相机

用户相机与 Agent 相机完全分离：

```ts
Viewpoint {
  position: [number, number, number]
  target: [number, number, number]
  up: [number, number, number]
  fov_deg: number
}
```

- 用户相机保存在浏览器本地，Agent 不能抢占。
- Agent 相机按 Scene 持久化，可聚焦物体并触发截图。
- 用户主动提交观察时，系统才持久化用户相机和选择对象。

## 观察闭环

`CaptureSceneView` 不使用服务端假截图。活动舞台领取持久 render command，临时切换 Agent 相机，读取真实 framebuffer，发布 PNG，然后恢复用户相机。

Observation 保存：

- Scene 与 revision；
- viewpoint；
- screenshot asset；
- selected instance；
- visible instance IDs；
- 用户或 Agent 的评论。

基于旧 revision 的 Observation 不能静默修改新 Scene。

## 交互边界

- 用户可以选择 GLB 资产并编辑位置、旋转和缩放。
- 资产面板与 3D 选中状态保持同步。
- PLY 使用全局质量开关，不作为独立结构对象。
- Aholo World 不承诺局部语义编辑；改变整体环境时重新创建 World。
- 场景坐标是相对空间，不声明真实米制或物理正确性。

## 主要工具

```text
CreateSpatialScene
SetSceneWorld
AddSceneObject
TransformSceneObject
RemoveSceneObject
InspectSpatialScene
RestoreSpatialScene
SetSceneViewpoint
FocusSceneObject
CaptureSceneView
```
