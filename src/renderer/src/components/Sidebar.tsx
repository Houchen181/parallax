import { useMemo, useState, type ReactNode } from 'react'
import {
  Columns2,
  Columns3,
  Ellipsis,
  MessageSquare,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings,
  SquarePen,
  Trash2,
  Users,
} from 'lucide-react'
import { sessionGroups } from '../lib/format'
import { DEMO_PROVIDER_ID } from '../lib/providers/presets'
import type { ModelRef, Session } from '../lib/types'
import { providerReady, useFeatures, useStore, type AppState } from '../store'
import { IconButton, Logo, MenuItem, Popover, cn, inputClass } from './ui'

/** Models for a new group chat: one per connected provider, or two from the only one, or the demo trio. */
export function suggestGroupModels(state: AppState): ModelRef[] {
  const ready = state.providers.filter((p) => p.kind !== 'demo' && providerReady(state, p))
  const firstModels = ready
    .map((p) => ({ provider: p, models: p.models.filter((m) => !m.hidden) }))
    .filter((x) => x.models.length > 0)
  if (firstModels.length >= 2) {
    return firstModels.slice(0, 3).map(({ provider, models }) => ({ providerId: provider.id, modelId: models[0].id }))
  }
  if (firstModels.length === 1) {
    const { provider, models } = firstModels[0]
    return models.slice(0, 2).map((m) => ({ providerId: provider.id, modelId: m.id }))
  }
  const demo = state.providers.find((p) => p.id === DEMO_PROVIDER_ID)
  if (demo && providerReady(state, demo)) return demo.models.map((m) => ({ providerId: demo.id, modelId: m.id }))
  return []
}

function NavButton({ icon, label, hint, onClick }: { icon: ReactNode; label: string; hint?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-fg hover:bg-hover"
    >
      <span className="flex size-4 items-center justify-center text-muted">{icon}</span>
      <span className="flex-1">{label}</span>
      {hint && <span className="text-[11px] text-subtle">{hint}</span>}
    </button>
  )
}

