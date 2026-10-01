import { useRef, useState } from 'react'
import { ChevronDown, Download, ExternalLink, Upload } from 'lucide-react'
import { downloadJson } from '../../lib/format'
import { REPO_URL, bridge, openExternal, runtime } from '../../lib/platform'
import type { Session, SpeakingOrder, Theme, ProviderConfig } from '../../lib/types'
import { exportSnapshot, modelLabel, useStore } from '../../store'
import { ModelPicker } from '../ModelPicker'
import { Button, Logo, Segmented, SettingRow, Switch, cn, inputClass } from '../ui'

const PAGES_URL = 'https://houchen181.github.io/parallax/'

export function FeaturesTab() {
  const features = useStore((s) => s.settings.features)
  const updateFeatures = useStore((s) => s.updateFeatures)
  return (
    <div className="p-6">
      <p className="mb-2 text-sm text-muted">Turn the multi-model features on or off. Changes apply immediately.</p>
      <SettingRow
        title="Split view"
        description="Open several chats side by side. Ctrl+click a chat in the sidebar, or use the split button next to it."
      >
        <Switch label="Split view" checked={features.splitView} onChange={(v) => updateFeatures({ splitView: v })} />
      </SettingRow>
      <SettingRow
        title="Broadcast prompts"
        description={
          <>
            With more than one chat open, one message goes to all of them at once. Use the antenna button on a pane to leave it
            out. {!features.splitView && <span className="text-warn">Needs split view.</span>}
          </>
        }
      >
        <Switch
          label="Broadcast prompts"
          checked={features.broadcast}
          disabled={!features.splitView}
          onChange={(v) => updateFeatures({ broadcast: v })}
        />
      </SettingRow>
      <SettingRow
        title="Compare replies"
        description={
          <>
            Adds a Compare button to broadcast messages: the replies side by side with speed, length and a word-level diff.{' '}
            {!(features.splitView && features.broadcast) && <span className="text-warn">Needs broadcast prompts.</span>}
          </>
        }
      >
        <Switch
          label="Compare replies"
          checked={features.compare}
          disabled={!(features.splitView && features.broadcast)}
          onChange={(v) => updateFeatures({ compare: v })}
        />
      </SettingRow>
      <SettingRow
        title="Group chats"
        description="Put several models in one chat. They take turns, see what the others said, and can answer each other."
      >
        <Switch label="Group chats" checked={features.groupChat} onChange={(v) => updateFeatures({ groupChat: v })} />
      </SettingRow>
      <SettingRow title="Demo models" description="Simulated models that work without an API key, handy for trying things out.">
        <Switch label="Demo models" checked={features.demoProvider} onChange={(v) => updateFeatures({ demoProvider: v })} />
      </SettingRow>
    </div>
  )
}

export function GroupTab() {
  const group = useStore((s) => s.settings.group)
  const enabled = useStore((s) => s.settings.features.groupChat)
  const update = useStore((s) => s.updateGroupSettings)
  return (
    <div className="p-6">
      {!enabled && <p className="mb-3 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">Group chats are turned off in Features.</p>}
      <p className="mb-2 text-sm text-muted">Defaults for group chats. Each chat can override rounds and order from its options button.</p>
      <SettingRow title="Rounds after each message" description="How many times each model speaks after you send something. With 2 or more, the models reply to each other.">
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => update({ rounds: n })}
              className={cn('size-8 rounded-lg border text-sm', group.rounds === n ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-hover')}
            >
              {n}
            </button>
          ))}
        </div>
      </SettingRow>
      <SettingRow title="Speaking order" description="In order follows the participant list; shuffled changes the order every round.">
        <Segmented<SpeakingOrder>
          value={group.order}
          onChange={(order) => update({ order })}
          options={[
            { value: 'sequential', label: 'In order' },
            { value: 'random', label: 'Shuffled' },
          ]}
        />
      </SettingRow>
      <SettingRow title="Tell models who's in the chat" description="Adds the list of other participants to each model's instructions.">
        <Switch label="Announce participants" checked={group.announceRoster} onChange={(v) => update({ announceRoster: v })} />
      </SettingRow>
      <div className="mt-4 rounded-xl border border-line bg-sidebar px-4 py-3 text-[13px] leading-relaxed text-muted">
        Every model sees the whole conversation. Its own earlier replies are sent as its turns, and everything else is labelled with
        the speaker, like <span className="font-mono">[User]: …</span> or <span className="font-mono">[Claude Opus 5.5]: …</span>.
        Start a message with <span className="font-mono">@name</span> to hear from one model only.
      </div>
    </div>
  )
}

