// Which providers the plugin can use, where each one's API key comes from, and
// how a model reference such as "anthropic:claude-opus-5-5" maps onto them.
//
// Keys come from, in order:
//   1. the plugin's own settings, which hosts pass as PARALLAX_<PROVIDER>_API_KEY
//   2. the key page (configure_keys), stored in the folder the local web version
//      of Parallax uses, so keys saved in either one work in both
//   3. the provider's usual environment variable, e.g. OPENAI_API_KEY
// A key is only ever sent to the origin it belongs to.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { KeyStore } from '../main/backend'
import { plainSeal } from '../server/system'
import { setTransport } from '../renderer/src/lib/http'
import { anthropicAdapter } from '../renderer/src/lib/providers/anthropic'
import { demoAdapter } from '../renderer/src/lib/providers/demo'
import { openaiAdapter } from '../renderer/src/lib/providers/openai'
import { DEMO_MODELS, PRESETS, demoProvider, providerFromPreset, type ProviderPreset } from '../renderer/src/lib/providers/presets'
import { ProviderError, type ProviderAdapter } from '../renderer/src/lib/providers/types'
import type { ModelInfo, ProviderConfig, ProviderKind } from '../renderer/src/lib/types'

/** Sign in with ChatGPT stays in the app: its rotating tokens can't be shared between processes. */
export const PROVIDERS: ProviderPreset[] = PRESETS.filter((p) => p.kind !== 'chatgpt')

const STANDARD_KEY_VARS: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  groq: ['GROQ_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  xai: ['XAI_API_KEY'],
  together: ['TOGETHER_API_KEY'],
}

// The official SDKs pair these with the key variables above.
const STANDARD_BASE_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_BASE_URL',
  openai: 'OPENAI_BASE_URL',
}

const ALIASES: Record<string, string> = {
  claude: 'anthropic',
  google: 'gemini',
  grok: 'xai',
  custom: 'custom-openai',
  'lm-studio': 'lmstudio',
}

// Bare model ids that clearly belong to one provider.
const INFERRED: Array<[RegExp, string]> = [
  [/^claude-/i, 'anthropic'],
  [/^(gpt-|chatgpt-|o\d)/i, 'openai'],
  [/^gemini-/i, 'gemini'],
  [/^grok-/i, 'xai'],
  [/^deepseek-/i, 'deepseek'],
  [/^(mistral|magistral|ministral|codestral|devstral|pixtral)/i, 'mistral'],
  [/^demo-/i, 'demo'],
  [/\//, 'openrouter'],
]

const MODEL_CACHE_MS = 10 * 60_000
const LOCAL_PROBE_MS = 2500

export function envName(providerId: string, suffix: string): string {
  return `PARALLAX_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${suffix}`
}

/** A set value, ignoring blanks and placeholders a host left unexpanded (e.g. "${user_config.key}"). */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value && !/^\$\{[^}]*\}$/.test(value) ? value : undefined
}

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : undefined
  } catch {
    return undefined
  }
}

export type KeySource = 'plugin' | 'saved' | 'env'

export interface ProviderState {
  id: string
  preset: ProviderPreset
  /** Ready-to-use config with the effective base URL. */
  config: ProviderConfig
  key?: { value: string; origin: string; source: KeySource; from: string }
  /** Set when the provider can't be used, e.g. "no API key". */
  problem?: string
  /** Needs no key: Ollama, LM Studio, or a custom server set up without one. */
  keyless: boolean
}

export interface ResolvedModel {
  /** Canonical "provider:model" reference. */
  ref: string
  provider: ProviderState
  model: ModelInfo
  label: string
}

export interface ModelListing {
  models?: ModelInfo[]
  error?: string
}

type ProviderSettings = Record<string, { baseUrl?: string }>

export function adapterFor(kind: ProviderKind): ProviderAdapter {
  if (kind === 'anthropic') return anthropicAdapter
  if (kind === 'demo') return demoAdapter
  return openaiAdapter
}

export class Registry {
  readonly keys: KeyStore
  private readonly env: NodeJS.ProcessEnv
  private readonly settingsFile: string
  private settings: ProviderSettings = {}
  private states = new Map<string, ProviderState>()
  private cache = new Map<string, { at: number; fingerprint: string; models: ModelInfo[] }>()
  private settingsWrites: Promise<void> = Promise.resolve()
  readonly demo: ProviderState = {
    id: 'demo',
    preset: { id: 'demo', name: 'Demo (simulated)', kind: 'demo', baseUrl: '', requiresKey: false, description: '', browserSupport: 'yes' },
    config: demoProvider(),
    keyless: false,
  }

