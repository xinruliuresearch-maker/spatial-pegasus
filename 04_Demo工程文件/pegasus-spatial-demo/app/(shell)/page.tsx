'use client'

import { useChatContext } from '@/contexts/ChatContext'
import { ChatContainer } from '@/components/chat/ChatContainer'
import { WorkspacePanel } from '@/components/workspace/WorkspacePanel'
import { TaskWorkbench } from '@/components/workspace/TaskWorkbench'
import { Skeleton } from '@/components/loading/Skeleton'
import { AgentTeamPanel } from '@/components/team/AgentTeamPanel'
import { PanelResizeHandle } from '@/components/shell/PanelResizeHandle'
import { RIGHT_PANEL_LIMITS, useWorkspaceLayout } from '@/contexts/WorkspaceLayoutContext'

export default function WorkspacePage() {
  const { rightPanelWidth, setRightPanelWidth, resetRightPanelWidth } = useWorkspaceLayout()
  const {
    messages,
    isLoading,
    isLoadingConversation,
    contextUsage,
    sendMessage,
    stopGeneration,
    answerQuestion,
    artifacts,
    showWorkspace,
    quotedSelection,
    setQuotedSelection,
    conversationId,
  } = useChatContext()

  if (isLoadingConversation) {
    return <div className="h-full min-w-0 flex-1 overflow-hidden"><Skeleton variant="workspace" /></div>
  }

  if (messages.length === 0 && !isLoading && !showWorkspace) {
    return (
      <TaskWorkbench
        onSubmit={(message, images) => {
          sendMessage(message, images)
        }}
      />
    )
  }

  return (
    <>
      {showWorkspace && (
        <div className="h-full min-w-0 flex-1 overflow-hidden">
          <WorkspacePanel
            artifacts={artifacts}
            isStreaming={isLoading}
            onQuoteSelection={setQuotedSelection}
            quotedSelection={quotedSelection}
          />
        </div>
      )}
      <main
        data-resizable-panel={showWorkspace ? 'right-conversation' : undefined}
        className={`${showWorkspace ? 'pmo-resizable-panel relative shrink-0' : 'min-w-0 flex-1'} flex min-h-0 flex-col`}
        style={showWorkspace ? { width: rightPanelWidth } : undefined}
      >
        {showWorkspace && <PanelResizeHandle
          edge="left"
          label="调整右侧对话栏宽度"
          value={rightPanelWidth}
          min={RIGHT_PANEL_LIMITS.min}
          max={RIGHT_PANEL_LIMITS.max}
          onChange={setRightPanelWidth}
          onReset={resetRightPanelWidth}
        />}
        <AgentTeamPanel conversationId={conversationId} />
        <div className="min-h-0 flex-1">
          <ChatContainer
            messages={messages}
            isLoading={isLoading}
            onSend={sendMessage}
            onStop={stopGeneration}
            onAnswerQuestion={answerQuestion}
            quotedSelection={quotedSelection}
            onClearQuote={() => setQuotedSelection(null)}
            contextUsage={contextUsage}
          />
        </div>
      </main>
    </>
  )
}
