import { useMemo } from 'react'
import { del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval'
import { create } from 'zustand'
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware'
import type { ChatGPTAccount } from '../../../shared/bridge'
import { listSavedKeys, removeKey } from '../lib/keys'
import { bridge, isDesktop, newId } from '../lib/platform'
import { autoTitle } from '../lib/prompt'
import {
  DEMO_PROVIDER_ID,
  PRESETS,
  colorFor,
  defaultProviders,
  demoProvider,
  providerFromPreset,
} from '../lib/providers/presets'
import type {
  FeatureFlags,
  GroupSettings,
  Message,
  ModelInfo,
  ModelRef,
  Participant,
  ProviderConfig,
  Session,
  SessionKind,
  Settings,
  SettingsTab,
} from '../lib/types'

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  sendOnEnter: true,
  showMetrics: true,
  defaultModel: undefined,
  defaultSystemPrompt: '',
  temperature: null,
  maxOutputTokens: 64000,
  features: { splitView: true, broadcast: true, compare: true, groupChat: true, demoProvider: true },
  group: { rounds: 1, order: 'sequential', announceRoster: true },
}

export const MAX_PANES = 6

export type Placement = 'replace' | 'split' | 'none'

interface PersistedState {
  sessions: Record<string, Session>
  providers: ProviderConfig[]
  settings: Settings
  panes: string[]
  focusedPane: string | null
  sidebarOpen: boolean
}

export interface AppState extends PersistedState {
  hydrated: boolean
  /** Provider id -> origin its saved key is locked to. Not persisted. */
  savedKeys: Record<string, string>
  running: Record<string, boolean>
  /** Panes left out of the next broadcast. */
  excludedTargets: Record<string, boolean>
  settingsOpen: boolean
  settingsTab: SettingsTab
  /** Provider to select when Settings opens on the Providers tab. */
  settingsProviderId: string | null
  compareBroadcastId: string | null
  newCompareOpen: boolean
  /** Sign in with ChatGPT accounts by provider id (desktop only). Not persisted. */
  chatgptAccounts: Record<string, ChatGPTAccount>
  chatgptWelcomeOpen: boolean

  finishHydration(): Promise<void>
  refreshKeys(): Promise<void>
  refreshChatGPT(): Promise<void>
  setChatGPTWelcomeOpen(open: boolean): void

  createSession(options: { kind: SessionKind; models?: ModelRef[]; placement?: Placement }): string
  updateSession(id: string, patch: Partial<Session>): void
  deleteSession(id: string): void
  renameSession(id: string, title: string): void
  setChatModel(sessionId: string, ref: ModelRef): void
  addParticipant(sessionId: string, ref: ModelRef): void
  updateParticipant(sessionId: string, participantId: string, patch: Partial<Participant>): void
  removeParticipant(sessionId: string, participantId: string): void

  addMessage(sessionId: string, message: Message): void
  patchMessage(sessionId: string, messageId: string, patch: Partial<Message> | ((m: Message) => Partial<Message>)): void
  appendToMessage(sessionId: string, messageId: string, text: string, reasoning: string, transform?: (s: string) => string): void
  truncateFrom(sessionId: string, messageId: string): void
  autoTitle(sessionId: string, text: string, prefix?: string): void

  openSession(id: string, placement: Placement): void
  setPanes(ids: string[]): void
  closePane(id: string): void
  focusPane(id: string): void
  toggleTarget(id: string): void
  setRunning(id: string, running: boolean): void

  addProvider(presetId: string): string
  updateProvider(id: string, patch: Partial<ProviderConfig>): void
  removeProvider(id: string): void
  setProviderModels(id: string, models: ModelInfo[]): void

  updateSettings(patch: Partial<Settings>): void
  updateFeatures(patch: Partial<FeatureFlags>): void
  updateGroupSettings(patch: Partial<GroupSettings>): void
  resetSettings(): void

  openSettings(tab?: SettingsTab, providerId?: string): void
  closeSettings(): void
  openCompare(broadcastId: string): void
  closeCompare(): void
  setNewCompareOpen(open: boolean): void
  toggleSidebar(): void

  importSessions(sessions: Session[], providers?: ProviderConfig[]): number
  deleteAllSessions(): void
}

