import { useMemo, useState } from 'react'
import { diffWords } from 'diff'
import { ExternalLink, Star } from 'lucide-react'
import { metricParts } from '../lib/format'
import type { Message, Participant, Session } from '../lib/types'
import { useStore } from '../store'
import { CopyButton, Markdown } from './Markdown'
import { Avatar, Dialog, IconButton, Segmented, cn } from './ui'

interface Entry {
  session: Session
  message: Message
  participant?: Participant
}

function collect(sessions: Record<string, Session>, panes: string[], broadcastId: string) {
  let prompt = ''
  const entries: Entry[] = []
  const ordered = Object.values(sessions).sort((a, b) => {
    const ia = panes.indexOf(a.id)
    const ib = panes.indexOf(b.id)
    if (ia !== -1 || ib !== -1) return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib)
    return a.createdAt - b.createdAt
  })
  for (const session of ordered) {
    const promptMessage = session.messages.find((m) => m.broadcastId === broadcastId && m.role === 'user')
    if (!promptMessage) continue
    prompt = promptMessage.content
    const participants = new Map(session.participants.map((p) => [p.id, p]))
    for (const message of session.messages) {
      if (message.broadcastId === broadcastId && message.role === 'assistant') {
        entries.push({ session, message, participant: message.participantId ? participants.get(message.participantId) : undefined })
      }
    }
  }
  return { prompt, entries }
}

function similarity(a: string, b: string): number {
  if (!a && !b) return 1
  let common = 0
  for (const part of diffWords(a, b)) if (!part.added && !part.removed) common += part.value.length
  return (2 * common) / (a.length + b.length)
}

function DiffText({ base, other }: { base: string; other: string }) {
  const parts = useMemo(() => diffWords(base, other), [base, other])
  return (
    <div className="whitespace-pre-wrap text-[14px] leading-relaxed [overflow-wrap:anywhere]">
      {parts.map((part, i) => (
        <span key={i} className={part.added ? 'diff-added' : part.removed ? 'diff-removed' : undefined}>
          {part.value}
        </span>
      ))}
    </div>
  )
}

type View = 'rendered' | 'diff'

export function CompareDialog() {
  const broadcastId = useStore((s) => s.compareBroadcastId)
  const sessions = useStore((s) => s.sessions)
  const panes = useStore((s) => s.panes)
  const close = useStore((s) => s.closeCompare)
  const openSession = useStore((s) => s.openSession)
  const patchMessage = useStore((s) => s.patchMessage)
  const [view, setView] = useState<View>('rendered')
  const [baseline, setBaseline] = useState(0)

  const { prompt, entries } = useMemo(
    () => (broadcastId ? collect(sessions, panes, broadcastId) : { prompt: '', entries: [] }),
    [broadcastId, sessions, panes],
  )

  const finished = entries.filter((e) => e.message.status === 'done' && e.message.metrics)
  const pick = (score: (e: Entry) => number | undefined, best: 'min' | 'max') => {
    let winner: Entry | undefined
    let value: number | undefined
    for (const entry of finished) {
      const v = score(entry)
      if (v == null) continue
      if (value == null || (best === 'min' ? v < value : v > value)) {
        value = v
        winner = entry
      }
    }
    return finished.length > 1 ? winner?.message.id : undefined
  }
  const badges: Record<string, string[]> = {}
  const award = (id: string | undefined, label: string) => {
    if (id) (badges[id] ??= []).push(label)
  }
  award(pick((e) => e.message.metrics?.firstTokenMs, 'min'), 'Fastest start')
  award(pick((e) => e.message.metrics?.totalMs, 'min'), 'Finished first')
  award(pick((e) => e.message.metrics?.outputTokens, 'max'), 'Most detailed')
  award(pick((e) => e.message.metrics?.outputTokens, 'min'), 'Most concise')

  const base = entries[Math.min(baseline, entries.length - 1)]

  return (
    <Dialog open={!!broadcastId} onClose={close} title="Compare replies" className="h-[88vh] max-w-[min(96vw,1680px)]">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-subtle">Prompt</div>
          <div className="line-clamp-2 text-sm">{prompt}</div>
        </div>
        <Segmented<View>
          value={view}
          onChange={setView}
          options={[
            { value: 'rendered', label: 'Formatted' },
            { value: 'diff', label: 'Differences' },
          ]}
        />
        {view === 'diff' && entries.length > 1 && (
          <label className="flex items-center gap-2 text-sm text-muted">
            Compared with
            <select
              value={baseline}
              onChange={(e) => setBaseline(Number(e.target.value))}
              className="rounded-lg border border-line bg-surface px-2 py-1 text-sm text-fg"
            >
              {entries.map((entry, i) => (
                <option key={entry.message.id} value={i}>
                  {entry.participant?.name ?? entry.message.model?.label ?? `Reply ${i + 1}`}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {entries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">No replies to compare yet.</div>
      ) : (
        <div className="grid min-h-0 flex-1 auto-cols-[minmax(320px,1fr)] grid-flow-col overflow-x-auto">
          {entries.map((entry, index) => {
            const { message, session, participant } = entry
            const name = participant?.name ?? message.model?.label ?? 'Assistant'
            const isBase = view === 'diff' && base?.message.id === message.id
            const overlap =
              view === 'diff' && !isBase && base && message.content && base.message.content
                ? similarity(base.message.content, message.content)
                : undefined
            return (
              <section key={message.id} className="flex min-h-0 flex-col border-r border-line last:border-r-0">
                <header className="space-y-1.5 border-b border-line px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Avatar color={participant?.color ?? '#8f8f8f'} name={name} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{name}</div>
                      <div className="truncate text-xs text-subtle">
                        {session.kind === 'group' ? `${session.title} (group)` : (message.model?.modelId ?? '')}
                      </div>
                    </div>
                    <IconButton
                      label={message.starred ? 'Unstar' : 'Star this reply'}
                      onClick={() => patchMessage(session.id, message.id, { starred: !message.starred })}
                    >
                      <Star className={cn('size-4', message.starred && 'fill-current text-warn')} />
                    </IconButton>
                    <CopyButton text={message.content} />
                    <IconButton
                      label="Open this chat"
                      onClick={() => {
                        openSession(session.id, 'replace')
                        close()
                      }}
                    >
                      <ExternalLink className="size-4" />
                    </IconButton>
                  </div>
                  <div className="flex min-h-5 flex-wrap items-center gap-1">
                    {(badges[message.id] ?? []).map((label) => (
                      <span key={label} className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
                        {label}
                      </span>
                    ))}
                    {isBase && <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] text-muted">Baseline</span>}
                    {overlap != null && (
                      <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] text-muted">
                        {Math.round(overlap * 100)}% same wording
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-subtle">
                    {message.status === 'streaming'
                      ? 'Generating…'
                      : message.status === 'error'
                        ? 'Failed'
                        : metricParts(message.metrics).join(' · ')}
                  </div>
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                  {message.status === 'error' ? (
                    <p className="text-sm text-danger">{message.error}</p>
                  ) : view === 'diff' && base && !isBase ? (
                    <DiffText base={base.message.content} other={message.content} />
                  ) : view === 'diff' ? (
                    <div className="whitespace-pre-wrap text-[14px] leading-relaxed">{message.content}</div>
                  ) : (
                    <Markdown text={message.content || (message.status === 'streaming' ? '…' : '')} />
                  )}
                  {index === 0 && entries.length === 1 && (
                    <p className="mt-4 text-xs text-subtle">Only one reply so far. Broadcast to more chats to compare.</p>
                  )}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </Dialog>
  )
}
