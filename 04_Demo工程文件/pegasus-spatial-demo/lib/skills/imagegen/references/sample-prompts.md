# 图片提示词示例

这些是可改写的完整示例，不代表每次都要加入同样多的细节。只保留用户实际需要的要求。

## World 专用 2:1 全景环境图

```text
Use case: photorealistic-natural
Asset type: Aholo World 专用环境全景，不是概念美术或普通透视照片
Primary request: 一个为未来 Lux 场景搭建准备的滨水环境背景，只表达天空、远岸、遥远城市天际线和整体光色
Scene/backdrop: 相机位于未来 Scene 中心；近景和中景是连续、近似水平、开阔的简单地表；所有建筑、道路模块、树、家具和装饰都留给 Lux GLB
Style/medium: 写实自然环境，稳定清晰，无景深虚化
Composition/framing: 严格 2:1 等距柱状全景（equirectangular latitude-longitude panorama），水平 360°、垂直 180°；相机水平，地平线位于画面中线；左右边缘在天空、地形、颜色和光照上无缝衔接
Lighting/mood: 日落前柔和侧光，冷暖平衡
Materials/textures: 只用均匀、连续的简单地表材质承接远景
Constraints: 天顶与地底连续自然；整圈地平线高度一致；近中景完全无明确主体；无文字、Logo、水印
Avoid: 普通透视照片；鱼眼；little planet；柱面裁切；左右接缝不连续；暗角；近中景建筑、道路、墙、树干、车辆或家具；镜像地面；模糊和重复物
```

## Lux 独立物体主图

```text
Use case: product-mockup
Asset type: Lux3D 独立资产主视图
Primary request: 一张未来主义户外长椅，连续弧形金属框架与木质坐面
Scene/backdrop: 干净中性浅灰背景和简单地面
Subject: 单个长椅，全部结构和支撑脚完整可见
Style/medium: 写实产品渲染
Composition/framing: 三分之四前视，正常焦段，主体居中并留足边缘
Lighting/mood: 柔和工作室光，阴影清楚但不过黑
Materials/textures: 拉丝铝合金、温润木纹
Constraints: 四个支撑点明确向下落地；结构左右一致；无其他物体、文字、Logo、水印
Avoid: 悬浮；裁断；鱼眼；景深模糊；复杂背景
```

## 从主图派生后视图

```text
Use case: precise-object-edit
Asset type: Lux3D 多视角参考
Input image: 已确认主视图；作为同一设计的唯一锚点
Primary request: 生成完全相同长椅的正后方视图，只改变相机方位
Composition/framing: 相机绕物体水平旋转约 180°；相同高度、焦段、主体尺度和画幅
Constraints: 不重新设计；保持尺寸比例、部件数量、连接方式、材质、颜色和磨损完全一致；支撑脚仍自然落地；背景保持简洁；无文字、水印
Avoid: 增减扶手或支撑；改变坐面厚度；镜像错误；抬高或推翻物体
```

## Lux 环境模块

```text
Use case: stylized-concept
Asset type: 可编辑的 Lux3D 环境模块
Primary request: 一块模块化滨水步道地台，包含弧形主路径、两级低台阶和一处建筑连接口
Scene/backdrop: 简洁中性背景，不展示完整城市或天空盒
Style/medium: 写实游戏环境资产概念图
Composition/framing: 三分之四俯视但保持正常透视，完整显示模块边界和所有连接面
Materials/textures: 浅色石材、木质步道、窄金属收边
Constraints: 地台连续且基本平整；边界清楚；不放树木、座椅、人物或灯具；无文字、Logo、水印
Avoid: 无边界的大场景；断裂道路；遮挡连接口；漂浮结构
```

## 精确场景修订

```text
Use case: precise-object-edit
Asset type: World 参考图修订
Input image: 当前已确认的空间概念图；作为编辑目标
Primary request: 只扩大入口左侧开口，并保留中央采光和现有空间风格
Constraints: 保持相机、构图、房间尺度、右侧墙体、天窗、材质、家具数量与光照不变；不要新增物体、文字或水印
```

## 光照版本

```text
Use case: lighting-weather
Asset type: Scene 氛围候选
Input image: 当前空间概念图；作为编辑目标
Primary request: 只把时间调整为蓝调时刻，室内暖光刚刚亮起
Constraints: 保持建筑几何、相机位置、构图、物体、材质和空间布局不变；只改变天空、环境光、灯光和相应阴影；无文字、水印
```

## 产品图

```text
Use case: product-mockup
Asset type: 产品视觉参考
Primary request: 一只哑光黑色洗护瓶，极简无品牌标签
Scene/backdrop: 浅灰到白色的干净工作室渐变
Composition/framing: 单个产品居中，轻微三分之四角度，四周留白
Lighting/mood: 柔和棚拍光，反射受控，阴影清晰
Materials/textures: 哑光塑料，标签边缘清楚
Constraints: 无商标、无额外文字、无水印
```

## UI Mockup

```text
Use case: ui-mockup
Asset type: 手机应用首页
Primary request: 本地市集应用首页，展示摊位和当日特价
Style/medium: 可实际开发的产品 UI，不是概念艺术
Composition/framing: 竖屏移动端布局，信息层级清楚
Constraints: 实用布局、清晰排版、无商标、无水印
```

## 信息图

```text
Use case: infographic-diagram
Asset type: 竖版流程信息图
Primary request: 自动咖啡机的工作流程
Subject: Bean Hopper -> Grinder -> Brew Group -> Boiler -> Water Tank -> Drip Tray
Style/medium: 简洁、矢量感的信息图，带清楚箭头和标签
Text (verbatim): "Bean Hopper", "Grinder", "Brew Group", "Boiler", "Water Tank", "Drip Tray"
Constraints: 标签清晰、高对比、不得增加其他文字、无商标、水印
```

## 草图转渲染

```text
Use case: sketch-to-render
Asset type: 物体设计参考
Input image: 当前线稿；作为编辑目标和结构约束
Primary request: 把线稿转换成写实产品渲染
Materials/textures: 根据图中标注使用木材和金属
Constraints: 保持布局、比例、轮廓、部件数量和透视；不增加新结构、文字或水印
```
