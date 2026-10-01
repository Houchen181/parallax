import type { ModelInfo, ProviderConfig } from '../types'

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  provider: ProviderConfig
  model: ModelInfo
  system?: string
  messages: ChatTurn[]
  temperature: number | null
  maxOutputTokens: number
  signal: AbortSignal
}

export interface StreamHandlers {
  onText(delta: string): void
  onReasoning(delta: string): void
}

export interface ChatResult {
  stopReason?: string
  inputTokens?: number
  outputTokens?: number
  /** Model that actually answered, when it differs from the requested one. */
  servedBy?: string
  /** Set when the model or its safety system declined to answer. */
  refusal?: { category?: string | null; explanation?: string | null }
  notice?: string
}

export interface ProviderAdapter {
  stream(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResult>
  listModels(provider: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]>
}

export class ProviderError extends Error {
  readonly status?: number
  readonly code?: string

  constructor(message: string, status?: number, code?: string) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
    this.code = code
  }
}
