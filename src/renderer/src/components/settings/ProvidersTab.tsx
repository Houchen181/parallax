import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, KeyRound, LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { removeKey, saveKey } from '../../lib/keys'
import { isDesktop, openExternal } from '../../lib/platform'
import { adapterFor } from '../../lib/providers'
import { DEMO_PROVIDER_ID, availablePresets, presetFor } from '../../lib/providers/presets'
import type { Effort, MaxTokensParam, ProviderConfig } from '../../lib/types'
import { providerReady, useStore } from '../../store'
import { Button, MenuItem, Popover, SettingRow, Switch, cn, inputClass } from '../ui'
import { ChatGPTEditor } from './ChatGPTEditor'
import { ModelList, StatusLine, type Status } from './ProviderParts'

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function ProviderEditor({ provider }: { provider: ProviderConfig }) {
  const savedKeys = useStore((s) => s.savedKeys)
  const settings = useStore((s) => s.settings)
  const chatgptAccounts = useStore((s) => s.chatgptAccounts)
  const updateProvider = useStore((s) => s.updateProvider)
  const removeProvider = useStore((s) => s.removeProvider)
  const refreshKeys = useStore((s) => s.refreshKeys)
  const setProviderModels = useStore((s) => s.setProviderModels)
  const updateFeatures = useStore((s) => s.updateFeatures)
  const preset = presetFor(provider)
  const hasKey = provider.id in savedKeys
  const lockedOrigin = savedKeys[provider.id]
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState<'key' | 'models' | null>(null)
  const [status, setStatus] = useState<Status>(null)

  useEffect(() => {
    setBaseUrl(provider.baseUrl)
    setKeyDraft('')
    setStatus(null)
  }, [provider.id, provider.baseUrl])

  if (provider.kind === 'chatgpt') return <ChatGPTEditor provider={provider} />

  if (provider.kind === 'demo') {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">{provider.name}</h3>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            Three simulated models (Concise, Thorough and Skeptic) that answer with canned or templated text. They need no key and
            cost nothing, so you can try split view, broadcasting, comparison and group chats before connecting a real provider.
          </p>
        </div>
        <SettingRow title="Show the demo models" description="Turn off once you have real providers connected.">
          <Switch label="Show demo models" checked={settings.features.demoProvider} onChange={(v) => updateFeatures({ demoProvider: v })} />
        </SettingRow>
      </div>
    )
  }

  const fetchModels = async (target: ProviderConfig = provider) => {
    setBusy('models')
    setStatus({ kind: 'info', text: 'Contacting the provider…' })
    try {
      const models = await adapterFor(target.kind).listModels(target)
      setProviderModels(target.id, models)
      setStatus({ kind: 'ok', text: `Connected. Found ${models.length} model${models.length === 1 ? '' : 's'}.` })
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  const commitBaseUrl = () => {
    const clean = baseUrl.trim().replace(/\/+$/, '')
    if (clean === provider.baseUrl) return
    if (clean && !originOf(clean)) {
      setStatus({ kind: 'error', text: 'That base URL is not a valid URL.' })
      return
    }
    updateProvider(provider.id, { baseUrl: clean })
  }

  const storeKey = async () => {
    const key = keyDraft.trim()
    if (!key) return
    const url = baseUrl.trim().replace(/\/+$/, '')
    if (!originOf(url)) {
      setStatus({ kind: 'error', text: 'Set a valid base URL before saving the key.' })
      return
    }
    setBusy('key')
    try {
      if (url !== provider.baseUrl) updateProvider(provider.id, { baseUrl: url })
      await saveKey(provider.id, key, url)
      await refreshKeys()
      setKeyDraft('')
      setBusy(null)
      await fetchModels({ ...provider, baseUrl: url })
    } catch (err) {
      setBusy(null)
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  const forgetKey = async () => {
    await removeKey(provider.id)
    await refreshKeys()
    setStatus({ kind: 'info', text: 'Key removed.' })
  }

  const currentOrigin = originOf(provider.baseUrl)
  const keyLockedElsewhere = isDesktop && hasKey && lockedOrigin && currentOrigin && lockedOrigin !== currentOrigin
  const firstParty = provider.kind === 'anthropic' && provider.baseUrl === 'https://api.anthropic.com'

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <input
            value={provider.name}
            onChange={(e) => updateProvider(provider.id, { name: e.target.value })}
            className="w-full rounded-md bg-transparent text-lg font-semibold outline-none focus:bg-sidebar"
            aria-label="Provider name"
          />
          <p className="text-sm text-muted">
            {preset?.description}{' '}
            {provider.kind === 'anthropic' ? 'Anthropic Messages API.' : 'OpenAI-compatible Chat Completions API.'}
          </p>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <span className="text-sm text-muted">Enabled</span>
          <Switch label="Enabled" checked={provider.enabled} onChange={(v) => updateProvider(provider.id, { enabled: v })} />
        </div>
      </div>

      {!isDesktop && preset?.browserSupport === 'no' && (
        <StatusLine status={{ kind: 'error', text: 'This provider does not accept requests from web pages. Use the desktop app for it.' }} />
      )}
      {!isDesktop && preset?.browserSupport === 'unknown' && (
        <StatusLine
          status={{
            kind: 'info',
            text: 'This provider may block requests from web pages (CORS). If it fails here, it will still work in the desktop app.',
          }}
        />
      )}

      <div className="space-y-1.5">
        <div className="text-sm font-medium">Base URL</div>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          onBlur={commitBaseUrl}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          placeholder={provider.kind === 'anthropic' ? 'https://api.anthropic.com' : 'https://example.com/v1'}
          className={cn(inputClass, 'font-mono text-[13px]')}
        />
        {keyLockedElsewhere && (
          <p className="text-xs text-warn">
            The saved key is locked to {lockedOrigin}. Save the key again to use it with this URL.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">
            API key{' '}
            {!provider.requiresKey && <span className="font-normal text-subtle">(not needed for this provider)</span>}
          </div>
          {preset?.keyUrl && (
            <button
              type="button"
              onClick={() => openExternal(preset.keyUrl!)}
              className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
            >
              Get a key <ExternalLink className="size-3" />
            </button>
          )}
        </div>
        {provider.requiresKey &&
          (hasKey ? (
            <div className="flex items-center gap-2 rounded-lg border border-line bg-sidebar px-3 py-2 text-sm">
              <KeyRound className="size-4 text-ok" />
              <span className="flex-1 text-muted">
                Saved {isDesktop ? '(encrypted on this computer)' : '(in this browser)'}
              </span>
              <Button size="sm" variant="ghost" onClick={() => void forgetKey()}>
                Remove
              </Button>
            </div>
          ) : null)}
        {provider.requiresKey && (
          <div className="flex gap-2">
            <input
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void storeKey()}
              placeholder={hasKey ? 'Paste a new key to replace the saved one' : 'Paste your API key'}
              autoComplete="off"
              spellCheck={false}
              className={cn(inputClass, 'font-mono text-[13px]')}
            />
            <Button variant="primary" onClick={() => void storeKey()} disabled={!keyDraft.trim() || busy !== null}>
              {busy === 'key' && <LoaderCircle className="size-4 animate-spin" />}
              Save
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Models</div>
          <Button
            size="sm"
            onClick={() => void fetchModels()}
            disabled={busy !== null || !providerReady({ savedKeys, settings, chatgptAccounts }, provider)}
            title="Fetch the model list (also tests the connection)"
          >
            {busy === 'models' ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            Fetch models
          </Button>
        </div>
        <StatusLine status={status} />
        <ModelList provider={provider} />
      </div>

      {provider.kind === 'anthropic' && (
        <div>
          <div className="text-sm font-medium">Claude options</div>
          <SettingRow
            title="Show thinking"
            description="Stream a summary of the model's reasoning above its answer, for models that think before replying."
          >
            <Switch label="Show thinking" checked={provider.thinking !== false} onChange={(v) => updateProvider(provider.id, { thinking: v })} />
          </SettingRow>
          <SettingRow title="Effort" description="How much the model thinks before answering. Higher is slower and uses more tokens.">
            <select
              value={provider.effort ?? ''}
              onChange={(e) => updateProvider(provider.id, { effort: e.target.value as Effort })}
              className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm"
            >
              <option value="">Model default</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Extra high</option>
              <option value="max">Max</option>
            </select>
          </SettingRow>
          {firstParty && (
            <SettingRow
              title="Fallback after a declined request"
              description="If a supported Claude model's safety system declines a request, the API retries it on a fallback model inside the same call. Such replies are labelled with the model that wrote them."
            >
              <Switch
                label="Refusal fallback"
                checked={provider.refusalFallback !== false}
                onChange={(v) => updateProvider(provider.id, { refusalFallback: v })}
              />
            </SettingRow>
          )}
        </div>
      )}

      {provider.kind === 'openai' && (
        <div>
          <div className="text-sm font-medium">Compatibility</div>
          <SettingRow
            title="Output token limit"
            description="Whether to send the Max output tokens setting, and under which field. Newer OpenAI models use max_completion_tokens."
          >
            <select
              value={provider.maxTokensParam ?? 'none'}
              onChange={(e) => updateProvider(provider.id, { maxTokensParam: e.target.value as MaxTokensParam })}
              className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm"
            >
              <option value="none">Don't send</option>
              <option value="max_tokens">max_tokens</option>
              <option value="max_completion_tokens">max_completion_tokens</option>
            </select>
          </SettingRow>
          <SettingRow
            title="Request token usage"
            description="Asks for exact token counts at the end of each reply (stream_options). Turn off if the server rejects it."
          >
            <Switch label="Request token usage" checked={!!provider.includeUsage} onChange={(v) => updateProvider(provider.id, { includeUsage: v })} />
          </SettingRow>
          <SettingRow title="Model filter" description="Regular expression applied to fetched model ids. Leave empty to keep them all.">
            <input
              value={provider.modelFilter ?? ''}
              onChange={(e) => updateProvider(provider.id, { modelFilter: e.target.value || undefined })}
              placeholder="e.g. ^gpt-"
              className={cn(inputClass, 'h-8 w-56 py-1 font-mono text-xs')}
            />
          </SettingRow>
        </div>
      )}

      <div className="flex justify-end border-t border-line pt-4">
        <Button
          variant="danger"
          onClick={() => {
            if (window.confirm(`Remove ${provider.name}? Its saved key is deleted too.`)) removeProvider(provider.id)
          }}
        >
          <Trash2 className="size-4" /> Remove provider
        </Button>
      </div>
    </div>
  )
}

export function ProvidersTab() {
  const providers = useStore((s) => s.providers)
  const savedKeys = useStore((s) => s.savedKeys)
  const settings = useStore((s) => s.settings)
  const chatgptAccounts = useStore((s) => s.chatgptAccounts)
  const addProvider = useStore((s) => s.addProvider)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [adding, setAdding] = useState<HTMLElement | null>(null)

  const selected = useMemo(
    () => providers.find((p) => p.id === selectedId) ?? providers.find((p) => p.kind !== 'demo') ?? providers[0],
    [providers, selectedId],
  )

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-56 shrink-0 flex-col border-r border-line">
        <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {providers.map((provider) => {
            const ready = providerReady({ savedKeys, settings, chatgptAccounts }, provider)
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => setSelectedId(provider.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm',
                  selected?.id === provider.id ? 'bg-hover' : 'hover:bg-hover',
                )}
              >
                <span
                  className={cn(
                    'size-2 shrink-0 rounded-full',
                    !provider.enabled || (provider.id === DEMO_PROVIDER_ID && !settings.features.demoProvider)
                      ? 'bg-line'
                      : ready
                        ? 'bg-ok'
                        : 'bg-warn',
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{provider.name}</span>
              </button>
            )
          })}
        </div>
        <div className="border-t border-line p-2">
          <Button className="w-full" onClick={(e) => setAdding(e.currentTarget)}>
            <Plus className="size-4" /> Add provider
          </Button>
          <Popover anchor={adding} open={!!adding} onClose={() => setAdding(null)} className="max-h-96 w-72 overflow-y-auto">
            {availablePresets().map((preset) => (
              <MenuItem
                key={preset.id}
                onClick={() => {
                  setSelectedId(addProvider(preset.id))
                  setAdding(null)
                }}
              >
                <span className="block">
                  <span className="block">{preset.name}</span>
                  <span className="block text-xs text-subtle">{preset.description}</span>
                </span>
              </MenuItem>
            ))}
          </Popover>
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        {!isDesktop && (
          <div className="mb-5 rounded-xl border border-line bg-sidebar px-4 py-3 text-[13px] leading-relaxed text-muted">
            You're using the web version. API keys are kept in this browser's storage and sent straight to each provider, never to
            a Parallax server (there isn't one). For the strongest key protection, use the desktop app.
          </div>
        )}
        {selected ? <ProviderEditor key={selected.id} provider={selected} /> : <p className="text-sm text-muted">No providers.</p>}
      </div>
    </div>
  )
}
