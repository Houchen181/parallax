import { PanelLeft, SquarePen } from 'lucide-react'
import { useStore } from '../store'
import { ChatPane } from './ChatPane'
import { Composer } from './Composer'
import { IconButton } from './ui'

export function Workspace() {
  const panes = useStore((s) => s.panes)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const createSession = useStore((s) => s.createSession)
  const multi = panes.length > 1

  const leading = sidebarOpen ? null : (
    <>
      <IconButton label="Show sidebar (Ctrl+B)" onClick={toggleSidebar}>
        <PanelLeft className="size-4" />
      </IconButton>
      <IconButton label="New chat (Ctrl+N)" onClick={() => createSession({ kind: 'chat', placement: 'replace' })}>
        <SquarePen className="size-4" />
      </IconButton>
    </>
  )

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-app">
      <div className="flex min-h-0 flex-1 overflow-x-auto">
        {panes.map((id, index) => (
          <ChatPane key={id} sessionId={id} multi={multi} leading={index === 0 ? leading : undefined} />
        ))}
      </div>
      <Composer />
    </main>
  )
}
