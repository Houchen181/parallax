import type { ModelInfo, ProviderConfig, ProviderKind } from '../types'

export interface ProviderPreset {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  requiresKey: boolean
  description: string
  keyUrl?: string
  /** Whether the provider accepts requests straight from a web page (CORS). */
  browserSupport: 'yes' | 'unknown' | 'no'
  defaults?: Partial<ProviderConfig>
  models?: ModelInfo[]
  /** Built-in presets are added on first run. */
  builtIn?: boolean
}

export const DEMO_PROVIDER_ID = 'demo'

const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', maxOutput: 128000, adaptiveThinking: true, effort: true },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', maxOutput: 128000, adaptiveThinking: true, effort: true },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', maxOutput: 64000, adaptiveThinking: false, effort: false },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', maxOutput: 128000, adaptiveThinking: true, effort: true },
]

export const PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    requiresKey: true,
    description: 'Claude models through the Anthropic API.',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    browserSupport: 'yes',
    defaults: { thinking: true, effort: '', refusalFallback: true },
    models: CLAUDE_MODELS,
    builtIn: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    description: 'GPT and o-series models through the OpenAI API.',
    keyUrl: 'https://platform.openai.com/api-keys',
    browserSupport: 'yes',
    defaults: {
      includeUsage: true,
      maxTokensParam: 'none',
      modelFilter: '^(?!.*(audio|realtime|transcribe|tts|image|embedding|moderation|search|instruct|codex))(gpt-|o\\d|chatgpt-)',
    },
    builtIn: true,
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresKey: true,
    description: "Gemini models through Google's OpenAI-compatible endpoint.",
    keyUrl: 'https://aistudio.google.com/apikey',
    browserSupport: 'unknown',
    defaults: { includeUsage: true, maxTokensParam: 'none', modelFilter: '^(?!.*(embedding|tts|image|aqa|imagen|veo))gemini' },
    builtIn: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    description: 'Hundreds of models from many labs with a single key.',
    keyUrl: 'https://openrouter.ai/keys',
    browserSupport: 'yes',
    defaults: { includeUsage: true, maxTokensParam: 'none' },
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    requiresKey: true,
    description: 'Very fast inference for open-weight models.',
    keyUrl: 'https://console.groq.com/keys',
    browserSupport: 'unknown',
    defaults: { includeUsage: true, maxTokensParam: 'none' },
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    requiresKey: true,
    description: 'DeepSeek chat and reasoning models.',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    browserSupport: 'unknown',
    defaults: { includeUsage: true, maxTokensParam: 'none' },
  },
  {
    id: 'mistral',
    name: 'Mistral',
    kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    requiresKey: true,
    description: 'Mistral and Codestral models.',
    keyUrl: 'https://console.mistral.ai/api-keys',
    browserSupport: 'unknown',
    defaults: { includeUsage: false, maxTokensParam: 'none' },
  },
  {
    id: 'xai',
    name: 'xAI',
    kind: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    requiresKey: true,
    description: 'Grok models.',
    keyUrl: 'https://console.x.ai',
    browserSupport: 'unknown',
    defaults: { includeUsage: true, maxTokensParam: 'none' },
  },
  {
    id: 'together',
    name: 'Together AI',
    kind: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    requiresKey: true,
    description: 'Open-weight models hosted by Together.',
    keyUrl: 'https://api.together.ai/settings/api-keys',
    browserSupport: 'unknown',
    defaults: { includeUsage: false, maxTokensParam: 'none' },
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    requiresKey: false,
    description: 'Models running on this computer with Ollama.',
    browserSupport: 'no',
    defaults: { includeUsage: false, maxTokensParam: 'none' },
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    requiresKey: false,
    description: "Models served by LM Studio's local server.",
    browserSupport: 'no',
    defaults: { includeUsage: false, maxTokensParam: 'none' },
  },
  {
    id: 'custom-openai',
    name: 'Custom (OpenAI-compatible)',
    kind: 'openai',
    baseUrl: '',
    requiresKey: true,
    description: 'Any server that speaks the OpenAI chat completions API.',
    browserSupport: 'unknown',
    defaults: { includeUsage: false, maxTokensParam: 'none' },
  },
  {
    id: 'custom-anthropic',
    name: 'Custom (Anthropic-compatible)',
    kind: 'anthropic',
    baseUrl: '',
    requiresKey: true,
    description: 'A proxy or gateway that speaks the Anthropic Messages API.',
    browserSupport: 'unknown',
    defaults: { thinking: true, effort: '', refusalFallback: false },
  },
]

export const DEMO_MODELS: ModelInfo[] = [
  { id: 'demo-concise', label: 'Demo · Concise' },
  { id: 'demo-thorough', label: 'Demo · Thorough' },
  { id: 'demo-skeptic', label: 'Demo · Skeptic' },
]

export function demoProvider(): ProviderConfig {
  return {
    id: DEMO_PROVIDER_ID,
    name: 'Demo (simulated)',
    kind: 'demo',
    baseUrl: '',
    enabled: true,
    requiresKey: false,
    models: DEMO_MODELS,
    presetId: 'demo',
  }
}

export function providerFromPreset(preset: ProviderPreset, id: string): ProviderConfig {
  return {
    id,
    name: preset.name,
    kind: preset.kind,
    baseUrl: preset.baseUrl,
    enabled: true,
    requiresKey: preset.requiresKey,
    models: preset.models ? preset.models.map((m) => ({ ...m })) : [],
    presetId: preset.id,
    ...preset.defaults,
  }
}

export function defaultProviders(): ProviderConfig[] {
  return PRESETS.filter((p) => p.builtIn).map((p) => providerFromPreset(p, p.id))
}

export function presetFor(provider: ProviderConfig): ProviderPreset | undefined {
  return PRESETS.find((p) => p.id === provider.presetId)
}

/** Colors that make each provider recognizable in mixed views. */
const PROVIDER_COLORS: Record<string, string> = {
  anthropic: '#d97757',
  openai: '#10a37f',
  gemini: '#4285f4',
  openrouter: '#7c5cff',
  groq: '#f55036',
  deepseek: '#4d6bfe',
  mistral: '#fa520f',
  xai: '#9ca3af',
  together: '#0f6fff',
  ollama: '#a3a3a3',
  lmstudio: '#6366f1',
}

const DEMO_COLORS: Record<string, string> = {
  'demo-concise': '#14b8a6',
  'demo-thorough': '#8b5cf6',
  'demo-skeptic': '#f59e0b',
}

export const PALETTE = ['#d97757', '#10a37f', '#4285f4', '#8b5cf6', '#f59e0b', '#ec4899', '#14b8a6', '#ef4444', '#6366f1']

export function colorFor(provider: ProviderConfig | undefined, modelId: string, taken: string[] = []): string {
  const preferred = DEMO_COLORS[modelId] ?? (provider?.presetId ? PROVIDER_COLORS[provider.presetId] : undefined)
  if (preferred && !taken.includes(preferred)) return preferred
  return PALETTE.find((c) => !taken.includes(c)) ?? preferred ?? PALETTE[taken.length % PALETTE.length]
}
