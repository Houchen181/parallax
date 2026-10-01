import { useState } from 'react'
import { X } from 'lucide-react'
import type { ProviderConfig } from '../../lib/types'
import { useStore } from '../../store'
import { Button, cn, inputClass } from '../ui'

export type Status = { kind: 'ok' | 'error' | 'info'; text: string } | null

export function StatusLine({ status }: { status: Status }) {
  if (!status) return null
  return (
    <p
      className={cn(
        'rounded-lg px-3 py-2 text-[13px] [overflow-wrap:anywhere]',
        status.kind === 'ok' && 'bg-accent-soft text-fg',
        status.kind === 'error' && 'bg-danger-soft text-danger',
        status.kind === 'info' && 'bg-sidebar text-muted',
      )}
    >
      {status.text}
    </p>
  )
}

export function ModelList({ provider }: { provider: ProviderConfig }) {
  const updateProvider = useStore((s) => s.updateProvider)
  const [filter, setFilter] = useState('')
  const [custom, setCustom] = useState('')
  const visible = provider.models.filter((m) => !m.hidden).length
  const shown = provider.models.filter((m) => {
    const q = filter.trim().toLowerCase()
    return !q || m.id.toLowerCase().includes(q) || (m.label ?? '').toLowerCase().includes(q)
  })
  const setHidden = (ids: Set<string>, hidden: boolean) =>
    updateProvider(provider.id, { models: provider.models.map((m) => (ids.has(m.id) ? { ...m, hidden } : m)) })

  const addCustom = () => {
    const id = custom.trim()
    if (!id || provider.models.some((m) => m.id === id)) return
    updateProvider(provider.id, { models: [...provider.models, { id, custom: true }] })
    setCustom('')
  }

  const emptyHint =
    provider.kind === 'chatgpt'
      ? 'Sign in and the models on your plan are fetched automatically.'
      : `${provider.requiresKey ? 'Save a key and they are fetched automatically, or ' : 'Fetch them, or '}add a model id below.`

  return (
    <div className="space-y-2">
      {provider.models.length > 8 && (
        <div className="flex items-center gap-2">
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter models" className={cn(inputClass, 'h-8 py-1')} />
          <Button size="sm" onClick={() => setHidden(new Set(shown.map((m) => m.id)), false)}>
            Show all
          </Button>
          <Button size="sm" onClick={() => setHidden(new Set(shown.map((m) => m.id)), true)}>
            Hide all
          </Button>
        </div>
      )}
      <div className="max-h-64 overflow-y-auto rounded-xl border border-line">
        {provider.models.length === 0 && <p className="px-3 py-4 text-center text-[13px] text-muted">No models yet. {emptyHint}</p>}
        {shown.map((model) => (
          <label key={model.id} className="flex items-center gap-3 border-b border-line px-3 py-1.5 last:border-b-0 hover:bg-hover">
            <input
              type="checkbox"
              checked={!model.hidden}
              onChange={(e) => setHidden(new Set([model.id]), !e.target.checked)}
              className="size-4 accent-[var(--accent)]"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{model.label ?? model.id}</span>
              {model.label && <span className="block truncate font-mono text-[11px] text-subtle">{model.id}</span>}
            </span>
            {model.custom && (
              <button
                type="button"
                aria-label={`Remove ${model.id}`}
                onClick={(e) => {
                  e.preventDefault()
                  updateProvider(provider.id, { models: provider.models.filter((m) => m.id !== model.id) })
                }}
                className="rounded p-1 text-subtle hover:bg-hover hover:text-fg"
              >
                <X className="size-3.5" />
              </button>
            )}
          </label>
        ))}
      </div>
      {provider.kind !== 'chatgpt' && (
        <div className="flex items-center gap-2">
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addCustom()}
            placeholder="Add a model id by hand, e.g. gpt-5-mini"
            className={cn(inputClass, 'h-8 py-1 font-mono text-[13px]')}
          />
          <Button size="sm" onClick={addCustom} disabled={!custom.trim()}>
            Add
          </Button>
        </div>
      )}
      <p className="text-xs text-subtle">
        {visible} of {provider.models.length} models appear in the model picker.
      </p>
    </div>
  )
}