// ---------------------------------------------------------------------------
// Selectors and helpers (usable outside React)
// ---------------------------------------------------------------------------

export type ReadinessState = Pick<AppState, 'savedKeys' | 'settings' | 'chatgptAccounts'>

export function providerReady(state: ReadinessState, provider: ProviderConfig | undefined): boolean {
  return providerProblem(state, provider) === null
}

/** Why a provider cannot be used right now, or null when it can. */
export function providerProblem(state: ReadinessState, provider: ProviderConfig | undefined): string | null {
  if (!provider) return 'This model belongs to a provider that was removed. Pick another model.'
  if (!provider.enabled) return `${provider.name} is turned off in Settings → Providers.`
  if (provider.kind === 'demo') return state.settings.features.demoProvider ? null : 'The demo provider is turned off in Settings → Features.'
  if (provider.kind === 'chatgpt') {
    if (!isDesktop) return 'Signing in with ChatGPT needs the Parallax desktop app.'
    const account = state.chatgptAccounts[provider.id]
    if (!account?.signedIn) {
      return account?.needsSignIn
        ? 'Your ChatGPT sign-in has expired. Continue with ChatGPT in Settings → Providers.'
        : 'Sign in with ChatGPT in Settings → Providers to use your plan.'
    }
    if (!account.planEnabled) return "ChatGPT plan use isn't enabled for this sign-in. Enable it in Settings → Providers."
    return null
  }
  if (!provider.baseUrl) return `Set a base URL for ${provider.name} in Settings → Providers.`
  if (provider.requiresKey && !(provider.id in state.savedKeys)) return `Add an API key for ${provider.name} in Settings → Providers.`
  return null
}

export function findModel(provider: ProviderConfig | undefined, modelId: string): ModelInfo {
  return provider?.models.find((m) => m.id === modelId) ?? { id: modelId }
}

export function modelLabel(provider: ProviderConfig | undefined, modelId: string): string {
  return provider?.models.find((m) => m.id === modelId)?.label ?? modelId
}

export function effectiveFeatures(settings: Settings): FeatureFlags {
  const f = settings.features
  const broadcast = f.splitView && f.broadcast
  return { ...f, broadcast, compare: broadcast && f.compare }
}

/** Feature flags with their dependencies applied (broadcast needs split view, and so on). */
export function useFeatures(): FeatureFlags {
  const settings = useStore((s) => s.settings)
  return useMemo(() => effectiveFeatures(settings), [settings])
}

export function defaultModelRef(state: ReadinessState & Pick<AppState, 'providers'>): ModelRef | undefined {
  const wanted = state.settings.defaultModel
  if (wanted) {
    const provider = state.providers.find((p) => p.id === wanted.providerId)
    if (providerReady(state, provider)) return wanted
  }
  // Prefer a real provider over the demo one.
  const ready = state.providers.filter((p) => providerReady(state, p))
  const ordered = [...ready.filter((p) => p.kind !== 'demo'), ...ready.filter((p) => p.kind === 'demo')]
  for (const provider of ordered) {
    const model = provider.models.find((m) => !m.hidden)
    if (model) return { providerId: provider.id, modelId: model.id }
  }
  return undefined
}

