'use client'

import { useState } from 'react'

const FAQ_ITEMS = [
  {
    question: '如何开始一个新项目？',
    answer:
      '点击左侧栏顶部的「新项目」，直接描述想创造的空间体验、独立物体或希望修订的已有资产。可以补充 Workspace 参考图路径、材质、光线、镜头与必须保留的约束。',
  },
  {
    question: 'Agent 会按固定顺序调用工具吗？',
    answer:
      '不会。图像生成、Lux3D 造物、Aholo World 与状态查询都是独立工具。Root Agent 会根据目标、已有资产、成本授权和当前结果自行决定组合；目标仍不明确时才会向你澄清。',
  },
  {
    question: '在哪里查看空间产物？',
    answer:
      '生成图、GLB、World manifest 和评审会发布到 output/spatial/。左侧文件树可打开图片和 3D 模型；聊天中的持久任务卡会继续显示供应商状态，页面刷新不会重新付费提交。',
  },
  {
    question: '需要登录或创建账号吗？',
    answer:
      '不需要。竞赛版是单机本地 Demo，打开后直接进入工作台，没有登录、注册、邀请码或密码管理。',
  },
  {
    question: 'Team 面板表示什么？',
    answer:
      'Team 面板显示 Root 与成员 Agent 的角色和运行状态。成员可以分析简报、检查截图并提出修订意见；首版的生图、Lux3D 与 Aholo 付费工具只允许 Root Agent 调用。',
  },
  {
    question: '任务显示 unknown 代表什么？',
    answer:
      '它表示供应商可能已经接受请求，但系统没有足够证据确认外部任务 ID。为避免重复扣费，系统不会自动重试；只有你确认后才会建立一个全新的提交。',
  },
  {
    question: '为什么没有深色模式切换？',
    answer:
      '竞赛版使用统一的暖纸与赤陶色空间工作台，避免系统主题或旧浏览器偏好让空间舞台回到黑蓝界面。当前固定为浅色视觉，设置菜单不再提供主题切换。',
  },
]

export default function HelpPage() {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)

  return (
    <div className="flex-1 overflow-y-auto py-10 px-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-title font-semibold text-ink tracking-tight mb-2">帮助中心</h1>
        <p className="text-sm text-ink-muted mb-8">常见问题与使用指南</p>

        <div className="space-y-2">
          {FAQ_ITEMS.map((item, i) => (
            <div key={i} className="rounded-card bg-[var(--glass-panel-bg)] backdrop-blur-[20px] backdrop-saturate-150 border border-[var(--glass-panel-border)] shadow-[var(--shadow-glass)] overflow-hidden">
              <button
                onClick={() => setExpandedIndex(expandedIndex === i ? null : i)}
                className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-surface-mid/50 transition-colors"
              >
                <span className="text-sm font-medium text-ink">{item.question}</span>
                <svg
                  className={`w-4 h-4 text-ink-muted shrink-0 ml-4 transition-transform ${
                    expandedIndex === i ? 'rotate-180' : ''
                  }`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
              </button>
              {expandedIndex === i && (
                <div className="px-6 pb-4">
                  <p className="text-sm text-ink-secondary leading-relaxed">{item.answer}</p>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mt-10 rounded-card bg-[var(--glass-panel-bg)] backdrop-blur-[20px] backdrop-saturate-150 border border-[var(--glass-panel-border)] shadow-[var(--shadow-glass)] p-6 text-center">
          <p className="text-sm text-ink-secondary mb-1">还有其他问题？</p>
          <p className="text-sm text-ink-muted">
            请通过左侧栏的「反馈」功能向我们提交你的问题或建议。
          </p>
        </div>
      </div>
    </div>
  )
}
