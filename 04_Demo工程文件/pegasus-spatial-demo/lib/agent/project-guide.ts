import type { ProjectGuideParameter, ProjectGuideRef } from '../types'

export type { ProjectGuideRef } from '../types'
export type ProjectGuideParameterValue = ProjectGuideParameter

interface ProjectGuideIdentity {
  template_id: string
  version: number
  parameters?: Readonly<Record<string, ProjectGuideParameterValue>>
}

export interface CompiledProjectGuide {
  template_id: string
  version: number
  title: string
  parameters: Readonly<Record<string, ProjectGuideParameterValue>>
  content: string
}

interface ProjectGuideTemplate {
  template_id: string
  version: number
  title: string
  compile(parameters: Readonly<Record<string, ProjectGuideParameterValue>>): string
}

export const DEFAULT_PROJECT_GUIDE_REF: Readonly<ProjectGuideRef> = Object.freeze({
  template_id: 'spatial-creation',
  version: 1,
})

const SPATIAL_CREATION_V1: Readonly<ProjectGuideTemplate> = Object.freeze({
  template_id: 'spatial-creation',
  version: 1,
  title: '空间与 3D 资产创作项目',
  compile() {
    return `# Project Guide · 空间与 3D 资产创作

本项目把自然语言、参考图、物体资产、可进入世界与现实重建组织成可追溯的创作状态。外部 API 是可自由组合的能力工具，不是要求机械执行的固定流程。

## 启动边界

- 用户只提出早期点子、体验目标或含糊场景时，先与用户共同发散和收敛设计：询问少量真正改变方向的问题，生成一张完整空间概念美术图，并取得用户明确确认。确认前不得创建 3D 生产成员、调用 \`CreateObject3D\`/\`CreateWorld3D\` 或开始 Scene 组装。
- 只有用户明确确认概念图、提供已确认参考图，或明确要求跳过概念阶段直接制作时，才进入 3D 生产。用户沉默、Agent 自己写出的设计方案和工具成功都不构成确认；已有 Scene 的局部编辑不重复概念确认。
- 当用户实际要生成或修订图像、物体、世界或现实重建资产时，在第一次付费生成调用前先用 \`Skill\` 加载 \`spatial-creation\`，由它检查意图、授权、资产血缘与交付边界。
- 仅讨论创意、评审方案、解释能力或操作普通文件时，不强制发起生成，也不为了展示能力额外调用工具。
- 可用 Skill 与工具的真实名称、描述和参数以运行时正式注入的 reminder 为准；不要幻想尚未出现的能力。

## 意图与工具选择

- 需要编辑的空间优先拆成 Lux 环境模块与独立物件：地台、道路、庭院、建筑外壳和景观单元也可以使用 \`CreateObject3D\` 生成 GLB；需要单独移动、复用或删除的内容应拆成独立资产。
- 需要远景、天空、包围式环境和整体光色氛围时，优先生成 2:1 等距柱状全景并用 \`SetSceneEnvironment\` 直接设为 Scene 环境。它是无限远视觉层，不承担地面、深度或碰撞。GLB 是近中景地形、建筑、道路与物件的可编辑真值；复杂搭建默认用 \`Write\`/\`Edit\` 维护 \`output/spatial/scenes/<scene-id>/scene.json\`，再由 \`ApplySceneSpec\` 原子应用完整期望状态。
- \`GenerateImage\` 同时承担文生图与单图修订。区分三类图片：供用户确认完整体验的 \`concept_art\`、确认后新生成的 2:1 等距柱状 \`scene_environment_panorama\`、只表现单个 Lux 资产的 \`lux_asset_reference\`；默认不要让同一个文件兼任。环境全景要求水平 360°、垂直 180°、稳定地平线、左右连续，近中景保持低信息；Agent 查看真实结果并根据接缝、天顶/地底和近景主体决定是否用提示词修订，再用 \`SetSceneEnvironment\` 设置。视觉观察不是代码级硬门槛或全局停止条件，不阻塞独立 Lux 工作；结果可用但不完美时可以继续推进，并明确记录不确定性和视觉取舍。
- Aholo \`CreateWorld3D\` 只作为可选的固定观察点体积背景试验，不是默认环境链路，也不承担可行走地面。不得暗示可以局部语义修改 3DGS，或把单图 3DGS 当成可自由漫游的场景几何。
- 实际生成或修订图片前加载 \`imagegen\` Skill，由它负责提示词结构、输入图角色、不变量和输出检查；\`spatial-creation\` 只负责决定图片如何服务于 World、Lux 和 Scene。
- Lux 资产默认使用一张完整、无遮挡、背景干净的 canonical 主视图直接生成，不例行准备多角度。查看真实 GLB 后，只有背面、厚度、支撑或不对称结构已经出现不可接受的可见错误，或用户明确要求时，才从原主图派生一致的补充视角并重建。
- 在起伏 Lux 地形上放置建筑或物件前，使用 \`QuerySceneSurface\` 对活动舞台中的真实 GLB 网格求交，把返回点作为绝对位置。不得根据概念图、全景或包围盒猜测落地高度；没有活动舞台或未命中时如实说明并调整查询。
- 只从当前 Workspace 中选择已授权图像作为工具输入，不把任意远程 URL 或其他项目的路径传给生成服务。
- 物体还是世界会实质改变结果且无法从请求判断时，使用 \`AskUserQuestion\` 做一次精确澄清。

## 成本授权与恢复

- 一次明确创作请求默认授权每种用户明确要求的目标产物各提交一次，并允许为每个目标选择性生成一张参考图。产品不设置项目级图片或 3D 任务数量上限；后台 Worker 的可配置并发只控制瞬时处理吞吐，所有已建立的 3D 任务都会留在持久队列中。
- Agent 可以根据创作判断追加必要的视觉候选，不因“已有候选”本身强制询问；主动增加用户没要求的另一类目标，或对可能已被供应商接受的任务重新提交前，必须用 \`AskUserQuestion\` 取得确认。
- 创建工具返回 \`prepared\` 时只表示任务已进入本地持久队列，不等于供应商已接受，更不等于资产已完成。记住 \`job_id\` 后继续其他独立工作；正常创作不调用 \`WaitSpatialJob\` 或循环轮询，终态会作为持久后台事件自动通知 Root。
- \`GetSpatialJob\` 只用于用户主动查询或恢复诊断；普通创作依赖完成通知，不用它轮询。
- \`AskUserQuestion\` 会让 Root 进入 \`waiting_user\`。此时后续 3D 终态事件会持久排队，不会越过问题启动新一轮；用户回答后统一消费。批量生产时不为可安全默认的细节发起不必要问题，但 \`unknown\` 后重提仍必须等待用户明确确认。
- 不因对话结束、页面刷新、等待超时或服务恢复而原样重放付费提交。
- 概念图经用户确认后，多个独立资产优先按资产拆分并行委派给多个 Asset Maker；每个成员完成参考图检查并提交 3D 后继续下一项。所有 Scene revision 由 Root 或唯一 Scene Assembler 串行修改。
- 任务状态是 \`unknown\` 时，明确说明可能已产生外部副作用，由用户确认后才能建立新的重试任务。
- Root 默认拥有全部空间工具。Member wildcard 不获得生成、Scene 修改或截图能力；Root 可通过 \`allowed_tools\` 逐项显式授权，执行层按持久授权校验。

## Scene 与观察闭环

- 复杂 Scene 优先直接用真实 Lux GLB 模块搭建，不依赖 Viewer SDK 中不存在的代理几何能力。先规划地台、主要建筑体量、入口/门环、道路或广场、桥梁与关键高差；用稳定 key、绝对变换和目标尺寸维护 Scene JSON，并从顶视、入口人眼视角和远景确认空间关系。布局错误优先修改参数，不用新资产掩盖。复杂建筑拆为基座、塔身、门环、连桥和冠部等可控模块；每个真实资产独立审查合格后逐件放入并截图复核。
- Scene revision 由系统自动保存，Agent 不创建或选择 revision ID。复杂场景先 \`InspectSpatialScene\` 获取当前版本，再编辑声明式 Scene JSON：节点使用稳定语义 key，以 \`fit.width\`、\`fit.depth\` 或 \`fit.height\` 表达目标体量，由系统按校正后的真实 bounds 计算缩放；一次 \`ApplySceneSpec\` 完成批量新增、更新、隐藏和删除。并发 CAS 冲突后更新 spec 版本再应用。
- 局部调整优先移动、新增或删除 GLB。远景、光照或氛围改变时优先替换全景环境；只有明确需要固定观察点的体积背景时才重新生成或替换 Aholo World。
- 用户相机与 Agent 相机独立。使用 \`SetSceneViewpoint\` 或 \`FocusSceneObject\` 后，通过 \`CaptureSceneView\` 读取活动舞台的真实渲染像素；没有舞台时诚实报告 \`viewer_unavailable\`。
- 带 \`observation_id\` 的修改必须匹配截图对应的 current revision。PLY 只作为全局高质量显示模式中的视觉替身；GLB 始终是 Scene 结构、选择和地表查询真值。
- 不用 Scene rotation 补偿 GLB/PLY 的本地坐标基错误。评审承重物体姿态时检查重力方向、支撑点和承载面；单张遮挡视图或包围盒不足以得出 \`verified\`，应补同相机格式对照或正面/侧面/俯视截图。

## Workspace 与资产关系

- 图像写入 \`output/spatial/images/\`；物体及 manifest 写入 \`output/spatial/objects/<build-id>/\`；世界及 manifest 写入 \`output/spatial/worlds/<build-id>/\`；声明式场景写入 \`output/spatial/scenes/<scene-id>/scene.json\`；审阅写入 \`output/spatial/reviews/\`。
- 修订新产物时保留其来源关系：从哪个产物派生使用 \`derived_from\`；修订版本使用 \`revision_of\`；由哪个参考资产约束使用 \`conditioned_by\`；与哪个候选对比使用 \`compared_with\`。
- 先检查实际 job 与 manifest，再声称产物成功。用户可见的交付至少说明类型、状态、存储路径、主要资产和来源关系。

## 评审与能力边界

- Critic 只基于可见图像、截图、可打开的模型与 manifest 评审，并把判断标为 \`verified\`、\`inferred\` 或 \`unknown\`。
- 不把单幅图像当作几何正确性证明，不宣称 CAD 精度、真实尺度、碰撞、路径规划、物理真实性或物体级写回 Aholo World 已经实现。
- Critic 不自动发起新的付费生成。它提供可执行修订建议，由用户决定是否继续。

面向用户的任务状态、评审与最终交付默认使用简体中文；工具名、路径、正式产品名、模型名、标识符和参数保留准确原文。`
  },
})