function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`
    if (!taken.includes(candidate)) return candidate
  }
}

export function makeParticipant(providers: ProviderConfig[], ref: ModelRef, existing: Participant[]): Participant {
  const provider = providers.find((p) => p.id === ref.providerId)
  return {
    id: newId(),
    providerId: ref.providerId,
    modelId: ref.modelId,
    name: uniqueName(modelLabel(provider, ref.modelId), existing.map((p) => p.name)),
    color: colorFor(provider, ref.modelId, existing.map((p) => p.color)),
  }
}

const DATED_SNAPSHOT = /-(\d{4}-\d{2}-\d{2}|\d{8}|\d{4})$/

function mergeModels(current: ModelInfo[], fetched: ModelInfo[], hideSnapshots: boolean): ModelInfo[] {
  const previous = new Map(current.map((m) => [m.id, m]))
  const merged = fetched.map((m) => {
    const old = previous.get(m.id)
    // Dated snapshots start hidden to keep the picker short; aliases cover them.
    const hidden = old ? old.hidden : hideSnapshots && DATED_SNAPSHOT.test(m.id) && fetched.length > 8
    return { ...m, hidden }
  })
  const custom = current.filter((m) => m.custom && !fetched.some((f) => f.id === m.id))
  return [...merged, ...custom]
}

function isEmpty(session: Session | undefined): boolean {
  return !!session && session.messages.length === 0
}

function touch(session: Session, patch: Partial<Session>): Session {
  return { ...session, ...patch, updatedAt: Date.now() }
}

// ---------------------------------------------------------------------------
// Persistence: IndexedDB, written at most twice a second while streaming.
// ---------------------------------------------------------------------------

let pending: { name: string; value: StorageValue<PersistedState> } | null = null
let timer: ReturnType<typeof setTimeout> | null = null

export function flushPersist() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (!pending) return
  const { name, value } = pending
  pending = null
  idbSet(name, value).catch((err: unknown) => console.error('Could not save Parallax data', err))
}

const storage: PersistStorage<PersistedState> = {
  getItem: async (name) => (await idbGet<StorageValue<PersistedState>>(name)) ?? null,
  setItem: (name, value) => {
    pending = { name, value }
    if (!timer) timer = setTimeout(flushPersist, 500)
  },
  removeItem: (name) => idbDel(name),
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushPersist)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPersist()
  })
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function newSession(kind: SessionKind, participants: Participant[]): Session {
  const now = Date.now()
  return {
    id: newId(),
    title: kind === 'group' ? 'New group chat' : 'New chat',
    kind,
    participants,
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      sessions: {},
      providers: [],
      settings: DEFAULT_SETTINGS,
      panes: [],
      focusedPane: null,
      sidebarOpen: true,

      hydrated: false,
      savedKeys: {},
      running: {},
      excludedTargets: {},
      settingsOpen: false,
      settingsTab: 'providers',
      settingsProviderId: null,
      compareBroadcastId: null,
      newCompareOpen: false,
      chatgptAccounts: {},
      chatgptWelcomeOpen: false,

      async finishHydration() {
        const state = get()
        let providers = state.providers.length ? state.providers : defaultProviders()
        if (!providers.some((p) => p.id === DEMO_PROVIDER_ID)) providers = [...providers, demoProvider()]
        const settings: Settings = {
          ...DEFAULT_SETTINGS,
          ...state.settings,
          features: { ...DEFAULT_SETTINGS.features, ...state.settings.features },
          group: { ...DEFAULT_SETTINGS.group, ...state.settings.group },
        }
        // Installs from before Sign in with ChatGPT existed get its provider once.
        if (isDesktop && !settings.chatgptOffered) {
          const preset = PRESETS.find((p) => p.kind === 'chatgpt')
          if (preset && !providers.some((p) => p.kind === 'chatgpt')) {
            const provider = providerFromPreset(preset, providers.some((p) => p.id === preset.id) ? `${preset.id}-${newId().slice(0, 8)}` : preset.id)
            const after = providers.findIndex((p) => p.id === 'openai')
            providers = after >= 0 ? [...providers.slice(0, after + 1), provider, ...providers.slice(after + 1)] : [provider, ...providers]
          }
          settings.chatgptOffered = true
        }
        // Anything still "streaming" was interrupted when the app last closed.
        const sessions: Record<string, Session> = {}
        for (const session of Object.values(state.sessions)) {
          const interrupted = session.messages.some((m) => m.status === 'streaming')
          sessions[session.id] = interrupted
            ? {
                ...session,
                messages: session.messages.map((m) => (m.status === 'streaming' ? { ...m, status: 'stopped' } : m)),
              }
            : session
        }
        let panes = state.panes.filter((id) => sessions[id])
        if (!settings.features.splitView) panes = panes.slice(0, 1)
        // Drop empty chats nobody is looking at.
        for (const session of Object.values(sessions)) {
          if (isEmpty(session) && !panes.includes(session.id)) delete sessions[session.id]
        }
        set({ providers, settings, sessions, panes })
        // Keys and sign-ins decide which providers are usable, so load them before picking models.
        try {
          const [savedKeys, chatgptAccounts] = await Promise.all([listSavedKeys(), loadChatGPTAccounts()])
          set({ savedKeys, chatgptAccounts })
        } catch (err) {
          console.error('Could not read saved credentials', err)
        }
        if (panes.length === 0) get().createSession({ kind: 'chat', placement: 'replace' })
        else set({ focusedPane: state.focusedPane && panes.includes(state.focusedPane) ? state.focusedPane : panes[0] })
        set({ hydrated: true })
      },

      async refreshKeys() {
        try {
          set({ savedKeys: await listSavedKeys() })
        } catch (err) {
          console.error('Could not read saved API keys', err)
          return
        }
        adoptRealModel()
      },

      async refreshChatGPT() {
        try {
          set({ chatgptAccounts: await loadChatGPTAccounts() })
        } catch (err) {
          console.error('Could not read ChatGPT accounts', err)
          return
        }
        adoptRealModel()
      },

      setChatGPTWelcomeOpen(open) {
        set({ chatgptWelcomeOpen: open })
      },

      createSession({ kind, models, placement = 'replace' }) {
        const state = get()
        const refs = models ?? (kind === 'chat' ? [defaultModelRef(state)].filter((r): r is ModelRef => !!r) : [])
        const participants: Participant[] = []
        for (const ref of kind === 'chat' ? refs.slice(0, 1) : refs) {
          participants.push(makeParticipant(state.providers, ref, participants))
        }
        const session = newSession(kind, participants)
        set((s) => ({ sessions: { ...s.sessions, [session.id]: session } }))
        if (placement !== 'none') get().openSession(session.id, placement)
        return session.id
      },

      updateSession(id, patch) {
        set((s) => (s.sessions[id] ? { sessions: { ...s.sessions, [id]: touch(s.sessions[id], patch) } } : {}))
      },

      deleteSession(id) {
        set((s) => {
          const sessions = { ...s.sessions }
          delete sessions[id]
          const panes = s.panes.filter((p) => p !== id)
          return { sessions, panes, focusedPane: s.focusedPane === id ? (panes[0] ?? null) : s.focusedPane }
        })
        if (get().panes.length === 0) get().createSession({ kind: 'chat', placement: 'replace' })
      },

      renameSession(id, title) {
        const clean = title.trim()
        if (clean) get().updateSession(id, { title: clean, titleEdited: true })
      },

      setChatModel(sessionId, ref) {
        const state = get()
        const session = state.sessions[sessionId]
        if (!session) return
        const participant = makeParticipant(state.providers, ref, [])
        get().updateSession(sessionId, { participants: [participant] })
        // New chats start with the model picked most recently (demo models excepted).
        if (ref.providerId !== DEMO_PROVIDER_ID) set((s) => ({ settings: { ...s.settings, defaultModel: ref } }))
      },

      addParticipant(sessionId, ref) {
        const state = get()
        const session = state.sessions[sessionId]
        if (!session) return
        const participant = makeParticipant(state.providers, ref, session.participants)
        get().updateSession(sessionId, { participants: [...session.participants, participant] })
      },

      updateParticipant(sessionId, participantId, patch) {
        const session = get().sessions[sessionId]
        if (!session) return
        get().updateSession(sessionId, {
          participants: session.participants.map((p) => (p.id === participantId ? { ...p, ...patch } : p)),
        })
      },

      removeParticipant(sessionId, participantId) {
        const session = get().sessions[sessionId]
        if (!session) return
        get().updateSession(sessionId, { participants: session.participants.filter((p) => p.id !== participantId) })
      },

      addMessage(sessionId, message) {
        const session = get().sessions[sessionId]
        if (!session) return
        get().updateSession(sessionId, { messages: [...session.messages, message] })
      },

      patchMessage(sessionId, messageId, patch) {
        set((s) => {
          const session = s.sessions[sessionId]
          if (!session) return {}
          const messages = session.messages.map((m) =>
            m.id === messageId ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m,
          )
          return { sessions: { ...s.sessions, [sessionId]: { ...session, messages } } }
        })
      },

      appendToMessage(sessionId, messageId, text, reasoning, transform) {
        set((s) => {
          const session = s.sessions[sessionId]
          if (!session) return {}
          const messages = session.messages.map((m) => {
            if (m.id !== messageId) return m
            const content = m.content + text
            return {
              ...m,
              content: transform ? transform(content) : content,
              reasoning: reasoning ? (m.reasoning ?? '') + reasoning : m.reasoning,
            }
          })
          return { sessions: { ...s.sessions, [sessionId]: { ...session, messages } } }
        })
      },

      truncateFrom(sessionId, messageId) {
        const session = get().sessions[sessionId]
        if (!session) return
        const index = session.messages.findIndex((m) => m.id === messageId)
        if (index >= 0) get().updateSession(sessionId, { messages: session.messages.slice(0, index) })
      },

      autoTitle(sessionId, text, prefix) {
        const session = get().sessions[sessionId]
        if (!session || session.titleEdited || session.messages.filter((m) => m.role === 'user').length > 1) return
        get().updateSession(sessionId, { title: prefix ? `${prefix}: ${autoTitle(text)}` : autoTitle(text) })
      },

      openSession(id, placement) {
        const state = get()
        if (state.panes.includes(id)) {
          set({ focusedPane: id })
          return
        }
        const split = placement === 'split' && state.settings.features.splitView && state.panes.length < MAX_PANES
        if (split) {
          const at = state.focusedPane ? state.panes.indexOf(state.focusedPane) + 1 : state.panes.length
          const panes = [...state.panes]
          panes.splice(at, 0, id)
          set({ panes, focusedPane: id })
          return
        }
        const replaced = state.focusedPane ?? state.panes[0]
        const panes = replaced ? state.panes.map((p) => (p === replaced ? id : p)) : [id]
        set({ panes, focusedPane: id })
        // A chat that was never used disappears instead of cluttering the list.
        if (replaced && replaced !== id && isEmpty(state.sessions[replaced]) && !panes.includes(replaced)) {
          set((s) => {
            const sessions = { ...s.sessions }
            delete sessions[replaced]
            return { sessions }
          })
        }
      },

      setPanes(ids) {
        const state = get()
        const panes = ids.filter((id) => state.sessions[id]).slice(0, MAX_PANES)
        const dropped = state.panes.filter((id) => !panes.includes(id) && isEmpty(state.sessions[id]))
        const sessions = { ...state.sessions }
        for (const id of dropped) delete sessions[id]
        set({ panes, sessions, focusedPane: panes[0] ?? null, excludedTargets: {} })
      },

      closePane(id) {
        const state = get()
        if (state.panes.length <= 1) return
        const panes = state.panes.filter((p) => p !== id)
        const sessions = { ...state.sessions }
        if (isEmpty(sessions[id])) delete sessions[id]
        set({ panes, sessions, focusedPane: state.focusedPane === id ? panes[0] : state.focusedPane })
      },

      focusPane(id) {
        if (get().focusedPane !== id) set({ focusedPane: id })
      },

      toggleTarget(id) {
        set((s) => {
          const excludedTargets = { ...s.excludedTargets }
          if (excludedTargets[id]) delete excludedTargets[id]
          else excludedTargets[id] = true
          return { excludedTargets }
        })
      },

      setRunning(id, running) {
        set((s) => {
          const next = { ...s.running }
          if (running) next[id] = true
          else delete next[id]
          return { running: next }
        })
      },

      addProvider(presetId) {
        const preset = PRESETS.find((p) => p.id === presetId)
        if (!preset) throw new Error(`Unknown provider preset: ${presetId}`)
        const taken = new Set(get().providers.map((p) => p.id))
        const id = taken.has(preset.id) ? `${preset.id}-${newId().slice(0, 8)}` : preset.id
        const provider = providerFromPreset(preset, id)
        set((s) => ({ providers: [...s.providers.filter((p) => p.id !== DEMO_PROVIDER_ID), provider, ...s.providers.filter((p) => p.id === DEMO_PROVIDER_ID)] }))
        return id
      },

      updateProvider(id, patch) {
        set((s) => ({ providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))
      },

      removeProvider(id) {
        if (id === DEMO_PROVIDER_ID) return
        const provider = get().providers.find((p) => p.id === id)
        set((s) => {
          const savedKeys = { ...s.savedKeys }
          delete savedKeys[id]
          return { providers: s.providers.filter((p) => p.id !== id), savedKeys }
        })
        if (provider?.kind === 'chatgpt') {
          // Revokes the session with OpenAI and drops the registration.
          void bridge?.chatgpt
            .forget(id)
            .then(() => get().refreshChatGPT())
            .catch((err: unknown) => console.error('Could not sign out of ChatGPT', err))
        } else {
          void removeKey(id).catch((err: unknown) => console.error('Could not remove API key', err))
        }
      },

      setProviderModels(id, models) {
        set((s) => ({
          providers: s.providers.map((p) =>
            p.id === id ? { ...p, models: mergeModels(p.models, models, p.kind !== 'chatgpt') } : p,
          ),
        }))
        // A provider that just got its model list may be the first real one.
        adoptRealModel()
      },

      updateSettings(patch) {
        set((s) => ({ settings: { ...s.settings, ...patch } }))
      },

      updateFeatures(patch) {
        set((s) => {
          const features = { ...s.settings.features, ...patch }
          // Without split view only the focused pane stays open.
          const panes = features.splitView ? s.panes : s.panes.filter((p) => p === (s.focusedPane ?? s.panes[0])).slice(0, 1)
          return { settings: { ...s.settings, features }, panes }
        })
      },

      updateGroupSettings(patch) {
        set((s) => ({ settings: { ...s.settings, group: { ...s.settings.group, ...patch } } }))
      },

      resetSettings() {
        set({ settings: DEFAULT_SETTINGS })
      },

      openSettings(tab, providerId) {
        set((s) => ({ settingsOpen: true, settingsTab: tab ?? s.settingsTab, settingsProviderId: providerId ?? null }))
      },
      closeSettings() {
        set({ settingsOpen: false })
      },
      openCompare(broadcastId) {
        set({ compareBroadcastId: broadcastId })
      },
      closeCompare() {
        set({ compareBroadcastId: null })
      },
      setNewCompareOpen(open) {
        set({ newCompareOpen: open })
      },
      toggleSidebar() {
        set((s) => ({ sidebarOpen: !s.sidebarOpen }))
      },

      importSessions(sessions, providers) {
        let added = 0
        set((s) => {
          const next = { ...s.sessions }
          for (const session of sessions) {
            if (!session || typeof session.id !== 'string' || !Array.isArray(session.messages)) continue
            const id = next[session.id] ? newId() : session.id
            next[id] = { ...session, id }
            added++
          }
          const known = new Set(s.providers.map((p) => p.id))
          const extra = (providers ?? []).filter((p) => p && typeof p.id === 'string' && !known.has(p.id))
          return { sessions: next, providers: [...s.providers, ...extra] }
        })
        return added
      },

      deleteAllSessions() {
        set({ sessions: {}, panes: [], focusedPane: null, excludedTargets: {} })
        get().createSession({ kind: 'chat', placement: 'replace' })
      },
    }),
    {
      name: 'parallax-state',
      version: 1,
      storage,
      partialize: (s): PersistedState => ({
        sessions: s.sessions,
        providers: s.providers,
        settings: s.settings,
        panes: s.panes,
        focusedPane: s.focusedPane,
        sidebarOpen: s.sidebarOpen,
      }),
      onRehydrateStorage: () => (state, error) => {
        if (error) console.error('Could not load saved data', error)
        void (state ?? useStore.getState()).finishHydration()
      },
    },
  ),
)

async function loadChatGPTAccounts(): Promise<Record<string, ChatGPTAccount>> {
  if (!bridge) return {}
  const accounts = await bridge.chatgpt.accounts()
  return Object.fromEntries(accounts.map((a) => [a.providerId, a]))
}

/**
 * Unused chats that only had the demo model (or none) switch to a real model as
 * soon as one becomes available (after saving a key or signing in).
 */
function adoptRealModel() {
  const state = useStore.getState()
  const ref = defaultModelRef(state)
  if (!ref || ref.providerId === DEMO_PROVIDER_ID) return
  for (const id of state.panes) {
    const session = state.sessions[id]
    const placeholder = !session?.participants[0] || session.participants[0].providerId === DEMO_PROVIDER_ID
    if (session && session.kind === 'chat' && session.messages.length === 0 && placeholder) {
      state.setChatModel(id, ref)
    }
  }
}

/** Sessions and the providers they need, shaped for export (API keys are never included). */
export function exportSnapshot() {
  const s = useStore.getState()
  return {
    app: 'parallax',
    version: __APP_VERSION__,
    exportedAt: new Date().toISOString(),
    settings: s.settings,
    providers: s.providers,
    sessions: Object.values(s.sessions),
  }
}
