---
name: spatial-creation
description: >
  将自然语言或 Workspace 参考图转化为可反复观察和修改的模块化 Scene、全景环境与 Lux GLB 资产。用于单图造物、Lux 地形和建筑组装、声明式场景编辑、自动 revision、真实网格地表查询、真实视角截图和观察驱动修改；Aholo World 3DGS 仅作为可选的定点体积背景，不用于可行走地面、局部编辑网格、真实尺度或物理仿真。
---

# 空间创作协调

用户只需描述想要的产物。根据目标和真实工具能力自主组合调用，不将工具排列成用户必须经过的固定步骤。

## 1. 确定目标

- 先判断请求处于“概念探索”还是“已确认制作”。只有点子、体验目标或含糊场景描述时属于概念探索；用户明确确认了一张概念图、提供已确认参考图，或明确要求跳过概念阶段直接制作时，才进入已确认制作。
- 需要摆放和反复编辑的空间，优先拆成 Lux 环境模块与独立物件，使用 `CreateObject3D` 交付 GLB，再组合为 Scene。环境模块可以是一块地台、道路、庭院、建筑外壳或完整景观单元，不限于小型道具。
- 独立物体/道具/家具/产品：使用 `CreateObject3D`；需要单独移动、复用或删除的内容应作为独立 GLB。
- 远景、天空、包围式视觉环境和整体光色氛围：优先生成 2:1 等距柱状全景，并用 `SetSceneEnvironment` 直接作为 Scene 环境贴图。它没有可行走几何，也不会因相机平移而碎裂。
- 现实场地捕捉：只在重建工具实际可用且输入素材满足要求时执行。
- Lux GLB 是地形、建筑、道路、地表模块和物件的可摆放、选择和变换真值。大型地形或基座用 `AddSceneTerrain` 加入；普通物件用 `AddSceneObject`。Aholo World 3DGS 只在确实需要固定观察点附近的体积氛围时作为可选背景叠加，不是 Scene 的默认环境层。
- 物体与世界仍有关键歧义时，用 `AskUserQuestion` 澄清。

## 2. 先确定概念，再进入 3D 制作

当用户提出的是早期点子时，先把共同设计当作当前任务，不要立即创建 Asset Maker、拆分 3D 生产任务或调用 `CreateObject3D`/`CreateWorld3D`：

1. 从用户点子发散出完整但可讨论的空间体验，包括用途、核心体验、空间结构、视觉语言、环境氛围和最重要的可交互元素。不要只复述输入，也不要一次抛出大量无关候选。
2. 用 `AskUserQuestion` 每次询问少量真正会改变设计方向的问题，同时给出有判断的推荐默认值。根据回答继续收敛；已经能从上下文可靠推断的内容不重复询问。
3. 方向足够清楚后，加载 `imagegen` Skill，并用 `GenerateImage` 生成一张完整空间概念美术图。它用于确认整体构图、氛围、材质和主要空间关系，不是几何正确性的证明。
4. 把真实概念图展示给用户，明确询问“确认进入 3D 制作，还是继续修改概念”。用户的沉默、Agent 自己写出的方案或工具成功都不算确认。
5. 用户要求修改时，继续围绕同一概念图修订并再次确认；用户明确确认后，冻结这张图和文字约束作为共同视觉基准。概念图是给用户确认“最终世界看起来和体验起来如何”的场景美术，只能作为后续图片的视觉约束，不要原样当作 Scene 环境或某个 Lux 单资产的几何参考图。
6. 根据已确认概念建立实施清单，明确：哪些只属于天空、远景和整体氛围；哪些建筑、道路、地表模块、植物、家具和装饰必须成为可编辑 Lux 资产；哪些内容可以合并为一个环境模块，哪些必须独立移动、替换或删除。这个清单是动态制作判断，不要求用户选择固定模式；清单明确后再开始资产拆分和并行委派。

用户明确要求跳过概念阶段、直接生成某个 3D 资产，或提供一张明确标注为已确认的参考图时，可以直接进入制作，不机械增加确认步骤。对已有 Scene 的局部移动、删除、替换和观察反馈也不重新走概念确认。

## 3. 选择最小足够的工具组合