function SessionItem({ session, active, visible }: { session: Session; active: boolean; visible: boolean }) {
  const openSession = useStore((s) => s.openSession)
  const updateSession = useStore((s) => s.updateSession)
  const renameSession = useStore((s) => s.renameSession)
  const deleteSession = useStore((s) => s.deleteSession)
  const running = useStore((s) => !!s.running[session.id])
  const features = useFeatures()
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [renaming, setRenaming] = useState(false)
  const close = () => setMenu(null)

  if (renaming) {
    return (
      <input
        autoFocus
        defaultValue={session.title}
        className={cn(inputClass, 'h-8 py-1')}
        onBlur={(e) => {
          renameSession(session.id, e.target.value)
          setRenaming(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setRenaming(false)
        }}
      />
    )
  }

  return (
    <div
      className={cn(
        'group relative flex items-center rounded-lg text-sm',
        active ? 'bg-hover' : visible ? 'bg-hover/50' : 'hover:bg-hover',
      )}
    >
      <button
        type="button"
        onClick={(e) => openSession(session.id, e.ctrlKey || e.metaKey ? 'split' : 'replace')}
        title={features.splitView ? 'Ctrl+click to open beside the current chat' : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left"
      >
        {session.kind === 'group' ? (
          <Users className="size-3.5 shrink-0 text-muted" />
        ) : (
          <MessageSquare className="size-3.5 shrink-0 text-muted" />
        )}
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        {running && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
        <span className="flex shrink-0 -space-x-1 group-hover:hidden">
          {session.participants.slice(0, 3).map((p) => (
            <span key={p.id} className="size-2 rounded-full ring-1 ring-sidebar" style={{ backgroundColor: p.color }} />
          ))}
        </span>
      </button>
      <div className={cn('hidden shrink-0 items-center pr-1 group-hover:flex', menu && 'flex')}>
        {features.splitView && !visible && (
          <IconButton label="Open beside the current chat" className="size-7" onClick={() => openSession(session.id, 'split')}>
            <Columns2 className="size-3.5" />
          </IconButton>
        )}
        <IconButton label="More" className="size-7" onClick={(e) => setMenu(e.currentTarget)}>
          <Ellipsis className="size-3.5" />
        </IconButton>
      </div>
      <Popover anchor={menu} open={!!menu} onClose={close} align="end" className="w-44">
        <MenuItem icon={<Pencil className="size-3.5" />} onClick={() => (close(), setRenaming(true))}>
          Rename
        </MenuItem>
        <MenuItem
          icon={session.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          onClick={() => (close(), updateSession(session.id, { pinned: !session.pinned }))}
        >
          {session.pinned ? 'Unpin' : 'Pin'}
        </MenuItem>
        <MenuItem
          danger
          icon={<Trash2 className="size-3.5" />}
          onClick={() => {
            close()
            if (session.messages.length === 0 || window.confirm(`Delete "${session.title}"?`)) deleteSession(session.id)
          }}
        >
          Delete
        </MenuItem>
      </Popover>
    </div>
  )
}

export function Sidebar() {
  const open = useStore((s) => s.sidebarOpen)
  const sessions = useStore((s) => s.sessions)
  const panes = useStore((s) => s.panes)
  const focusedPane = useStore((s) => s.focusedPane)
  const createSession = useStore((s) => s.createSession)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const openSettings = useStore((s) => s.openSettings)
  const setNewCompareOpen = useStore((s) => s.setNewCompareOpen)
  const readyCount = useStore((s) => s.providers.filter((p) => p.kind !== 'demo' && providerReady(s, p)).length)
  const features = useFeatures()
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = Object.values(sessions).filter(
      (s) =>
        s.messages.length > 0 &&
        (!q || s.title.toLowerCase().includes(q) || s.messages.some((m) => m.content.toLowerCase().includes(q))),
    )
    return sessionGroups(list)
  }, [sessions, query])

  if (!open) return null

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-sidebar">
      <div className="flex h-12 items-center justify-between pl-3.5 pr-2">
        <div className="flex items-center gap-2">
          <Logo className="size-6" />
          <span className="text-[15px] font-semibold tracking-tight">Parallax</span>
        </div>
        <IconButton label="Hide sidebar (Ctrl+B)" onClick={toggleSidebar}>
          <PanelLeftClose className="size-4" />
        </IconButton>
      </div>

      <nav className="space-y-0.5 px-2">
        <NavButton
          icon={<SquarePen className="size-4" />}
          label="New chat"
          hint="Ctrl+N"
          onClick={() => createSession({ kind: 'chat', placement: 'replace' })}
        />
        {features.groupChat && (
          <NavButton
            icon={<Users className="size-4" />}
            label="New group chat"
            onClick={() =>
              createSession({ kind: 'group', models: suggestGroupModels(useStore.getState()), placement: 'replace' })
            }
          />
        )}
        {features.broadcast && (
          <NavButton icon={<Columns3 className="size-4" />} label="Compare models" onClick={() => setNewCompareOpen(true)} />
        )}
      </nav>

      <div className="px-2 pt-3">
        <label className="flex items-center gap-2 rounded-lg border border-line bg-app px-2.5">
          <Search className="size-3.5 text-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-subtle"
          />
        </label>
      </div>

      <div className="mt-2 flex-1 overflow-y-auto px-2 pb-2">
        {groups.length === 0 && (
          <p className="px-2.5 py-6 text-center text-xs text-subtle">{query ? 'No chats match.' : 'Your chats will appear here.'}</p>
        )}
        {groups.map((group) => (
          <div key={group.label} className="mb-3">
            <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold text-subtle">{group.label}</div>
            <div className="space-y-0.5">
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === focusedPane}
                  visible={panes.includes(session.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-line p-2">
        <NavButton icon={<Settings className="size-4" />} label="Settings" hint="Ctrl+," onClick={() => openSettings()} />
        <button
          type="button"
          onClick={() => openSettings('providers')}
          className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-muted hover:bg-hover"
        >
          <span className={cn('size-1.5 rounded-full', readyCount ? 'bg-ok' : 'bg-warn')} />
          {readyCount ? `${readyCount} provider${readyCount > 1 ? 's' : ''} connected` : 'No API keys yet: add one'}
        </button>
      </div>
    </aside>
  )
}
