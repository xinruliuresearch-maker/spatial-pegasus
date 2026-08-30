import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { loadSkills } from '../loader'

function run(): void {
  const skillPath = path.join(process.cwd(), 'lib', 'skills', 'spatial-creation', 'SKILL.md')
  assert.ok(fs.existsSync(skillPath), 'spatial-creation is missing SKILL.md')

  const raw = fs.readFileSync(skillPath, 'utf8')
  const worldReferencePath = path.join(
    process.cwd(),
    'lib',
    'skills',
    'spatial-creation',
    'references',
    'world-generation.md',
  )
  assert.ok(fs.existsSync(worldReferencePath), 'spatial-creation is missing the World generation reference')
  const worldReference = fs.readFileSync(worldReferencePath, 'utf8')
  const orientationReferencePath = path.join(
    process.cwd(),
    'lib',
    'skills',
    'spatial-creation',
    'references',
    'spatial-orientation-review.md',
  )
  assert.ok(fs.existsSync(orientationReferencePath), 'spatial-creation is missing the orientation review reference')
  const orientationReference = fs.readFileSync(orientationReferencePath, 'utf8')
  const luxReferencePath = path.join(
    process.cwd(),
    'lib',
    'skills',
    'spatial-creation',
    'references',
    'lux-scene-building.md',
  )
  assert.ok(fs.existsSync(luxReferencePath), 'spatial-creation is missing the Lux scene-building reference')
  const luxReference = fs.readFileSync(luxReferencePath, 'utf8')
  const imagegenSkillPath = path.join(process.cwd(), 'lib', 'skills', 'imagegen', 'SKILL.md')
  const imagegenPromptingPath = path.join(
    process.cwd(), 'lib', 'skills', 'imagegen', 'references', 'prompting.md',
  )
  const imagegenSamplesPath = path.join(
    process.cwd(), 'lib', 'skills', 'imagegen', 'references', 'sample-prompts.md',
  )
  assert.ok(fs.existsSync(imagegenSkillPath), 'imagegen is missing SKILL.md')
  assert.ok(fs.existsSync(imagegenPromptingPath), 'imagegen is missing prompting reference')
  assert.ok(fs.existsSync(imagegenSamplesPath), 'imagegen is missing sample prompt reference')
  const imagegenRaw = fs.readFileSync(imagegenSkillPath, 'utf8')
  const imagegenPrompting = fs.readFileSync(imagegenPromptingPath, 'utf8')
  const imagegenSamples = fs.readFileSync(imagegenSamplesPath, 'utf8')
  const loaded = loadSkills().get('spatial-creation')
  assert.ok(loaded, 'spatial-creation was not loaded')
  assert.equal(loaded.name, 'spatial-creation')
  assert.match(loaded.description, /用于/)
  assert.match(loaded.description, /不用于/)

  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(frontmatter, 'spatial-creation needs valid frontmatter')
  const keys = [...frontmatter[1].matchAll(/^([a-z][a-z-]*):/gm)]
    .map(match => match[1])
    .sort()
  assert.deepEqual(keys, ['description', 'name'])

  assert.deepEqual(
    [...loadSkills({ projectGuideTemplateId: 'spatial-creation' }).keys()].sort(),
    ['imagegen', 'spatial-creation'],
    'the default spatial catalog must not expose materials research skills',
  )
  const materialsCatalog = loadSkills({ projectGuideTemplateId: 'materials-discovery' })
  assert.equal(materialsCatalog.has('spatial-creation'), false)
  assert.equal(materialsCatalog.has('imagegen'), false)
  assert.equal(materialsCatalog.has('research-orchestration'), true)

  const loadedImagegen = loadSkills({ projectGuideTemplateId: 'spatial-creation' }).get('imagegen')
  assert.ok(loadedImagegen, 'imagegen was not loaded for the spatial project')
  assert.match(loadedImagegen.description, /用于/)
  assert.match(loadedImagegen.description, /不用于/)
  assert.match(imagegenRaw, /只使用运行时提供的 `GenerateImage`/)
  assert.match(imagegenRaw, /每次调用只支持一张输入图/)
  assert.match(imagegenRaw, /output\/spatial\/images\//)
  assert.match(imagegenRaw, /同步工具[^]*多个 Agent 并行/)
  assert.match(imagegenRaw, /canonical 主图[^]*input_image_path[^]*派生每个方向/)
  assert.match(imagegenRaw, /2:1[^]*World[^]*等距柱状全景/)
  assert.match(imagegenRaw, /\/skills\/imagegen\/references\/prompting\.md/)
  assert.match(imagegenRaw, /\/skills\/imagegen\/references\/sample-prompts\.md/)
  assert.match(imagegenPrompting, /不要在提示词中引用不存在的 Image 2、Image 3/)
  assert.match(imagegenPrompting, /支撑方向、承载面和重力关系/)
  assert.match(imagegenPrompting, /2:1[^]*equirectangular[^]*水平 360°[^]*左右边缘/)
  assert.match(imagegenSamples, /Lux3D 独立资产主视图/)
  assert.match(imagegenSamples, /从主图派生后视图/)
  assert.match(imagegenSamples, /World 专用 2:1 全景环境图/)
  for (const codexOnly of [
    'built-in `image_gen`',
    'scripts/image_gen.py',
    'OPENAI_API_KEY',
    '$CODEX_HOME',
    'view_image',
    'CLI fallback',
  ]) {
    assert.equal(imagegenRaw.includes(codexOnly), false, `imagegen leaked Codex-only guidance: ${codexOnly}`)
    assert.equal(imagegenPrompting.includes(codexOnly), false, `prompting leaked Codex-only guidance: ${codexOnly}`)
    assert.equal(imagegenSamples.includes(codexOnly), false, `samples leaked Codex-only guidance: ${codexOnly}`)
  }

  for (const tool of [
    'GenerateImage',
    'CreateObject3D',
    'CreateWorld3D',
    'GetSpatialJob',
    'WaitSpatialJob',
    'InspectSpatialArtifact',
    'CreateSpatialScene',
    'SetSceneEnvironment',
    'AddSceneTerrain',
    'AddSceneObject',
    'TransformSceneObject',
    'CaptureSceneView',
    'QuerySceneSurface',
    'AskUserQuestion',
  ]) {
    assert.match(raw, new RegExp(`\\b${tool}\\b`), `missing tool guidance for ${tool}`)
  }

  assert.match(raw, /不对项目设置固定的图片或 3D 任务数量上限/)
  assert.match(raw, /Worker[^]*并发[^]*不限制持久队列/)
  assert.doesNotMatch(raw, /最多同时运行两个 3D 生成任务和两个图片生成任务/)
  assert.match(raw, /Member wildcard[^]*Root[^]*allowed_tools[^]*显式授权/)
  assert.match(raw, /unknown[^]*外部副作可能已发生/)
  assert.match(raw, /对话结束[^]*不是付费重试理由/)
  assert.match(raw, /多个相互独立的资产[^]*多个 Asset Maker/)
  assert.match(raw, /早期点子[^]*不要立即创建 Asset Maker[^]*CreateObject3D[^]*CreateWorld3D/)
  assert.match(raw, /AskUserQuestion[^]*真正会改变设计方向的问题[^]*推荐默认值/)
  assert.match(raw, /GenerateImage[^]*完整空间概念美术图/)
  assert.match(raw, /用户的沉默[^]*Agent 自己写出的方案[^]*不算确认/)
  assert.match(raw, /明确确认后[^]*共同视觉基准[^]*资产拆分和并行委派/)
  assert.match(raw, /概念图[^]*给用户确认[^]*不要原样当作 Scene 环境[^]*Lux 单资产[^]*几何参考图/)
  assert.match(raw, /concept_art[^]*scene_environment_panorama[^]*lux_asset_reference[^]*不得由同一个文件兼任/)
  assert.match(raw, /scene_environment_panorama[^]*2:1[^]*等距柱状[^]*SetSceneEnvironment/)
  assert.match(raw, /`concept_art`[^]*普通单向透视环境图[^]*通常不适合作为 360° 环境/)
  assert.match(raw, /不是代码级硬校验[^]*不是全局停止条件[^]*不阻塞其他独立的 Lux/)
  assert.match(raw, /结果可用但不完美[^]*继续推进[^]*不确定性/)
  assert.match(raw, /waiting_user[^]*终态事件[^]*持久排队[^]*这不是通知丢失/)
  assert.match(raw, /实施清单[^]*天空、远景[^]*建筑、道路、地表模块[^]*植物、家具和装饰/)
  assert.match(raw, /明确要求跳过概念阶段[^]*可以直接进入制作/)
  assert.match(raw, /Scene revision[^]*一个写入责任方/)
  assert.match(raw, /复杂场景优先直接用真实 Lux GLB 模块搭建[^]*地台[^]*主建筑体量[^]*门环[^]*道路或广场[^]*桥梁/)
  assert.match(raw, /顶视[^]*入口人眼视角[^]*远景/)
  assert.match(raw, /每个 Lux 资产[^]*独立模型预览[^]*不合格资产[^]*不写入 Scene/)
  assert.match(raw, /稳定 `key`[^]*逐件替换[^]*截图复核/)
  assert.match(raw, /正常创作中不得[^]*WaitSpatialJob/)
  assert.match(raw, /spatial_job_update|持久后台事件/)
  assert.match(luxReference, /异步并行创作/)
  assert.match(luxReference, /当前 Agent 不应停下来等待/)
  assert.match(luxReference, /唯一 Scene Assembler/)
  assert.match(luxReference, /不要依赖 Viewer SDK 中不存在的代理体构造器/)
  assert.match(luxReference, /顶视、入口人眼视角和远景/)
  assert.match(luxReference, /每个 Lux 资产发布后[^]*独立预览[^]*不合格资产不进入 Scene/)

  // Lock the five user-facing decision cases from the 48-hour acceptance
  // plan. These are prompt-contract checks; live provider behavior remains a
  // separate H0 smoke gate and must never be faked in deterministic CI.
  assert.match(raw, /Lux 环境模块[^]*CreateObject3D/)
  assert.match(raw, /远景[^]*SetSceneEnvironment/)
  assert.match(raw, /GenerateImage[^]*完整空间概念美术图[^]*concept_art/)
  assert.match(raw, /CreateWorld3D[^]*文字或单张参考图[^]*可选的固定观察点体积背景/)
  assert.match(raw, /CreateObject3D[^]*默认使用一张已授权的 canonical 主视图/)
  assert.match(raw, /真实 GLB[^]*不可接受的错误[^]*补充视角/)
  assert.match(raw, /\/skills\/spatial-creation\/references\/world-generation\.md/)
  assert.match(raw, /\/skills\/spatial-creation\/references\/lux-scene-building\.md/)
  assert.match(raw, /物体与世界仍有关键歧义[^]*AskUserQuestion/)
  assert.match(raw, /不因为“候选数量”本身强制询问用户/)
  assert.match(raw, /进入已确认制作后[^]*文字已足以表达几何和风格时[^]*直接调用 3D 生成工具/)
  assert.match(raw, /调用 `GenerateImage` 前加载 `imagegen` Skill/)
  assert.match(luxReference, /并行生产[^]*概念方向已经由用户确认/)

  for (const outputPath of [
    'output/spatial/images/',
    'output/spatial/objects/<build-id>/',
    'output/spatial/worlds/<build-id>/',
    'output/spatial/scenes/<scene-id>/scene.json',
    'output/spatial/reviews/',
  ]) {
    assert.ok(raw.includes(outputPath), `missing output path ${outputPath}`)
  }

  for (const relation of ['derived_from', 'revision_of', 'conditioned_by', 'compared_with']) {
    assert.match(raw, new RegExp(`\\b${relation}\\b`), `missing relation ${relation}`)
  }

  for (const reviewStatus of ['verified', 'inferred', 'unknown']) {
    assert.match(raw, new RegExp(`\\b${reviewStatus}\\b`), `missing review status ${reviewStatus}`)
  }
  assert.match(raw, /不宣称 CAD 精度[^]*真实尺度[^]*碰撞[^]*物理正确性/)
  assert.match(raw, /不宣称能局部语义修改 3DGS World/)
  assert.match(raw, /坐标基校准[^]*不属于 Scene 设计变换/)
  assert.match(raw, /TransformSceneObject[^]*补偿格式错误/)
  assert.match(raw, /spatial-orientation-review\.md/)
  assert.match(raw, /单张遮挡视图和包围盒不能证明姿态正确/)
  assert.match(raw, /支撑点[^]*主要承载面/)
  assert.match(raw, /默认使用简体中文/)

  assert.match(worldReference, /默认远景层[^]*SetSceneEnvironment/)
  assert.match(worldReference, /全景环境不产生地面/)
  assert.match(worldReference, /概念美术图[^]*scene_environment_panorama[^]*lux_asset_reference/)
  assert.match(worldReference, /Aholo World[^]*一张已授权 Workspace 图片/)
  assert.match(worldReference, /2:1[^]*等距柱状全景[^]*水平 360°[^]*垂直 180°/)
  assert.match(worldReference, /普通单向透视图[^]*背面[^]*拉伸[^]*重复[^]*无关结构/)
  assert.match(worldReference, /Agent 应查看真实结果[^]*接缝[^]*天顶\/地底/)
  assert.match(worldReference, /不是代码级图片质量门禁/)
  assert.match(worldReference, /不阻塞独立 Lux 资产生产/)
  assert.doesNotMatch(worldReference, /提交前全景门禁|任一项失败|检查合格后/)
  assert.match(worldReference, /近中景保持低信息[^]*不出现需要视差或交互的建筑、道路、家具/)
  assert.match(worldReference, /无限远|包围相机|稳定地包围相机/)
  assert.match(worldReference, /不在接缝截断大型物体/)
  assert.match(worldReference, /地形、建筑或物件[^]*CreateObject3D/)
  assert.match(worldReference, /推荐提示结构/)
  assert.match(worldReference, /AddSceneTerrain[^]*QuerySceneSurface/)
  assert.match(worldReference, /创建 Aholo World[^]*记录 `job_id`/)
  assert.match(worldReference, /unknown[^]*不得自动再次提交/)
  assert.match(worldReference, /published[^]*真实 manifest 和资产/)
  assert.match(orientationReference, /资产本地坐标基[^]*Scene 设计变换/)
  assert.match(orientationReference, /包围盒只能证明[^]*不能证明“哪一边是底部”/)
  assert.match(orientationReference, /同一 Scene revision[^]*同一 instance transform[^]*同一 camera pose/)
  assert.match(orientationReference, /只有一种格式翻倒或侧卧[^]*不修改 Scene/)
  assert.match(orientationReference, /支撑点[^]*承载面/)
  assert.match(orientationReference, /verified[^]*inferred[^]*unknown/)
  assert.match(luxReference, /环境模块[^]*地台[^]*道路段[^]*建筑外壳/)
  assert.match(luxReference, /从概念美术建立实施清单/)
  assert.match(luxReference, /环境清单[^]*近中景低信息[^]*通常不要直接复用[^]*概念图/)
  assert.match(luxReference, /概念美术、环境全景、Lux 单资产参考图[^]*不要混用/)
  assert.match(luxReference, /QuerySceneSurface/)
  assert.match(luxReference, /每个资产[^]*canonical 主视图[^]*主体完整[^]*背景干净/)
  assert.match(luxReference, /建筑主体[^]*塔楼[^]*连廊[^]*入口构筑物[^]*围墙/)
  assert.match(luxReference, /SetSceneEnvironment[^]*不阻塞主 Scene/)
  assert.match(luxReference, /`CreateObject3D`[^]*环境模块/)
  assert.match(luxReference, /同一摆放关系[^]*一个模块/)
  assert.match(luxReference, /canonical 主视图[^]*直接生成/)
  assert.match(luxReference, /真实 GLB[^]*input_image_path[^]*侧视、后视或斜后视/)
  assert.match(luxReference, /单图优先，按证据升级/)
  assert.match(luxReference, /多视角只是有成本的纠错升级[^]*不能证明 CAD 精度/)
  assert.match(raw, /scene\.json[^]*ApplySceneSpec[^]*完整期望状态/)
  assert.match(luxReference, /稳定节点 `key`[^]*目标 `fit` 尺寸[^]*ApplySceneSpec/)
  assert.match(luxReference, /GLB 是 Scene 选择、变换和结构判断的真值/)
  assert.doesNotMatch(raw + worldReference + orientationReference + luxReference, /四图|网页端|内部端点|Python 脚本|Authorization|x-source/)

  console.log('spatial creation skill verification passed')
}

run()