- 进入已确认制作后，文字已足以表达几何和风格时，可直接调用 3D 生成工具；概念探索阶段不得把“文字足够详细”当作跳过用户确认的理由。
- 始终区分三类图片：`concept_art` 是包含完整近中远景内容、专供用户确认的场景美术；`scene_environment_panorama` 是确认后新生成的 2:1 等距柱状远景环境；`lux_asset_reference` 是只表现一个可编辑资产的主视图和补充视角。三类图片可以保持同一风格与光色，但不得由同一个文件兼任。
- 对“先确认概念、再实现 Scene”的请求，用户确认后默认另行生成一张 `scene_environment_panorama`，用 `SetSceneEnvironment` 直接设为全景环境。`concept_art` 和普通单向透视环境图通常不适合作为 360° 环境。只有用户明确要试验 Aholo World 的体积背景，或某个固定观察点确实受益时，才把专用全景交给 `CreateWorld3D`。
- `scene_environment_panorama` 的提示词应明确要求 `2:1` 等距柱状全景、水平 360° 与垂直 180°、稳定中线地平线和左右连续。近景和中景保持低信息、连续且不出现需要交互的主体；它不承担可行走地面。建筑、地形、庭院结构、道路模块、墙、树、家具、装饰和其他需要选择或修改的内容转为 Lux 资产参考图。生成后由 Agent 查看真实图片，依据接缝、地平线、天顶/地底和近中景主体判断是否需要定向修订或重生成；明显问题不应被忽略，但这些观察不是代码级硬校验、不是全局停止条件，也不阻塞其他独立的 Lux 制作工作。结果可用但不完美时，可以结合用户目标继续推进，并明确记录不确定性和视觉取舍。
- 实际调用 `GenerateImage` 前加载 `imagegen` Skill。图片提示词、编辑不变量、画幅选择和真实输出检查由它负责；本 Skill 只决定图片在 World、Lux 与 Scene 创作中的作用。
- `SetSceneEnvironment` 接收当前 Workspace 中已授权的全景图片路径；这不是付费生成工具，也不创建几何。`CreateWorld3D` 仍可接收文字或单张参考图，但属于可选的固定观察点体积背景试验，不是每个 Scene 的必经步骤。
- `CreateObject3D` 默认使用一张已授权的 canonical 主视图：单一主体、完整无遮挡、背景干净、透视清楚。这是速度、稳定性和质量之间的首选，不要在生成前例行补齐多视角。只有查看真实 GLB 后确认背面、厚度或不对称结构已经产生不可接受的错误，或者用户明确要求时，才用同一主图派生一致的补充视角并重建。
- 主要由 Lux 搭建的 Scene，其全景环境只表达天空、远山、遥远天际线和整体光色，不承担可行走地面。画面近中景保持低信息、连续且不出现需要交互的主体；真正的地表、山体近景、道路、建筑与植被模块由 Lux 生成并摆放。
- 每个 Lux 建筑或模块先生成一张完整、无遮挡、背景干净的主图，并直接提交 Lux。补充视角是针对真实单图结果中已观察到的几何缺陷所做的升级方案，不是默认准备工作；需要时使用原主图派生，并保持同一设计、比例、材质、开口和部件数量。
- 所有图像输入都必须是当前 Workspace 中可读的文件路径；不传入任意远程 URL。
- 不使用图像工具选择器，不在一次运行中自动切换供应商。
- 首次创建 World 或判断其输入、状态与产物时，读取 `/skills/spatial-creation/references/world-generation.md`。
- 规划建筑、道路、场地模块或决定单视角/多视角时，读取 `/skills/spatial-creation/references/lux-scene-building.md`。

## 4. Scene 创作闭环