  constructor(options: { env: NodeJS.ProcessEnv; dataDir: string }) {
    this.env = options.env
    this.keys = new KeyStore(join(options.dataDir, 'api-keys.json'), plainSeal.seal, plainSeal.unseal)
    this.settingsFile = join(options.dataDir, 'providers.json')
  }

  /** Re-reads saved keys and settings, so changes from the key page or the web version apply at once. */
  async refresh(): Promise<void> {
    await this.keys.refresh()
    try {
      this.settings = JSON.parse(await readFile(this.settingsFile, 'utf8')) as ProviderSettings
    } catch {
      this.settings = {}
    }
    this.states = new Map(PROVIDERS.map((preset) => [preset.id, this.resolve(preset)]))
  }

  /** Saves a custom provider's base URL (the key page's only non-key setting). */
  saveBaseUrl(providerId: string, baseUrl: string): Promise<void> {
    this.settingsWrites = this.settingsWrites
      .catch(() => undefined)
      .then(async () => {
        let current: ProviderSettings = {}
        try {
          current = JSON.parse(await readFile(this.settingsFile, 'utf8')) as ProviderSettings
        } catch {
          // First setting.
        }
        current[providerId] = { ...current[providerId], baseUrl }
        const tmp = `${this.settingsFile}.${process.pid}.tmp`
        await mkdir(join(this.settingsFile, '..'), { recursive: true })
        await writeFile(tmp, JSON.stringify(current, null, 2), { mode: 0o600 })
        await rename(tmp, this.settingsFile)
      })
    return this.settingsWrites
  }

  all(): ProviderState[] {
    return [...this.states.values()]
  }

  get(providerId: string): ProviderState | undefined {
    if (providerId === 'demo') return this.demo
    return this.states.get(ALIASES[providerId] ?? providerId)
  }

  /** The base URL a provider uses when no key overrides it (env setting, saved setting, preset). */
  baseUrlFor(preset: ProviderPreset): string {
    return envValue(this.env, envName(preset.id, 'BASE_URL')) ?? this.settings[preset.id]?.baseUrl ?? preset.baseUrl
  }

  private resolve(preset: ProviderPreset): ProviderState {
    const id = preset.id
    const config = providerFromPreset(preset, id)
    config.baseUrl = this.baseUrlFor(preset)
    // A gateway or proxy in place of the provider's own API may name models differently.
    if (config.baseUrl !== preset.baseUrl) config.modelFilter = undefined
    const state: ProviderState = { id, preset, config, keyless: false }
    const base = originOf(config.baseUrl)
    const withKey = (value: string, origin: string, source: KeySource, from: string): ProviderState => ({
      ...state,
      config: { ...state.config, requiresKey: true },
      key: { value, origin, source, from },
    })

    const pluginVar = envName(id, 'API_KEY')
    const pluginKey = envValue(this.env, pluginVar)
    if (pluginKey && base) return withKey(pluginKey, base, 'plugin', pluginVar)

    let mismatch: string | undefined
    const saved = this.keys.saved(id)
    if (saved && base) {
      if (saved.origin === base) return withKey(saved.key, base, 'saved', 'the Parallax key page')
      mismatch = `the saved key is for ${saved.origin}, not ${base}`
    }

    for (const name of STANDARD_KEY_VARS[id] ?? []) {
      const value = envValue(this.env, name)
      if (!value) continue
      const standardBase = STANDARD_BASE_VARS[id] ? envValue(this.env, STANDARD_BASE_VARS[id]) : undefined
      const url = standardBase ?? config.baseUrl
      const origin = originOf(url)
      if (!origin) continue
      const modelFilter = url === preset.baseUrl ? config.modelFilter : undefined
      return { ...withKey(value, origin, 'env', name), config: { ...config, baseUrl: url, requiresKey: true, modelFilter } }
    }

    if (!config.baseUrl) return { ...state, problem: 'needs a base URL' }
    if (!base) return { ...state, problem: `has an invalid base URL (${config.baseUrl})` }
    // Local servers need no key, and neither does a custom server set up without one.
    if (!preset.requiresKey || (id.startsWith('custom-') && config.baseUrl !== preset.baseUrl)) {
      return { ...state, config: { ...config, requiresKey: false }, keyless: true }
    }
    return { ...state, problem: mismatch ?? 'no API key' }
  }

