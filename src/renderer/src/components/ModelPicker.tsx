import { useMemo, useState } from 'react'
import { Check, KeyRound, Search, Settings2 } from 'lucide-react'
import { providerReady, useStore } from '../store'
import type { ModelInfo, ModelRef, ProviderConfig } from '../lib/types'
import { Popover, cn } from './ui'

export interface ModelGroup {
  provider: ProviderConfig
  models: ModelInfo[]
}

export function useModelGroups() {
  const providers = useStore((s) => s.providers)
  const savedKeys = useStore((s) => s.savedKeys)
  const settings = useStore((s) => s.settings)
  return useMemo(() => {
    const state = { savedKeys, settings }
    const ready: ModelGroup[] = []
    const unavailable: ProviderConfig[] = []
    for (const provider of providers) {
      if (provider.kind === 'demo' && !settings.features.demoProvider) continue
      if (providerReady(state, provider)) {
        const models = provider.models.filter((m) => !m.hidden)
        if (models.length) ready.push({ provider, models })
        else unavailable.push(provider)
      } else if (provider.enabled) {
        unavailable.push(provider)
      }
    }
    // Real providers first, the demo last.
    ready.sort((a, b) => Number(a.provider.kind === 'demo') - Number(b.provider.kind === 'demo'))
    return { ready, unavailable }
  }, [providers, savedKeys, settings])
}

function matches(query: string, provider: ProviderConfig, model: ModelInfo) {
  if (!query) return true
  const q = query.toLowerCase()
  return model.id.toLowerCase().includes(q) || (model.label ?? '').toLowerCase().includes(q) || provider.name.toLowerCase().includes(q)
}

export function ModelPicker({
  anchor,
  open,
  onClose,
  onSelect,
  selected,
  align,
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  onSelect: (ref: ModelRef) => void
  selected?: ModelRef
  align?: 'start' | 'end'
}) {
  const { ready, unavailable } = useModelGroups()
  const openSettings = useStore((s) => s.openSettings)
  const [query, setQuery] = useState('')

  const filtered = ready
    .map((group) => ({ ...group, models: group.models.filter((m) => matches(query, group.provider, m)) }))
    .filter((group) => group.models.length > 0)

  const close = () => {
    setQuery('')
    onClose()
  }

  return (
    <Popover anchor={anchor} open={open} onClose={close} align={align} className="w-80">
      <div className="flex items-center gap-2 border-b border-line px-2.5 pb-1.5 pt-1">
        <Search className="size-4 text-subtle" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models"
          className="h-7 w-full bg-transparent text-sm outline-none placeholder:text-subtle"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && filtered[0]) {
              onSelect({ providerId: filtered[0].provider.id, modelId: filtered[0].models[0].id })
              close()
            }
          }}
        />
      </div>
      <div className="max-h-80 overflow-y-auto py-1">
        {filtered.length === 0 && (
          <div className="px-3 py-4 text-center text-sm text-muted">
            {ready.length === 0 ? 'No models available yet.' : 'No models match.'}
          </div>
        )}
        {filtered.map(({ provider, models }) => (
          <div key={provider.id} className="py-1">
            <div className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">{provider.name}</div>
            {models.map((model) => {
              const active = selected?.providerId === provider.id && selected.modelId === model.id
              return (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => {
                    onSelect({ providerId: provider.id, modelId: model.id })
                    close()
                  }}
                  className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-hover', active && 'bg-hover')}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">{model.label ?? model.id}</span>
                    {model.label && model.label !== model.id && (
                      <span className="block truncate font-mono text-[11px] text-subtle">{model.id}</span>
                    )}
                  </span>
                  {active && <Check className="size-4 text-accent" />}
                </button>
              )
            })}
          </div>
        ))}
        {unavailable.length > 0 && !query && (
          <div className="border-t border-line pt-1">
            {unavailable.map((provider) => (
              <button
                key={provider.id}
                type="button"
                onClick={() => {
                  close()
                  openSettings('providers')
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-muted hover:bg-hover"
              >
                <KeyRound className="size-3.5" />
                <span className="flex-1 truncate">{provider.name}</span>
                <span className="text-xs text-accent">{provider.models.length || !provider.requiresKey ? 'Set up' : 'Add key'}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="border-t border-line pt-1">
        <button
          type="button"
          onClick={() => {
            close()
            openSettings('providers')
          }}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-muted hover:bg-hover hover:text-fg"
        >
          <Settings2 className="size-3.5" />
          Manage providers
        </button>
      </div>
    </Popover>
  )
}