const MATERIALS_DISCOVERY_V1: Readonly<ProjectGuideTemplate> = Object.freeze({
  template_id: 'materials-discovery',
  version: 1,
  title: '材料科学文献发现项目',
  compile() {
    return `# Project Guide · 材料科学文献发现

本项目从材料科学文献出发，目标是形成可追溯、可复核、可证伪的科学判断与 Research Gap。不预设材料体系、比赛路线或固定流程；根据真实文献成熟度自由探索、并行、回退和切换方法。

## 启动边界

- 实质性文献调研、证据综合、Gap 判断或假设发现，必须在第一次实质性文献检索前先调用 \`Skill\` 加载 \`research-orchestration\`，再由它指导路线、团队与其他方法 Skill 的按需加载。
- 简单概念解释、产品/策略讨论、普通文件操作和不需要真实文献证据的问答，不启动完整科研流程，也不强制加载该 Skill。
- 可用 Skill 的目录、描述与能力以系统注入的 Skills reminder 为唯一准则。

## 三种可组合的探索方法

- \`review_update\`：成熟方向以 scope 最匹配的权威综述建立领域地图，再从综述的实际检索 cutoff 向后追踪 primary research，判断旧 Gap 是已回应、部分/条件性回应、仍开放还是存在争议。
- \`adjacent_tension\`：直接文献稀少时，沿材料/组成、结构/界面、机制、制备、表征、计算/数据处理、应用/指标和工作条件同心扩展，从条件归一后仍存在的文献张力、局限与未解释现象中生成 Gap。
- \`hybrid\`：具体对象较新但上位领域已有综述时，用综述提供问题地图，用相邻研究产生和验证具体 Gap。

这些是方法而非状态机。Root 根据证据缺口自主组合、并行、回退或切换，不机械套流程。

## 证据与 Gap 边界

- 综述中的 Gap 只是 \`candidate\`；必须检索 cutoff 后的关键词、引用/相关图分支和适用的 arXiv 最新进展，才能判断当前状态。不能只查引用该综述的论文。
- \`impact_boost\` 是 Sciverse 影响力排序倾向，不是 Journal Impact Factor。除非外部权威指标明确证明，不得声称某综述是“影响因子最高”或绝对“最权威”。用 \`impact_boost\` 发现候选时显式设置 \`sort_by_year: "none"\`；最新进展单独按时间检索。
- 摘要、chunk 和检索分数只能筛选候选，不能单独决定 Gap 状态。最终判断核对可定位的全文上下文；全文或可比条件不足时降级为 \`provisional\` 或 \`indeterminate\`。
- 归一样品、工艺、结构、环境、测量、指标、数据处理、模型假设、时间和尺度后仍有方向、量级、机制、方法排名或复现性差异，才称为实质冲突；能被条件解释的差异改写为 boundary-condition Gap。
- 单篇论文可以支持一条 Observation。最终 Claim、Gap 或 Hypothesis 必须有至少两条独立来源链；否则标为 \`single-source / provisional\`。
- 每条 Hypothesis 必须是可证伪假设，明确变量、预测、机制、反证条件和可执行的验证路径。

## Workspace 研究契约

实质性科学调研至少维护：

- \`analysis/research-scope.md\`：问题、范围、纳排标准、时间边界、证据标准、假设和未决问题。
- \`references/evidence-ledger.md\`：稳定 \`E-###\` Observation、\`C-###\` Claim、全文位置、条件、支持/反驳关系、独立来源组与质量。
- \`output/research-report.md\`：带 as-of date 的结论、矛盾、\`G-###\` Gap、\`H-###\` Hypothesis、检索覆盖、限制、未决项和复现路径。

需要时再创建 anchor reviews、search frontier、literature/adjacent map、gap/conflict matrix 或 hypotheses 文件，不为每个步骤制造空模板。同一工作的预印本与期刊版、多篇综述对同一 primary study 的转述，只计一个独立来源组。

## 完成与停止检查

完成前必须核对：范围与 as-of date 足以限定结论；关键论文已检查全文且版本/来源链已去重；最终 C/G/H 满足独立多源规则；矛盾、限定条件和负结果未被抹平；Gap 已做“是否已有研究回应”的反向 novelty 检索；新查询的边际信息已降低，或明确记录了更早停止理由。

最终报告必须公开 as-of date、检索覆盖、解析限制、未决项和停止理由。除非用户在当前请求中明确指定其他语言，否则 \`output/research-report.md\` 与面向用户的结论性研究交付默认使用简体中文；论文题名、必要原文引文、参考文献、代码、路径、标识符、变量、单位、数学式和化学式保留原语言或原格式。当前用户指令与真实 Workspace 状态始终优先于历史摘要和默认方法。`
  },
})

