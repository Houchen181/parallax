// Chat Completions over raw HTTP. One adapter covers OpenAI and every server
// that implements the same API (Gemini's compatibility endpoint, OpenRouter,
// Groq, DeepSeek, Mistral, Ollama, LM Studio, vLLM, ...).
import type { AuthSpec } from '../../../../shared/bridge'
import { abortError, describeHttpError, httpFetch, isAbortError } from '../http'
import { runtime } from '../platform'
import { parseSSE, textChunks } from '../sse'
import type { ModelInfo, ProviderConfig } from '../types'
import { ProviderError, type ChatRequest, type ChatResult, type ProviderAdapter, type StreamHandlers } from './types'

function endpoint(provider: ProviderConfig, path: string): string {
  if (!provider.baseUrl) throw new ProviderError(`Set a base URL for ${provider.name} in Settings → Providers.`)
  return provider.baseUrl.replace(/\/+$/, '') + path
}

function auth(provider: ProviderConfig): AuthSpec | undefined {
  return provider.requiresKey ? { providerId: provider.id, header: 'authorization', prefix: 'Bearer ' } : undefined
}

interface StreamChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
  error?: { message?: string } | string
}

function connectionError(provider: ProviderConfig, err: unknown): ProviderError {
  const reason = err instanceof Error ? err.message : String(err)
  const hint =
    runtime === 'web' && typeof window !== 'undefined'
      ? ' The provider may not allow requests from a web page; the desktop app does not have this limit.'
      : ''
  return new ProviderError(`Could not reach ${provider.baseUrl}: ${reason}.${hint}`)
}

export const openaiAdapter: ProviderAdapter = {
  async stream(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResult> {
    const { provider, model } = request
    const messages = [
      ...(request.system ? [{ role: 'system', content: request.system }] : []),
      ...request.messages.map((m) => ({ role: m.role, content: m.content })),
    ]
    const body: Record<string, unknown> = { model: model.id, messages, stream: true }
    if (request.temperature != null) body.temperature = request.temperature
    const tokensParam = provider.maxTokensParam ?? 'none'
    if (tokensParam !== 'none') body[tokensParam] = request.maxOutputTokens
    if (provider.includeUsage) body.stream_options = { include_usage: true }

    let response: Response
    try {
      response = await httpFetch(endpoint(provider, '/chat/completions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
        auth: auth(provider),
        signal: request.signal,
      })
    } catch (err) {
      if (isAbortError(err)) throw abortError()
      if (err instanceof ProviderError) throw err
      throw connectionError(provider, err)
    }
    if (!response.ok) throw new ProviderError(await describeHttpError(response), response.status)
    if (!response.body) throw new ProviderError(`${provider.name} returned an empty response.`)

    const result: ChatResult = {}
    try {
      for await (const event of parseSSE(textChunks(response.body))) {
        if (event.data === '[DONE]') break
        let chunk: StreamChunk
        try {
          chunk = JSON.parse(event.data) as StreamChunk
        } catch {
          continue
        }
        if (chunk.error) {
          const message = typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'Unknown error')
          throw new ProviderError(`${provider.name}: ${message}`)
        }
        const choice = chunk.choices?.[0]
        const delta = choice?.delta
        if (delta) {
          if (delta.content) handlers.onText(delta.content)
          const reasoning = delta.reasoning_content ?? delta.reasoning
          if (reasoning) handlers.onReasoning(reasoning)
        }
        if (choice?.finish_reason) result.stopReason = choice.finish_reason
        if (chunk.usage) {
          result.inputTokens = chunk.usage.prompt_tokens
          result.outputTokens = chunk.usage.completion_tokens
        }
      }
    } catch (err) {
      if (isAbortError(err) || request.signal.aborted) throw abortError()
      throw err
    }
    if (result.stopReason === 'length') result.notice = 'The reply reached the output token limit.'
    if (result.stopReason === 'content_filter') result.notice = 'The provider filtered part of this reply.'
    return result
  },

  async listModels(provider: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]> {
    let response: Response
    try {
      response = await httpFetch(endpoint(provider, '/models'), {
        headers: { accept: 'application/json' },
        auth: auth(provider),
        signal,
      })
    } catch (err) {
      if (isAbortError(err)) throw abortError()
      if (err instanceof ProviderError) throw err
      throw connectionError(provider, err)
    }
    if (!response.ok) throw new ProviderError(await describeHttpError(response), response.status)
    const json = (await response.json()) as unknown
    const record = json as { data?: unknown; models?: unknown }
    const items = (Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : Array.isArray(json) ? json : []) as Array<Record<string, unknown>>
    const filter = provider.modelFilter ? new RegExp(provider.modelFilter, 'i') : null
    const seen = new Set<string>()
    const models: ModelInfo[] = []
    for (const item of items) {
      const rawId = String(item.id ?? item.name ?? '')
      const id = rawId.replace(/^models\//, '')
      if (!id || seen.has(id) || (filter && !filter.test(id))) continue
      seen.add(id)
      const name = typeof item.name === 'string' && item.name !== rawId ? item.name : undefined
      const display = typeof item.display_name === 'string' ? item.display_name : name
      models.push({ id, label: display })
    }
    return models.sort((a, b) => a.id.localeCompare(b.id))
  },
}
