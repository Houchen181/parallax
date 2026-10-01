import { useState } from 'react'
import { CircleCheck, ExternalLink, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react'
import { REPO_URL, bridge, isDesktop, openExternal } from '../../lib/platform'
import { adapterFor } from '../../lib/providers'
import { CHATGPT_USAGE_URL } from '../../lib/providers/chatgpt'
import type { ProviderConfig } from '../../lib/types'
import { providerReady, useStore } from '../../store'
import { Button, SettingRow, Switch, cn } from '../ui'
import { ModelList, StatusLine, type Status } from './ProviderParts'

/** The black-on-light / white-on-dark button OpenAI's guidelines ask for. */
function ContinueWithChatGPT({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-10 items-center justify-center rounded-full bg-fg px-5 text-sm font-medium text-app transition-opacity hover:opacity-85 disabled:opacity-40"
    >
      Continue with ChatGPT
    </button>
  )
}

export function ChatGPTEditor({ provider }: { provider: ProviderConfig }) {
  const account = useStore((s) => s.chatgptAccounts[provider.id])
  const savedKeys = useStore((s) => s.savedKeys)
  const settings = useStore((s) => s.settings)
  const chatgptAccounts = useStore((s) => s.chatgptAccounts)
  const updateProvider = useStore((s) => s.updateProvider)
  const removeProvider = useStore((s) => s.removeProvider)
  const refreshChatGPT = useStore((s) => s.refreshChatGPT)
  const setProviderModels = useStore((s) => s.setProviderModels)
  const setWelcomeOpen = useStore((s) => s.setChatGPTWelcomeOpen)
  const [busy, setBusy] = useState<'signin' | 'signout' | 'models' | null>(null)
  const [status, setStatus] = useState<Status>(null)
  const ready = providerReady({ savedKeys, settings, chatgptAccounts }, provider)

  const fetchModels = async () => {
    setBusy('models')
    setStatus({ kind: 'info', text: 'Loading the models on your plan…' })
    try {
      const models = await adapterFor('chatgpt').listModels(provider)
      setProviderModels(provider.id, models)
      setStatus({ kind: 'ok', text: `Found ${models.length} model${models.length === 1 ? '' : 's'} on your plan.` })
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  const signIn = async (enablePlan = false) => {
    if (!bridge) return
    setBusy('signin')
    setStatus({ kind: 'info', text: 'Finish signing in in the browser window that just opened.' })
    try {
      const result = await bridge.chatgpt.signIn(provider.id, { enablePlan })
      await refreshChatGPT()
      if (result.status === 'signed-in') {
        if (result.account.planEnabled) {
          setBusy(null)
          await fetchModels()
          if (!useStore.getState().settings.chatgptWelcomeSeen) setWelcomeOpen(true)
        } else {
          setStatus({
            kind: 'info',
            text: "You're signed in, but Parallax isn't allowed to use your ChatGPT plan. Enable plan use to chat with it.",
          })
        }
      } else if (result.status === 'declined') {
        setStatus({ kind: 'info', text: 'Sign-in was cancelled in the browser. Nothing was changed.' })
      } else if (result.status === 'cancelled') {
        setStatus(null)
      } else {
        setStatus({ kind: 'error', text: result.message })
      }
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy((b) => (b === 'signin' ? null : b))
    }
  }

  const signOut = async () => {
    if (!bridge) return
    setBusy('signout')
    try {
      const { revoked } = await bridge.chatgpt.signOut(provider.id)
      await refreshChatGPT()
      setStatus(
        revoked
          ? { kind: 'info', text: 'Signed out of ChatGPT.' }
          : {
              kind: 'info',
              text: "Signed out on this computer, but OpenAI didn't confirm it. You can disconnect Parallax in ChatGPT settings.",
            },
      )
    } finally {
      setBusy(null)
    }
  }

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
          <p className="text-sm text-muted">Sign in with ChatGPT. Replies go through the OpenAI Responses API.</p>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <span className="text-sm text-muted">Enabled</span>
          <Switch label="Enabled" checked={provider.enabled} onChange={(v) => updateProvider(provider.id, { enabled: v })} />
        </div>
      </div>

      <div className="rounded-2xl border border-line p-5">
        <div className="text-base font-semibold">Use your ChatGPT plan</div>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          Chat in Parallax with the usage included in your ChatGPT Plus or Pro plan, instead of paying for an API key. Parallax
          can't see your ChatGPT conversations or other account data.
        </p>

        {!isDesktop ? (
          <div className="mt-4 space-y-3">
            <StatusLine status={{ kind: 'info', text: 'Signing in with ChatGPT needs the Parallax desktop app for Windows.' }} />
            <Button onClick={() => openExternal(`${REPO_URL}/releases/latest`)}>
              Download the desktop app <ExternalLink className="size-3.5" />
            </Button>
          </div>
        ) : busy === 'signin' ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 text-sm text-muted">
              <LoaderCircle className="size-4 animate-spin" /> Waiting for you to finish in the browser…
            </span>
            <Button size="sm" variant="ghost" onClick={() => void bridge?.chatgpt.cancelSignIn()}>
              Cancel
            </Button>
          </div>
        ) : account?.signedIn ? (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted">Signed in as</span>
              <span className="font-medium">{account.email ?? 'your ChatGPT account'}</span>
              {account.planEnabled ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent">
                  <CircleCheck className="size-3.5" /> Using ChatGPT plan
                </span>
              ) : (
                <span className="rounded-full bg-warn-soft px-2.5 py-0.5 text-xs font-medium text-warn">Plan use not enabled</span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {!account.planEnabled && (
                <Button variant="primary" onClick={() => void signIn(true)}>
                  Enable ChatGPT plan use
                </Button>
              )}
              <Button onClick={() => openExternal(CHATGPT_USAGE_URL)}>
                Manage usage <ExternalLink className="size-3.5" />
              </Button>
              <Button variant="ghost" onClick={() => void signOut()} disabled={busy !== null}>
                {busy === 'signout' && <LoaderCircle className="size-4 animate-spin" />}
                Sign out
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {account?.needsSignIn && (
              <p className="text-sm text-warn">Your ChatGPT sign-in has expired or was disconnected. Sign in again to keep chatting.</p>
            )}
            <ContinueWithChatGPT onClick={() => void signIn()} disabled={busy !== null} />
          </div>
        )}

        <p className="mt-4 text-xs leading-relaxed text-subtle">
          Usage counts toward your plan's limits and toward any weekly limit you set for Parallax in ChatGPT settings. On Plus, a
          five-hour limit is shared by every app that uses your plan. Temperature and output limits don't apply to plan usage, so
          Parallax doesn't send them.
        </p>
      </div>

      <StatusLine status={status} />

      <div className={cn('space-y-2', !account?.signedIn && 'opacity-60')}>
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Models on your plan</div>
          <Button size="sm" onClick={() => void fetchModels()} disabled={busy !== null || !ready}>
            {busy === 'models' ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            Refresh models
          </Button>
        </div>
        <ModelList provider={provider} />
      </div>

      <SettingRow title="Show reasoning summaries" description="Stream a summary of the model's reasoning above its answer, when the model provides one.">
        <Switch label="Show reasoning summaries" checked={provider.thinking !== false} onChange={(v) => updateProvider(provider.id, { thinking: v })} />
      </SettingRow>

      <div className="flex justify-end border-t border-line pt-4">
        <Button
          variant="danger"
          onClick={() => {
            if (window.confirm(`Remove ${provider.name}? You'll be signed out of ChatGPT in Parallax.`)) removeProvider(provider.id)
          }}
        >
          <Trash2 className="size-4" /> Remove provider
        </Button>
      </div>
    </div>
  )
}