  ready(): ProviderState[] {
    return this.all().filter((p) => !p.problem)
  }

  /** The key to attach to a request, refusing any origin the key wasn't set up for. */
  keyFor(providerId: string, url: string): string {
    const state = this.get(providerId)
    const name = state?.preset.name ?? providerId
    if (!state?.key) throw new ProviderError(`${name} has no API key. Add one with the configure_keys tool.`)
    if (originOf(url) !== state.key.origin) throw new ProviderError(`The ${name} key is only sent to ${state.key.origin}.`)
    return state.key.value
  }

  /** Model list for a provider: fetched from the provider, cached for ten minutes. */
  async models(state: ProviderState, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<ModelListing> {
    if (state.id === 'demo') return { models: DEMO_MODELS.map((m) => ({ ...m })) }
    if (state.problem) return { error: state.problem }
    const fingerprint = `${state.config.baseUrl}|${state.key ? createHash('sha256').update(state.key.value).digest('hex') : ''}`
    const cached = this.cache.get(state.id)
    if (!options.refresh && cached && cached.fingerprint === fingerprint && Date.now() - cached.at < MODEL_CACHE_MS) {
      return { models: cached.models }
    }
    const signals = [options.signal, state.keyless ? AbortSignal.timeout(LOCAL_PROBE_MS) : undefined].filter(
      (s): s is AbortSignal => s !== undefined,
    )
    try {
      const models = await adapterFor(state.config.kind).listModels(state.config, signals.length ? AbortSignal.any(signals) : undefined)
      this.cache.set(state.id, { at: Date.now(), fingerprint, models })
      return { models }
    } catch (err) {
      if (state.keyless) return { error: `not running at ${state.config.baseUrl}` }
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Looks up "provider:model" (or a bare model id whose provider is obvious). */
  resolveModel(reference: string): ResolvedModel | { error: string } {
    const text = reference.trim()
    if (!text) return { error: 'An empty model name was given.' }
    let state: ProviderState | undefined
    let modelId = text
    const colon = text.indexOf(':')
    if (colon > 0) {
      const prefix = text.slice(0, colon).toLowerCase()
      const found = this.get(prefix)
      if (found) {
        state = found
        modelId = text.slice(colon + 1).trim()
      }
    }
    if (!state && /^chatgpt:/i.test(text)) {
      return {
        error:
          'The ChatGPT plan only works in the Parallax app (its sign-in can\'t be shared with plugins). Use an OpenAI API key instead, e.g. "openai:gpt-5".',
      }
    }
    if (!state) {
      const inferred = INFERRED.find(([pattern]) => pattern.test(modelId))?.[1]
      if (!inferred) {
        return {
          error: `Can't tell which provider serves "${text}". Write it as provider:model, e.g. "openrouter:${text}". Call list_models to see what's available.`,
        }
      }
      state = this.get(inferred)!
    }
    if (!modelId) return { error: `"${text}" names a provider but no model.` }
    if (state.problem) {
      return { error: `${state.preset.name} (${state.id}) ${state.problem}, so "${text}" can't be used. Call configure_keys to set it up.` }
    }
    const known =
      this.cache.get(state.id)?.models.find((m) => m.id === modelId) ??
      state.preset.models?.find((m) => m.id === modelId) ??
      (state.id === 'demo' ? DEMO_MODELS.find((m) => m.id === modelId) : undefined)
    const model: ModelInfo = known ? { ...known } : { id: modelId }
    return { ref: `${state.id}:${modelId}`, provider: state, model, label: model.label ?? modelId }
  }

  /** Routes the shared provider adapters' requests through this registry's keys. */
  installTransport(fetchImpl: typeof fetch = fetch) {
    setTransport(async (url, options) => {
      const headers = { ...options.headers }
      if (options.auth) headers[options.auth.header.toLowerCase()] = (options.auth.prefix ?? '') + this.keyFor(options.auth.providerId, url)
      return fetchImpl(url, { method: options.method ?? 'GET', headers, body: options.body, signal: options.signal })
    })
  }
}