function DefaultModelButton() {
  const defaultModel = useStore((s) => s.settings.defaultModel)
  const providers = useStore((s) => s.providers)
  const updateSettings = useStore((s) => s.updateSettings)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const provider = providers.find((p) => p.id === defaultModel?.providerId)
  return (
    <>
      <Button onClick={(e) => setAnchor(e.currentTarget)}>
        <span className="max-w-48 truncate">{defaultModel ? modelLabel(provider, defaultModel.modelId) : 'Automatic'}</span>
        <ChevronDown className="size-3.5" />
      </Button>
      <ModelPicker
        anchor={anchor}
        open={!!anchor}
        onClose={() => setAnchor(null)}
        selected={defaultModel}
        align="end"
        onSelect={(ref) => updateSettings({ defaultModel: ref })}
      />
    </>
  )
}

export function GeneralTab() {
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateSettings)
  return (
    <div className="p-6">
      <SettingRow title="Theme">
        <Segmented<Theme>
          value={settings.theme}
          onChange={(theme) => update({ theme })}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </SettingRow>
      <SettingRow title="Send with Enter" description="When off, Enter adds a new line and Ctrl+Enter sends.">
        <Switch label="Send with Enter" checked={settings.sendOnEnter} onChange={(v) => update({ sendOnEnter: v })} />
      </SettingRow>
      <SettingRow title="Show reply stats" description="Time to first token, total time, token count and speed under each reply.">
        <Switch label="Show reply stats" checked={settings.showMetrics} onChange={(v) => update({ showMetrics: v })} />
      </SettingRow>
      <SettingRow title="Default model" description="Used for new chats. Changes to the model you picked most recently.">
        <DefaultModelButton />
      </SettingRow>
      <SettingRow
        title="Temperature"
        description="Leave on Provider default unless you know you need it. Newer Claude and OpenAI reasoning models ignore or reject it, so Parallax only sends it where it's accepted for Claude."
      >
        <div className="flex items-center gap-3">
          {settings.temperature != null && (
            <>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={settings.temperature}
                onChange={(e) => update({ temperature: Number(e.target.value) })}
                className="w-28 accent-[var(--accent)]"
              />
              <span className="w-8 text-right font-mono text-sm">{settings.temperature.toFixed(1)}</span>
            </>
          )}
          <Button size="sm" onClick={() => update({ temperature: settings.temperature == null ? 0.7 : null })}>
            {settings.temperature == null ? 'Provider default' : 'Reset'}
          </Button>
        </div>
      </SettingRow>
      <SettingRow
        title="Max output tokens"
        description="Upper limit for one reply. Claude needs a limit (Parallax lowers it to each model's maximum); other providers get it only if their Compatibility setting says so."
      >
        <input
          type="number"
          min={256}
          step={1024}
          value={settings.maxOutputTokens}
          onChange={(e) => update({ maxOutputTokens: Math.max(256, Number(e.target.value) || 256) })}
          className={cn(inputClass, 'h-8 w-28 py-1 text-right font-mono')}
        />
      </SettingRow>
      <div className="pt-4">
        <div className="text-sm font-medium">Default instructions</div>
        <p className="mb-2 mt-0.5 text-[13px] text-muted">A system prompt for every chat that doesn't have its own.</p>
        <textarea
          value={settings.defaultSystemPrompt}
          onChange={(e) => update({ defaultSystemPrompt: e.target.value })}
          placeholder="e.g. Be concise. Use metric units."
          className={cn(inputClass, 'min-h-24 resize-y')}
        />
      </div>
    </div>
  )
}

interface ImportFile {
  app?: string
  sessions?: Session[]
  providers?: ProviderConfig[]
}

