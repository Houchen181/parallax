import type { ReactNode } from 'react'
import { Info, KeyRound, Database, SlidersHorizontal, ToggleRight, Users } from 'lucide-react'
import type { SettingsTab } from '../../lib/types'
import { useStore } from '../../store'
import { Dialog, cn } from '../ui'
import { AboutTab, DataTab, FeaturesTab, GeneralTab, GroupTab } from './OtherTabs'
import { ProvidersTab } from './ProvidersTab'

const TABS: Array<{ id: SettingsTab; label: string; icon: ReactNode }> = [
  { id: 'providers', label: 'Providers', icon: <KeyRound className="size-4" /> },
  { id: 'features', label: 'Features', icon: <ToggleRight className="size-4" /> },
  { id: 'group', label: 'Group chat', icon: <Users className="size-4" /> },
  { id: 'general', label: 'General', icon: <SlidersHorizontal className="size-4" /> },
  { id: 'data', label: 'Data', icon: <Database className="size-4" /> },
  { id: 'about', label: 'About', icon: <Info className="size-4" /> },
]

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen)
  const tab = useStore((s) => s.settingsTab)
  const openSettings = useStore((s) => s.openSettings)
  const close = useStore((s) => s.closeSettings)

  return (
    <Dialog open={open} onClose={close} title="Settings" className="h-[min(86vh,820px)] max-w-5xl">
      <div className="flex min-h-0 flex-1">
        <nav className="w-48 shrink-0 space-y-0.5 border-r border-line bg-sidebar p-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => openSettings(t.id)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm',
                tab === t.id ? 'bg-hover font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg',
              )}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto">
          {tab === 'providers' && <ProvidersTab />}
          {tab === 'features' && <FeaturesTab />}
          {tab === 'group' && <GroupTab />}
          {tab === 'general' && <GeneralTab />}
          {tab === 'data' && <DataTab />}
          {tab === 'about' && <AboutTab />}
        </div>
      </div>
    </Dialog>
  )
}
