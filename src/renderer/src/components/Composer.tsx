import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, FastForward, Square } from 'lucide-react'
import { continueGroup, sendPrompt, stop } from '../lib/engine'
import { openExternal } from '../lib/platform'
import { CHATGPT_USAGE_URL } from '../lib/providers/chatgpt'
import type { Session } from '../lib/types'
import { modelLabel, useFeatures, useStore } from '../store'
import { Dot, cn } from './ui'

function paneLabel(session: Session, providers: ReturnType<typeof useStore.getState>['providers']): string {
  if (session.kind === 'group') return `Group (${session.participants.length})`
  const p = session.participants[0]
  if (!p) return 'No model'
  return modelLabel(providers.find((x) => x.id === p.providerId), p.modelId)
}

function whyBlocked(session: Session | undefined): string | null {
  if (!session) return 'Open a chat first.'
  if (session.kind === 'chat' && session.participants.length === 0) return 'Choose a model for this chat first.'
  if (session.kind === 'group' && session.participants.filter((p) => !p.muted).length === 0) {
    return 'Add a model to the group chat first.'
  }
  return null
}

export function Composer() {
  const panes = useStore((s) => s.panes)
  const focusedPane = useStore((s) => s.focusedPane)
  const sessions = useStore((s) => s.sessions)
  const providers = useStore((s) => s.providers)
  const excluded = useStore((s) => s.excludedTargets)
  const running = useStore((s) => s.running)
  const sendOnEnter = useStore((s) => s.settings.sendOnEnter)
  const toggleTarget = useStore((s) => s.toggleTarget)
  const features = useFeatures()
  const [text, setText] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)

  const multi = panes.length > 1
  const broadcasting = multi && features.broadcast
  const focused = focusedPane && panes.includes(focusedPane) ? focusedPane : panes[0]
  const targets = broadcasting ? panes.filter((id) => !excluded[id]) : focused ? [focused] : []
  const busy = targets.filter((id) => running[id])
  const blocked = targets.map((id) => whyBlocked(sessions[id])).find(Boolean) ?? null
  const groupTargets = targets.filter((id) => {
    const s = sessions[id]
    return s?.kind === 'group' && s.messages.some((m) => m.role === 'assistant') && !running[id]
  })
  const canSend = text.trim().length > 0 && targets.length > 0 && busy.length === 0 && !blocked
  // OpenAI's guidelines ask apps to show when a request will use the ChatGPT plan.
  const chatgptProviders = new Set(providers.filter((p) => p.kind === 'chatgpt').map((p) => p.id))
  const usesPlan = targets.some((id) => sessions[id]?.participants.some((p) => !p.muted && chatgptProviders.has(p.providerId)))

  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`
    el.style.overflowY = el.scrollHeight > 260 ? 'auto' : 'hidden'
  }, [text])

  // Focus the box when the active chat changes.
  useLayoutEffect(() => {
    input.current?.focus()
  }, [focused])

  const send = () => {
    if (!canSend) return
    sendPrompt(text, targets)
    setText('')
  }

  const focusedSession = focused ? sessions[focused] : undefined
  const placeholder =
    targets.length > 1
      ? `Message ${targets.length} chats at once`
      : focusedSession?.kind === 'group'
        ? 'Message the group (start with @name to pick who replies)'
        : focusedSession?.participants[0]
          ? `Message ${paneLabel(focusedSession, providers)}`
          : 'Message'

  return (
    <div className={cn('shrink-0 px-4 pb-4 pt-2', multi ? 'w-full' : 'mx-auto w-full max-w-3xl')}>
      {broadcasting && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted">Send to</span>
          {panes.map((id) => {
            const session = sessions[id]
            if (!session) return null
            const on = !excluded[id]
            return (
              <button
                key={id}
                type="button"
                onClick={() => toggleTarget(id)}
                className={cn(
                  'flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 transition-colors',
                  on ? 'border-accent/50 bg-accent-soft text-fg' : 'border-line text-subtle line-through',
                )}
              >
                <Dot color={session.participants[0]?.color ?? '#8f8f8f'} />
                {paneLabel(session, providers)}
              </button>
            )
          })}
        </div>
      )}
      <div className="rounded-3xl border border-line bg-surface p-2 shadow-sm focus-within:border-subtle">
        <textarea
          ref={input}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && busy.length) {
              busy.forEach(stop)
              return
            }
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
            if (e.ctrlKey || e.metaKey || (sendOnEnter && !e.shiftKey)) {
              e.preventDefault()
              send()
            }
          }}
          className="block max-h-[260px] w-full resize-none bg-transparent px-3 py-2 text-[15px] leading-relaxed outline-none placeholder:text-subtle"
        />
        <div className="flex items-center justify-between gap-2 pl-2">
          <div className="min-w-0 truncate text-xs text-subtle">
            {blocked ?? (busy.length ? 'Generating… press Esc to stop' : sendOnEnter ? 'Enter to send, Shift+Enter for a new line' : 'Ctrl+Enter to send')}
          </div>
          <div className="flex items-center gap-1.5">
            {usesPlan && (
              <span className="mr-1 hidden items-center gap-1 text-xs text-muted sm:inline-flex">
                Using ChatGPT plan ·
                <button type="button" onClick={() => openExternal(CHATGPT_USAGE_URL)} className="text-accent hover:underline">
                  Manage usage
                </button>
              </span>
            )}
            {groupTargets.length > 0 && busy.length === 0 && (
              <button
                type="button"
                title="Let the models keep talking for one more round"
                onClick={() => groupTargets.forEach(continueGroup)}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line px-3 text-xs text-muted hover:bg-hover hover:text-fg"
              >
                <FastForward className="size-3.5" /> Continue
              </button>
            )}
            {busy.length > 0 ? (
              <button
                type="button"
                aria-label="Stop generating"
                title="Stop (Esc)"
                onClick={() => busy.forEach(stop)}
                className="inline-flex size-8 items-center justify-center rounded-full bg-fg text-app hover:opacity-80"
              >
                <Square className="size-3 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Send"
                disabled={!canSend}
                onClick={send}
                className="inline-flex size-8 items-center justify-center rounded-full bg-fg text-app transition-opacity hover:opacity-80 disabled:opacity-25"
              >
                <ArrowUp className="size-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