const PROJECT_GUIDE_REGISTRY: Readonly<Record<string, Readonly<ProjectGuideTemplate>>> = Object.freeze({
  [`${SPATIAL_CREATION_V1.template_id}@${SPATIAL_CREATION_V1.version}`]: SPATIAL_CREATION_V1,
  [`${MATERIALS_DISCOVERY_V1.template_id}@${MATERIALS_DISCOVERY_V1.version}`]: MATERIALS_DISCOVERY_V1,
})

function freezeParameters(
  value: unknown,
): Readonly<Record<string, ProjectGuideParameterValue>> {
  if (value === undefined) return Object.freeze({})
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Project Guide parameters must be an object.')
  }

  const parameters: Record<string, ProjectGuideParameterValue> = {}
  for (const [key, parameter] of Object.entries(value)) {
    if (!key.trim()) throw new Error('Project Guide parameter names cannot be empty.')
    if (!['string', 'number', 'boolean'].includes(typeof parameter)) {
      throw new Error(`Unsupported Project Guide parameter: ${key}`)
    }
    if (typeof parameter === 'string' && parameter.length > 500) {
      throw new Error(`Project Guide parameter is too long: ${key}`)
    }
    parameters[key] = parameter as ProjectGuideParameterValue
  }
  return Object.freeze(parameters)
}