export function DataTab() {
  const importSessions = useStore((s) => s.importSessions)
  const deleteAllSessions = useStore((s) => s.deleteAllSessions)
  const resetSettings = useStore((s) => s.resetSettings)
  const count = useStore((s) => Object.values(s.sessions).filter((x) => x.messages.length > 0).length)
  const fileInput = useRef<HTMLInputElement>(null)
  const [message, setMessage] = useState<string | null>(null)

  return (
    <div className="p-6">
      <p className="mb-2 text-sm text-muted">
        {runtime === 'desktop'
          ? 'Chats are stored on this computer. API keys are encrypted by Windows and are never included in exports.'
          : runtime === 'local'
            ? 'Chats are stored in this browser. API keys and ChatGPT sign-ins are kept by the local Parallax server and are never included in exports.'
            : 'Chats and API keys are stored in this browser only. Exports never include API keys.'}
      </p>
      <SettingRow title="Export chats" description={`Download all ${count} chats, your settings and provider list as JSON.`}>
        <Button onClick={() => downloadJson(`parallax-${new Date().toISOString().slice(0, 10)}.json`, exportSnapshot())}>
          <Download className="size-4" /> Export
        </Button>
      </SettingRow>
      <SettingRow title="Import chats" description="Add chats from a Parallax export. Existing chats are kept.">
        <>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              try {
                const data = JSON.parse(await file.text()) as ImportFile
                if (data.app !== 'parallax' || !Array.isArray(data.sessions)) throw new Error('This is not a Parallax export.')
                const added = importSessions(data.sessions, data.providers)
                setMessage(`Imported ${added} chat${added === 1 ? '' : 's'}.`)
              } catch (err) {
                setMessage(`Import failed: ${err instanceof Error ? err.message : String(err)}`)
              }
            }}
          />
          <Button onClick={() => fileInput.current?.click()}>
            <Upload className="size-4" /> Import
          </Button>
        </>
      </SettingRow>
      {message && <p className="py-2 text-sm text-muted">{message}</p>}
      <SettingRow title="Delete all chats" description="Removes every conversation. Providers, keys and settings stay.">
        <Button
          variant="danger"
          onClick={() => {
            if (window.confirm('Delete all chats? This cannot be undone.')) deleteAllSessions()
          }}
        >
          Delete all
        </Button>
      </SettingRow>
      <SettingRow title="Reset settings" description="Restores features, group chat and general settings to their defaults.">
        <Button
          variant="danger"
          onClick={() => {
            if (window.confirm('Reset all settings to their defaults?')) resetSettings()
          }}
        >
          Reset
        </Button>
      </SettingRow>
    </div>
  )
}

function LinkButton({ href, children }: { href: string; children: string }) {
  return (
    <Button onClick={() => openExternal(href)}>
      {children} <ExternalLink className="size-3.5" />
    </Button>
  )
}

export function AboutTab() {
  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-4">
        <Logo className="size-14" />
        <div>
          <div className="text-xl font-semibold">Parallax</div>
          <div className="text-sm text-muted">
            Version {__APP_VERSION__} ·{' '}
            {runtime === 'desktop' ? `desktop (Electron ${bridge?.versions.electron})` : runtime === 'local' ? 'web, running on this computer' : 'web'}
          </div>
        </div>
      </div>
      <p className="max-w-xl text-sm leading-relaxed text-muted">
        One prompt, many models. Parallax runs Claude, GPT, Gemini and any OpenAI-compatible model side by side, broadcasts a
        prompt to all of them, compares the answers, and lets several models talk in one group chat.
      </p>
      <p className="max-w-xl text-sm leading-relaxed text-muted">
        There is no Parallax server. Your messages go straight from this app to the providers you set up, using your own API keys.
      </p>
      <div className="flex flex-wrap gap-2">
        <LinkButton href={REPO_URL}>Source on GitHub</LinkButton>
        <LinkButton href={`${REPO_URL}/releases/latest`}>Download for Windows</LinkButton>
        {runtime !== 'web' && <LinkButton href={PAGES_URL}>Web version</LinkButton>}
        <LinkButton href={`${REPO_URL}/issues`}>Report an issue</LinkButton>
      </div>
    </div>
  )
}