- 没有现成 Scene 时用 `CreateSpatialScene` 建立空的版本化 Scene。
- 已确认制作的复杂场景优先直接用真实 Lux GLB 模块搭建，不依赖 Viewer SDK 中不存在的代理几何能力。先拆出地台、主建筑体量、入口/门环、道路或广场、桥梁与主要高差，并在 Scene JSON 中用稳定 `key`、绝对变换和目标尺寸维护布局；若资产尚未完成，可以先保留节点规划，而不是伪造可渲染灰盒。
- 从三个机位复核真实模块的空间关系：顶视检查边界、动线和占地；入口人眼视角检查尺度、压迫感与视觉焦点；远景检查轮廓、层级和天际线。关系不成立时优先修改 Scene JSON 参数，不要生成新资产掩盖错误布局。
- 复杂建筑拆为可控模块，例如基座、塔身、门环、连桥和装饰冠部。每个 Lux 资产发布后先在独立模型预览中审查主体完整性、朝上方向、支撑面、尺度暗示和明显失真；不合格资产保持在资产库中，不写入 Scene。
- 合格 GLB 按稳定 `key` 逐件替换或放入。每加入一个关键模块就从相关机位截图复核；不要一次写入多个未经观察的资产。最后才统一调整环境、光照、材质曝光、阴影和地面融合。
- 复杂场景默认像维护代码一样维护 `output/spatial/scenes/<scene-id>/scene.json`：先用 `InspectSpatialScene` 获取当前版本，使用 `Write`/`Edit` 修改完整目标节点列表，再调用一次 `ApplySceneSpec` 原子应用。每个节点使用稳定、可读的 `key`；通过 `fit.width`、`fit.depth` 或 `fit.height` 表达目标体量，由系统基于校正后的真实 GLB bounds 计算统一缩放，不反复猜 raw scale。
- Scene spec 必须填写 `expected_scene_version`。应用成功自动产生一个 revision；并发变化返回 `scene_changed`，此时重新检查 Scene、更新 spec 版本后再应用。恢复旧状态仍创建新 revision，不让 Agent 管理 revision ID。
- `ApplySceneSpec` 的 `nodes` 是完整期望状态，因此新增、移动、替换、隐藏和删除可以在一次可审阅的 JSON 修改中完成。大型地形用 `role: "terrain"`，普通内容用 `role: "object"`；环境全景写入 `environment`。现有 `AddSceneObject`、`AddSceneTerrain`、`TransformSceneObject`、`RemoveSceneObject` 只用于简单的一次性修补和兼容，不作为复杂搭建的默认方式。
- 把物体放在起伏地形上时，先用 `QuerySceneSurface` 对目标 Lux 地形的真实 GLB 网格求交，再把返回的绝对点用于新增或变换。没有活动舞台或没有命中时，说明事实并换一个点或请用户打开舞台；不得从概念图、包围盒或肉眼轮廓猜测高度。
- 用 `SetSceneViewpoint`/`FocusSceneObject` 设置独立 Agent 相机，再用 `CaptureSceneView` 获取真实渲染像素。用户相机不能被 Agent 抢走。
- 用户提供 `observation_id` 时将修改绑定到该截图 revision；Scene 已变化就重新观察，绝不静默套用旧意见。
- PLY 是全局高质量显示模式中的视觉替身，不参与选择、地表查询、碰撞或 Scene 结构判断；GLB 始终是 Scene 真值。
- 坐标基校准属于资产/渲染契约，不属于 Scene 设计变换。GLB 与 PLY 看起来不一致时，不得用 `TransformSceneObject` 补偿格式错误；先按同一相机检查本地姿态。做物体摆放、视觉复核或格式对照前，读取 `/skills/spatial-creation/references/spatial-orientation-review.md`。

## 5. 付费与委派边界

产品不对项目设置固定的图片或 3D 任务数量上限。每个明确的目标都可以建立持久任务；后台 Worker 的可配置并发只控制本机同一时刻的提交、轮询和物化吞吐，不限制持久队列，也不是 Agent 的创作额度。持久 receipt 与 `unknown` 防重提规则始终有效。是否需要追加视觉候选由 Agent 根据创作目标决定，不因为“候选数量”本身强制询问用户。

概念图经用户确认、正式进入 3D 制作后，若目标包含多个相互独立的资产，Root 应尽早创建多个 Asset Maker 并行工作，而不是等第一个资产完成后再创建第二个；数量按资产拆分和团队可用 Agent 决定，不受固定的两个生成槽约束。每个 Asset Maker 负责一组资产：生成参考图、检查真实图片、调用 `CreateObject3D`，拿到 `job_id` 后立即继续下一项可执行工作。空间任务的终态会自动通知 Root；不要让成员停在轮询等待上。

