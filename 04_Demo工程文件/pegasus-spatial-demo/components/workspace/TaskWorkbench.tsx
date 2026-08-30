'use client'

import { ChangeEvent, useCallback, useRef, useState } from 'react'
import { ModelPickerModal } from '@/components/chat/ModelPickerModal'
import { FlowingLightFrame } from '@/components/effects/FlowingLightFrame'
import { ProgressiveImage } from '@/components/media/ProgressiveImage'
import { useChatContext } from '@/contexts/ChatContext'
import { useConversations } from '@/hooks/useConversation'
import { useModels } from '@/hooks/useModels'
import { buildBrowserMediaUrl } from '@/lib/media/browser-url'
import type { ImageAttachment, ModelProvider } from '@/lib/types'

const MAX_FILE_SIZE = 20 * 1024 * 1024
const MAX_IMAGES = 5
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

export function buildResearchProjectMessage(question: string, context: string): string {
  return [
    `空间创作目标：${question.trim()}`,
    context.trim() ? `已有素材与约束：\n${context.trim()}` : '',
  ].filter(Boolean).join('\n\n')
}

export function TaskWorkbench({ onSubmit }: {
  onSubmit: (message: string, images?: ImageAttachment[]) => void
}) {
  const [question, setQuestion] = useState('')
  const [context, setContext] = useState('')
  const [contextOpen, setContextOpen] = useState(false)
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([])
  const [uploadingImages, setUploadingImages] = useState(0)
  const [imageUploadError, setImageUploadError] = useState('')
  const [modelOpen, setModelOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { loadConversation, model, setModel } = useChatContext()
  const { conversations } = useConversations()
  const { models, isLoading: modelsLoading } = useModels()
  const selectedModel = models.find(item => item.id === model)
  const supportsVision = selectedModel?.supportsVision ?? true
  const selectedModelName = selectedModel?.name ?? (modelsLoading ? '加载模型…' : model)

  const submit = () => {
    if (!question.trim() || uploadingImages > 0) return
    if (pendingImages.length > 0 && !supportsVision) {
      setImageUploadError('当前模型不支持图片。请移除图片，或切换到支持图片的模型。')
      return
    }
    onSubmit(
      buildResearchProjectMessage(question, context),
      pendingImages.length > 0 ? pendingImages : undefined,
    )
  }

  const processFile = useCallback(async (file: File) => {
    setImageUploadError('')
    if (!supportsVision) {
      setImageUploadError('当前模型不支持图片，请先切换到多模态模型。')
      return
    }
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setImageUploadError('仅支持 PNG、JPEG、GIF 和 WebP')
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      setImageUploadError('单张图片不能超过 20MB')
      return
    }

    setUploadingImages(count => count + 1)
    try {
      const form = new FormData()
      form.append('file', file)
      const response = await fetch('/api/media/upload', { method: 'POST', body: form })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload?.error || `图片上传失败 (${response.status})`)
      const image = payload.image as ImageAttachment | undefined
      if (!image || !('assetId' in image)) throw new Error('图片上传返回了无效资产')
      setPendingImages(current => current.length >= MAX_IMAGES ? current : [...current, image])
    } catch (error) {
      setImageUploadError((error as Error).message)
    } finally {
      setUploadingImages(count => Math.max(0, count - 1))
    }
  }, [supportsVision])

  const processFiles = (files: FileList | null) => {
    if (!files) return
    for (const file of Array.from(files).slice(0, MAX_IMAGES - pendingImages.length)) void processFile(file)
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    processFiles(event.target.files)
    event.target.value = ''
  }

  return (
    <main className="pmo-spatial-home">
      <div className="pmo-spatial-home-glow" aria-hidden="true" />
      <section className="pmo-spatial-launcher" aria-labelledby="spatial-home-title">
        <div className="pmo-spatial-launcher-kicker">
          <span>01</span>
          <p>从一句话开始，Agent 会自己选择图像、Lux 造物、World 与场景编辑工具</p>
        </div>
        <h1 id="spatial-home-title">把脑海里的空间，<br />搭成可以进入的世界。</h1>
        <p className="pmo-spatial-launcher-copy">描述体验、氛围和必须保留的约束。你不需要先选择工作方式，也不需要等待每个 3D 任务结束。</p>

        <FlowingLightFrame
          className="pmo-spatial-composer"
          data-fluid-interaction="ignore"
          onDrop={event => { event.preventDefault(); processFiles(event.dataTransfer.files) }}
          onDragOver={event => event.preventDefault()}
        >
          <textarea
            autoFocus
            value={question}
            onChange={event => setQuestion(event.target.value)}
            onPaste={event => {
              const files = Array.from(event.clipboardData.items)
                .filter(item => item.type.startsWith('image/'))
                .map(item => item.getAsFile())
                .filter((file): file is File => Boolean(file))
              if (files.length === 0) return
              event.preventDefault()
              for (const file of files.slice(0, MAX_IMAGES - pendingImages.length)) void processFile(file)
            }}
            onKeyDown={event => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); submit() }
            }}
            rows={4}
            aria-label="描述想创造的空间"
            placeholder="例如：搭建一座雨夜中的未来植物研究站。中央是干净的开放工作区，周围有发光植物舱、机械臂和可进入的玻璃温室……"
          />

          {pendingImages.length > 0 && (
            <div className="pmo-spatial-composer-previews" aria-label="已上传图片">
              {pendingImages.map((image, index) => (
                <div className="pmo-spatial-composer-preview" key={'assetId' in image ? image.assetId : image.url}>
                  <ProgressiveImage
                    src={'assetId' in image ? buildBrowserMediaUrl(image.assetId, 'thumbnail', image.storageDriver) : image.url}
                    alt={`参考图片 ${index + 1}`}
                    fit="cover"
                    frameClassName="h-full w-full"
                    imageClassName="h-full w-full object-cover"
                  />
                  <button type="button" aria-label={`移除参考图片 ${index + 1}`} onClick={() => setPendingImages(current => current.filter((_, itemIndex) => itemIndex !== index))}>×</button>
                </div>
              ))}
            </div>
          )}

          {contextOpen && (
            <div className="pmo-spatial-composer-context">
              <label htmlFor="spatial-project-constraints">补充约束</label>
              <textarea
                id="spatial-project-constraints"
                value={context}
                onChange={event => setContext(event.target.value)}
                rows={3}
                placeholder="补充必须保留的结构、材质、参考图用途，或不能出现的元素。"
              />
            </div>
          )}

          {(uploadingImages > 0 || imageUploadError) && (
            <div className={`pmo-spatial-composer-status ${imageUploadError ? 'error' : ''}`}>
              {imageUploadError || `正在上传 ${uploadingImages} 张图片…`}
            </div>
          )}

          <div className="pmo-spatial-composer-footer">
            <div className="pmo-spatial-composer-tools">
              <button
                type="button"
                className="pmo-tool-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={!supportsVision || uploadingImages > 0 || pendingImages.length >= MAX_IMAGES}
                title={supportsVision ? '上传参考图片' : '当前模型不支持图片'}
              >
                <span className="pmo-tool-btn-icon" aria-hidden="true">
                  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
                  </svg>
                </span>
                图片
              </button>
              <input ref={fileInputRef} type="file" accept={ACCEPTED_TYPES.join(',')} multiple onChange={handleFileChange} className="hidden" />

              <button type="button" className="pmo-tool-btn model" onClick={() => setModelOpen(true)} title="选择模型">
                <span className="pmo-tool-btn-icon" aria-hidden="true">◐</span>
                <span className="pmo-spatial-model-name">{selectedModelName}</span>
                <span className="pmo-tool-btn-caret" aria-hidden="true">⌄</span>
              </button>

              <button type="button" className={`pmo-tool-btn ${contextOpen ? 'active' : ''}`} onClick={() => setContextOpen(open => !open)} aria-expanded={contextOpen}>
                <span className="pmo-tool-btn-icon" aria-hidden="true">＋</span>
                约束
              </button>
            </div>
            <button type="button" className="pmo-spatial-start" disabled={!question.trim() || uploadingImages > 0} onClick={submit}>开始创作 <span aria-hidden="true">↗</span></button>
          </div>
        </FlowingLightFrame>

        <ModelPickerModal
          open={modelOpen}
          models={models}
          isLoading={modelsLoading}
          selectedId={model}
          onSelect={id => setModel(id as ModelProvider)}
          onClose={() => setModelOpen(false)}
        />
      </section>

      <footer className="pmo-spatial-home-footer">
        <div><span>CAPABILITIES</span><p>图像生成 · Lux 3D 资产 · 混合 Scene · 真实视角观察</p></div>
        {conversations.length > 0 && (
          <div className="pmo-spatial-recents">
            <span>继续最近项目</span>
            {conversations.slice(0, 3).map(item => <button key={item.conversation_id} type="button" onClick={() => loadConversation(item.conversation_id)}><b>{item.title}</b><i>→</i></button>)}
          </div>
        )}
      </footer>
    </main>
  )
}
