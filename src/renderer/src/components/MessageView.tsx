import { memo, useState } from 'react'
import { Brain, ChevronRight, GitCompareArrows, Pencil, RotateCcw, Star, TriangleAlert, Info } from 'lucide-react'
import { editAndResend, regenerate } from '../lib/engine'
import { metricParts } from '../lib/format'
import type { Message, Participant } from '../lib/types'
import { useFeatures, useStore } from '../store'
import { CopyButton, Markdown } from './Markdown'
import { Avatar, Button, IconButton, cn } from './ui'

function TypingDots() {
  return (
    <div className="flex h-7 items-center gap-1" aria-label="Waiting for a reply">
      <span className="typing-dot size-1.5 rounded-full bg-muted" />
      <span className="typing-dot size-1.5 rounded-full bg-muted" />
      <span className="typing-dot size-1.5 rounded-full bg-muted" />
    </div>
  )
}

function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false)
  const expanded = open || live
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 rounded-md py-0.5 text-[13px] text-muted hover:text-fg"
      >
        <Brain className="size-3.5" />
        {live ? 'Thinking…' : 'Thinking'}
        <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
      </button>
      {expanded && (
        <div className="mt-1 whitespace-pre-wrap border-l-2 border-line pl-3 text-[13px] leading-relaxed text-muted">{text}</div>
      )}
    </div>
  )
}

function useBroadcastSize(broadcastId: string | undefined): number {
  return useStore((s) => {
    if (!broadcastId) return 0
    let n = 0
    for (const session of Object.values(s.sessions)) {
      if (session.messages.some((m) => m.broadcastId === broadcastId && m.role === 'user')) n++
    }
    return n
  })
}

function UserMessage({ message, sessionId, canEdit }: { message: Message; sessionId: string; canEdit: boolean }) {
  const features = useFeatures()
  const openCompare = useStore((s) => s.openCompare)
  const sendOnEnter = useStore((s) => s.settings.sendOnEnter)
  const broadcastSize = useBroadcastSize(message.broadcastId)
  const [draft, setDraft] = useState<string | null>(null)

  if (draft !== null) {
    const submit = () => {
      editAndResend(sessionId, message.id, draft)
      setDraft(null)
    }
    return (
      <div className="flex justify-end">
        <div className="w-full max-w-[85%] rounded-2xl border border-line bg-surface p-2">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setDraft(null)
              if (e.key === 'Enter' && (e.ctrlKey || (sendOnEnter && !e.shiftKey))) {
                e.preventDefault()
                submit()
              }
            }}
            rows={Math.min(10, draft.split('\n').length + 1)}
            className="w-full resize-none bg-transparent px-2 py-1 text-[15px] outline-none"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={submit} disabled={!draft.trim()}>
              Send
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="group flex flex-col items-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-3xl bg-bubble px-4 py-2.5 text-[15px] leading-relaxed [overflow-wrap:anywhere]">
        {message.content}
      </div>
      <div className="mt-1 flex items-center gap-0.5">
        {features.compare && broadcastSize > 1 && message.broadcastId && (
          <button
            type="button"
            onClick={() => openCompare(message.broadcastId!)}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-accent hover:bg-accent-soft"
          >
            <GitCompareArrows className="size-3.5" />
            Compare {broadcastSize} replies
          </button>
        )}
        <span className="flex items-center opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton text={message.content} />
          {canEdit && (
            <IconButton label="Edit and resend" className="size-7" onClick={() => setDraft(message.content)}>
              <Pencil className="size-3.5" />
            </IconButton>
          )}
        </span>
      </div>
    </div>
  )
}

function AssistantMessage({
  message,
  sessionId,
  participant,
  canRegenerate,
}: {
  message: Message
  sessionId: string
  participant?: Participant
  canRegenerate: boolean
}) {
  const showMetrics = useStore((s) => s.settings.showMetrics)
  const patchMessage = useStore((s) => s.patchMessage)
  const openSettings = useStore((s) => s.openSettings)
  const name = participant?.name ?? message.model?.label ?? 'Assistant'
  const color = participant?.color ?? '#8f8f8f'
  const streaming = message.status === 'streaming'
  const metrics = showMetrics && !streaming ? metricParts(message.metrics) : []
  const needsSettings = message.error?.includes('Settings →')

  return (
    <div className="group flex gap-3">
      <div className="pt-0.5">
        <Avatar color={color} name={name} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold">{name}</span>
          {message.model && message.model.label !== message.model.modelId && name !== message.model.modelId && (
            <span className="hidden truncate font-mono text-[11px] text-subtle @md:inline">{message.model.modelId}</span>
          )}
          {message.starred && <Star className="size-3.5 fill-current text-warn" />}
        </div>

        {message.reasoning && <Reasoning text={message.reasoning} live={streaming && !message.content} />}

        {message.content ? (
          <Markdown text={message.content} />
        ) : streaming ? (
          !message.reasoning && <TypingDots />
        ) : null}

        {message.status === 'error' && (
          <div className="mt-2 flex flex-col gap-2 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger">
            <div className="flex gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span className="[overflow-wrap:anywhere]">{message.error}</span>
            </div>
            <div className="flex gap-2">
              {needsSettings && (
                <Button size="sm" variant="secondary" onClick={() => openSettings('providers')}>
                  Open settings
                </Button>
              )}
              {canRegenerate && (
                <Button size="sm" variant="secondary" onClick={() => regenerate(sessionId, message.id)}>
                  <RotateCcw className="size-3.5" /> Retry
                </Button>
              )}
            </div>
          </div>
        )}

        {message.notice && (
          <div
            className={cn(
              'mt-2 flex gap-2 rounded-xl px-3 py-2 text-[13px]',
              message.status === 'refused' ? 'bg-warn-soft text-warn' : 'bg-sidebar text-muted',
            )}
          >
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>{message.notice}</span>
          </div>
        )}

        {message.status === 'stopped' && <div className="mt-1 text-xs text-subtle">Stopped</div>}

        {!streaming && (
          <div className="mt-1 flex min-h-7 flex-wrap items-center gap-x-1 gap-y-0.5">
            <span className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              {message.content && <CopyButton text={message.content} />}
              {canRegenerate && message.status !== 'error' && (
                <IconButton label="Regenerate" className="size-7" onClick={() => regenerate(sessionId, message.id)}>
                  <RotateCcw className="size-3.5" />
                </IconButton>
              )}
              <IconButton
                label={message.starred ? 'Unstar' : 'Star this reply'}
                className="size-7"
                onClick={() => patchMessage(sessionId, message.id, { starred: !message.starred })}
              >
                <Star className={cn('size-3.5', message.starred && 'fill-current text-warn')} />
              </IconButton>
            </span>
            {metrics.length > 0 && <span className="ml-auto text-right text-[11px] text-subtle">{metrics.join(' · ')}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

export const MessageView = memo(function MessageView({
  message,
  sessionId,
  participant,
  canRegenerate,
  canEdit,
}: {
  message: Message
  sessionId: string
  participant?: Participant
  canRegenerate: boolean
  canEdit: boolean
}) {
  return (
    <div className="fade-in">
      {message.role === 'user' ? (
        <UserMessage message={message} sessionId={sessionId} canEdit={canEdit} />
      ) : (
        <AssistantMessage message={message} sessionId={sessionId} participant={participant} canRegenerate={canRegenerate} />
      )}
    </div>
  )
})
