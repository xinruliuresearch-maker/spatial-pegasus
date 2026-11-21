# Spatial Pegasus

> **Deep Space Disrupt Award · VentureD Hackathon 2026**
>
> An AI world compiler for persistent, editable 3D worlds.

Spatial Pegasus 是 Pegasus 团队为 VentureD Hackathon 2026 构建的 AI 世界编译器。系统通过多模态 Agent 理解文字、图片与空间约束，把模糊意图编译为可执行的 SpaceSpec，并将空间、资产和对象关系组织成可持续观察、检查和修改的三维 Scene。

项目在由群核科技支持的 Deep Space 赛道获得 **Deep Space Disrupt Award（赛道冠军）**。赛事与项目报道见[《48小时，浙工大学生造出冠军项目，拿下“杭州六小龙”Offer》](https://mp.weixin.qq.com/s/USA5ryqqknmbwEV7RqcXGw)。

## 核心能力

- 多模态意图理解、参考检索与空间约束对齐
- SpaceSpec、WorldGraph、Spatial Critic 与 World Memory
- 独立 3D 资产生成、场景编排与对象级编辑
- 持久化 Scene、版本记录和局部增量修改
- Agent 场景观察、异步空间任务与持续工作流

## 仓库内容

- [`02_Spatial-Pegasus_项目说明.txt`](<02_Spatial-Pegasus_项目说明.txt>)：项目简介
- [`03_演示ppt+视频/Spatial-Pegasus-ppt`](<03_演示ppt+视频/Spatial-Pegasus-ppt>)：可编辑的 HTML 路演材料
- [`03_演示ppt+视频/demo演示.mp4`](<03_演示ppt+视频/demo演示.mp4>)：完整演示视频（H.264/AAC MP4）
- [`04_Demo工程文件/pegasus-spatial-demo`](<04_Demo工程文件/pegasus-spatial-demo>)：解压后的可浏览 Demo 源码
- [`04_Demo工程文件/Spatial-Pegasus-Demo工程.zip`](<04_Demo工程文件/Spatial-Pegasus-Demo工程.zip>)：赛事提交时的原始 Demo 工程压缩包

原始工程的环境要求、配置、启动方式、验证命令和架构文档请见[源码说明](<04_Demo工程文件/pegasus-spatial-demo/README.md>)。

## 可运行案例集

完整解压后，Windows 用户双击 `打开项目.cmd` 即可浏览。macOS 或 Linux 用户安装 Node.js 后，在解压目录运行 `node start.cjs --open`。[下载完整案例包（458 MiB）](https://github.com/xinruliuresearch-maker/spatial-pegasus/releases/download/cases-2026-11-21/spatial-pegasus-all-cases.zip)

| 场景 | 可浏览的内容 |
| --- | --- |
| 街角活动、老院子重建、山坳老街 | 在街角移动模型，在院落选择对象，在老街沿四站导览试摆挑担。 |
| 霓港回路 | 从 v2 街道灰盒到 v9 天台放映夜的 8 个正式版本，另附 18 个历史候选。 |
| 装配场景 | 极简会客大厅、整体环境模块、风庭试验场、雨夜废墟植物研究站，以及鎏金沙海的巨构领地、构图灰盒和真实模块装配。 |
| 历史场景 | 29 个保存的版本与构建入口，可从场景库逐项打开。 |

场景库共收录 65 个入口，包含同一作品的不同版本。离线浏览使用包内模型与纹理。完整编辑工作台的启动入口是 `启动完整工作台.cmd`。[版本说明与文件校验](https://github.com/xinruliuresearch-maker/spatial-pegasus/releases/tag/cases-2026-11-21)

## 克隆仓库

```bash
git clone https://github.com/xinruliuresearch-maker/spatial-pegasus.git
```

## Attribution

Spatial Pegasus 由 Pegasus 团队的 Xinru Liu 和 Kevin 共同完成。[Xinru Liu](https://github.com/xinruliuresearch-maker) · [Kevin](https://github.com/HANsoA-KevinO) · [Kevin 分享的开发仓库](https://github.com/HANsoA-KevinO/pegasus-spatial)

## License

本项目目前未声明开源许可证。使用或再分发前，请参阅[源码中的许可说明](<04_Demo工程文件/pegasus-spatial-demo/README.md#许可>)并联系项目所有者获得明确授权。