Scene revision 只允许一个写入责任方。Root 可以自己组装，也可以指定唯一 Scene Assembler；多个资产几乎同时完成时，仍由它按顺序 `InspectSpatialScene` 后再写入，避免并发 revision 冲突。并行发生在图像设计和资产生成，不发生在同一 Scene 的修改提交上。

以下情况需要 `AskUserQuestion`：

- 要增加用户没有要求的另一种目标产物；
- 供应商可能已接受任务，但系统没有可确定接管的外部任务 ID；

Root 默认拥有空间工具。Member wildcard 不会获得生成、Scene 修改或截图工具；Root 可在 `allowed_tools` 中逐项显式授权，授权后执行能力与 Root 相同。Asset Maker 至少显式授权 `Skill`、`Read`、`Glob`、`GenerateImage`、`CreateObject3D`、`GetSpatialJob`、`InspectSpatialArtifact`；Scene Assembler 只获得实际需要的 Scene 查询、修改、相机和截图工具。

## 6. 跟踪而不重放

- `CreateObject3D`/`CreateWorld3D` 的 `prepared` 结果只表示任务已进入本地持久队列，不表示供应商已经接受；记住 `job_id`，然后继续其他独立工作。
- 正常创作中不得在创建后调用 `WaitSpatialJob`，也不要循环调用 `GetSpatialJob`。终态会作为独立的持久后台事件自动通知 Root；它不是原 tool call 的第二个 `tool_result`。
- `GetSpatialJob` 只查询 Lux3D/Aholo 的 Object/World Job，用于用户主动查询状态、故障诊断或服务恢复核对；不得把 `GenerateImage` 返回的 `spimg_*` receipt ID 传给它。图片状态以 `GenerateImage` 自己的 ToolResult 为准。`WaitSpatialJob` 只用于用户明确要求短暂等待且当前确实没有其他工作时的诊断场景。
- 收到 `published` 通知后，先用 `InspectSpatialArtifact`/manifest 确认真实资产，再交给唯一 Scene Assembler 放置和复核。收到 `failed` 时说明失败并选择替代方案；收到 `unknown` 时禁止自动重提。
- `AskUserQuestion` 会形成必须等待回答的交互屏障。Root 处于 `waiting_user` 时，后续 3D 终态事件会持久排队，不会越过问题强行启动新一轮；用户回答后它们会在下一个安全边界被消费。这不是通知丢失。批量资产正在生产时，不要为可安全默认的细节发起问题；但 `unknown` 后重提这类可能重复付费的动作仍必须由用户确认。
- 对话结束、页面刷新、等待超时或服务重启都不是付费重试理由。
- `unknown` 表示外部副作可能已发生。立即停止重放，把事实和风险说清楚，由用户决定是否建立新任务。
- 只有系统可以证明供应商尚未接受请求的失败，才能自动重试一次。

## 7. 交付与血缘

使用固定公开路径：

- `output/spatial/images/`
- `output/spatial/objects/<build-id>/`
- `output/spatial/worlds/<build-id>/`
- `output/spatial/reviews/`

保留 `derived_from`、`revision_of`、`conditioned_by` 和 `compared_with` 关系。交付前使用 `InspectSpatialArtifact` 或实际读取 manifest，确认资产已发布且可打开；不把 `submitted` 或 `running` 说成已完成。

## 8. Critic 边界

审阅只使用真正可观察的图像、截图、模型与 manifest，并将每项判断标为：

- `verified`：可从当前产物直接确认；
- `inferred`：有可观察线索，但未经几何/量测验证；
- `unknown`：当前产物无法证明。

不宣称 CAD 精度、真实尺度、碰撞、路径规划或物理正确性；不宣称能局部语义修改 3DGS World。Critic 可以建议或执行已授权的 Scene 物体调整，但要明确 `verified / inferred / unknown`。

单张遮挡视图和包围盒不能证明姿态正确。承重物体至少检查重力方向、支撑点是否向下、主要承载面是否合理；存在歧义时获取正面、侧面或俯视补充截图。无法确认就标记 `unknown`，不得仅凭单张轮廓猜定扶手、椅脚、座面等语义部件后宣布 `verified`。

面向用户的状态、评审和最终交付默认使用简体中文。