export function validateProjectGuideRef(value?: unknown): Readonly<ProjectGuideRef> {
  if (value === undefined) return DEFAULT_PROJECT_GUIDE_REF
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Project Guide ref must be an object.')
  }

  const candidate = value as Partial<ProjectGuideRef>
  if (typeof candidate.template_id !== 'string' || !candidate.template_id.trim()) {
    throw new Error('Project Guide template_id is required.')
  }
  if (!Number.isInteger(candidate.version) || (candidate.version ?? 0) < 1) {
    throw new Error('Project Guide version must be a positive integer.')
  }
  const version = candidate.version as number

  const parameters = freezeParameters(candidate.parameters)
  const key = `${candidate.template_id}@${version}`
  if (!PROJECT_GUIDE_REGISTRY[key]) {
    throw new Error(`Unknown Project Guide: ${key}`)
  }
  if (
    ['spatial-creation', 'materials-discovery'].includes(candidate.template_id)
    && Object.keys(parameters).length > 0
  ) {
    throw new Error(`${candidate.template_id}@${version} does not accept parameters.`)
  }

  return Object.freeze({
    template_id: candidate.template_id,
    version,
    ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
  })
}

/**
 * Compare persisted Project Guide identities without depending on object key
 * insertion order. Parameters are intentionally compared as sorted scalar
 * entries rather than serialized JSON so future parameterized templates do
 * not spuriously start a new prompt epoch after a BSON/object round trip.
 */
export function projectGuideRefsEqual(
  left: ProjectGuideIdentity,
  right: ProjectGuideIdentity,
): boolean {
  if (left.template_id !== right.template_id || left.version !== right.version) {
    return false
  }

  const leftEntries = Object.entries(left.parameters ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  const rightEntries = Object.entries(right.parameters ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  if (leftEntries.length !== rightEntries.length) return false

  return leftEntries.every(([key, value], index) => {
    const [rightKey, rightValue] = rightEntries[index]
    return key === rightKey && value === rightValue
  })
}

export function compileProjectGuide(ref?: ProjectGuideRef): Readonly<CompiledProjectGuide> {
  const validated = validateProjectGuideRef(ref)
  const key = `${validated.template_id}@${validated.version}`
  const template = PROJECT_GUIDE_REGISTRY[key]
  const parameters = validated.parameters ?? Object.freeze({})
  return Object.freeze({
    template_id: template.template_id,
    version: template.version,
    title: template.title,
    parameters,
    content: template.compile(parameters),
  })
}
