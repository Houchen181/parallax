import { useEffect } from 'react'
import { CompareDialog } from './components/CompareDialog'
import { NewCompareDialog } from './components/NewCompareDialog'
import { SettingsDialog } from './components/settings/SettingsDialog'
import { Sidebar, suggestGroupModels } from './components/Sidebar'
import { Logo } from './components/ui'
import { Workspace } from './components/Workspace'
import { startDemo } from './lib/engine'
import { useStore } from './store'

const params = new URLSearchParams(window.location.search)

function useTheme() {
  const theme = useStore((s) => s.settings.theme)
  useEffect(() => {
    const forced = params.get('theme')
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const mode = forced === 'dark' || forced === 'light' ? forced : theme
      const dark = mode === 'dark' || (mode === 'system' && media.matches)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const state = useStore.getState()
      const key = event.key.toLowerCase()
      if (key === 'n' && !event.shiftKey) {
        event.preventDefault()
        state.createSession({ kind: 'chat', placement: 'replace' })
      } else if (key === 'n' && event.shiftKey && state.settings.features.groupChat) {
        event.preventDefault()
        state.createSession({ kind: 'group', models: suggestGroupModels(state), placement: 'replace' })
      } else if (key === 'b') {
        event.preventDefault()
        state.toggleSidebar()
      } else if (key === ',') {
        event.preventDefault()
        state.settingsOpen ? state.closeSettings() : state.openSettings()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

let demoStarted = false

export default function App() {
  const hydrated = useStore((s) => s.hydrated)
  useTheme()
  useShortcuts()

  // ?demo=compare or ?demo=group opens a ready-made demo (used for screenshots and the web version).
  useEffect(() => {
    if (!hydrated || demoStarted) return
    const demo = params.get('demo')
    if (demo === 'compare' || demo === 'group') {
      demoStarted = true
      if (params.has('nosidebar') && useStore.getState().sidebarOpen) useStore.getState().toggleSidebar()
      startDemo(demo)
    }
  }, [hydrated])

  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center">
        <Logo className="size-12 animate-pulse" />
      </div>
    )
  }

  return (
    <div className="flex h-full">
      <Sidebar />
      <Workspace />
      <SettingsDialog />
      <CompareDialog />
      <NewCompareDialog />
    </div>
  )
}
