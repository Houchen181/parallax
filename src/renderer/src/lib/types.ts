/** chatgpt = Sign in with ChatGPT (the user's ChatGPT plan pays, through the Responses API). */
export type ProviderKind = 'anthropic' | 'openai' | 'chatgpt' | 'demo'

export interface ModelInfo {
  id: string
  label?: string
  /** Hidden models stay configured but are left out of the model picker. */
  hidden?: boolean
  /** Added by hand rather than fetched from the provider. */
  custom?: boolean
  maxOutput?: number
  contextWindow?: number
  /** Anthropic capability flags reported by the Models API. */
  adaptiveThinking?: boolean
  effort?: boolean
}

export type Effort = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type MaxTokensParam = 'none' | 'max_tokens' | 'max_completion_tokens'

export interface ProviderConfig {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  enabled: boolean
  requiresKey: boolean
  models: ModelInfo[]
  presetId?: string
  /** OpenAI-compatible: which field carries the output token limit. */
  maxTokensParam?: MaxTokensParam
  /** OpenAI-compatible: ask for token usage at the end of the stream. */
  includeUsage?: boolean
  /** Regex applied to fetched model ids. */
  modelFilter?: string
  /** Anthropic and ChatGPT plan: show summarized reasoning for models that support it. */
  thinking?: boolean
  /** Anthropic: output_config.effort, '' means the model default. */
  effort?: Effort
  /** Anthropic: let the API retry on a fallback model when a request is declined. */
  refusalFallback?: boolean
}

export interface ModelRef {
  providerId: string
  modelId: string
}

export interface Participant {
  id: string
  providerId: string
  modelId: string
  name: string
  color: string
  /** Extra instructions for this participant only (a persona). */
  systemPrompt?: string
  muted?: boolean
}

export type MessageStatus = 'streaming' | 'done' | 'error' | 'stopped' | 'refused'

export interface MessageMetrics {
  firstTokenMs?: number
  totalMs?: number
  inputTokens?: number
  outputTokens?: number
  /** Set when a different model produced the answer (refusal fallback). */
  servedBy?: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  participantId?: string
  /** Snapshot of the model that wrote an assistant message. */
  model?: ModelRef & { label: string }
  status?: MessageStatus
  error?: string
  /** Machine-readable error, e.g. a ChatGPT usage limit, used to offer the right fix. */
  errorCode?: string
  /** Informational note shown under the message (truncation, fallback...). */
  notice?: string
  reasoning?: string
  metrics?: MessageMetrics
  /** A broadcast prompt and every reply to it share this id across sessions. */
  broadcastId?: string
  starred?: boolean
}

export type SessionKind = 'chat' | 'group'
export type SpeakingOrder = 'sequential' | 'random'

export interface Session {
  id: string
  title: string
  kind: SessionKind
  participants: Participant[]
  messages: Message[]
  systemPrompt?: string
  createdAt: number
  updatedAt: number
  pinned?: boolean
  titleEdited?: boolean
  /** Group chats: overrides for the global group settings. */
  rounds?: number
  order?: SpeakingOrder
}

export type Theme = 'system' | 'light' | 'dark'

export interface FeatureFlags {
  /** Show several sessions side by side. */
  splitView: boolean
  /** Send one prompt to every selected pane. */
  broadcast: boolean
  /** Side-by-side comparison of the replies to a broadcast. */
  compare: boolean
  /** Sessions with several models talking to each other. */
  groupChat: boolean
  /** Simulated models that need no API key. */
  demoProvider: boolean
}

export interface GroupSettings {
  /** How many times each model speaks after a user message. */
  rounds: number
  order: SpeakingOrder
  /** Tell each model who else is in the room. */
  announceRoster: boolean
}

export interface Settings {
  theme: Theme
  sendOnEnter: boolean
  showMetrics: boolean
  defaultModel?: ModelRef
  defaultSystemPrompt: string
  /** null leaves sampling to the provider. */
  temperature: number | null
  maxOutputTokens: number
  features: FeatureFlags
  group: GroupSettings
  /** The one-time "You're using your ChatGPT plan" message was dismissed. */
  chatgptWelcomeSeen?: boolean
  /** The ChatGPT plan provider was added once for existing installs. */
  chatgptOffered?: boolean
}

export type SettingsTab = 'providers' | 'features' | 'group' | 'general' | 'data' | 'about'
