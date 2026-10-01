import Anthropic from '@anthropic-ai/sdk'
import type { AuthSpec } from '../../../../shared/bridge'
import { abortError, fetchWithAuth, isAbortError } from '../http'
import type { Effort, ModelInfo, ProviderConfig } from '../types'
import { ProviderError, type ChatRequest, type ChatResult, type ProviderAdapter, type StreamHandlers } from './types'

// The transport attaches the real key (the main process does it on the desktop),
// so the SDK client only ever holds this placeholder.
const KEY_PLACEHOLDER = 'parallax-managed-key'
const FIRST_PARTY_API = 'https://api.anthropic.com'
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

type BetaStreamParams = Parameters<Anthropic['beta']['messages']['stream']>[0]

// Used when the Models API did not report capabilities (e.g. a model id typed by hand).
const ADAPTIVE_FAMILIES = /^claude-(fable|mythos|opus-5|sonnet-5|opus-4-[678]|sonnet-4-6)/
// These still accept `temperature`; newer models reject sampling parameters.
const SAMPLING_FAMILIES = /^claude-(haiku-4-5|sonnet-4-6|opus-4-6|sonnet-4-5|opus-4-5|opus-4-1|opus-4-0|sonnet-4-0|opus-4-2|sonnet-4-2|3)/
// Models that accept `fallbacks: "default"` (server-side retry after a policy decline).
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])

function createClient(provider: ProviderConfig): Anthropic {
  const auth: AuthSpec | undefined = provider.requiresKey ? { providerId: provider.id, header: 'x-api-key' } : undefined
  return new Anthropic({
    apiKey: KEY_PLACEHOLDER,
    baseURL: provider.baseUrl.replace(/\/+$/, ''),
    dangerouslyAllowBrowser: true,
    fetch: fetchWithAuth(auth),
    maxRetries: 2,
  })
}

function capabilities(model: ModelInfo) {
  const adaptive = model.adaptiveThinking ?? ADAPTIVE_FAMILIES.test(model.id)
  const isFourSix = /-4-6/.test(model.id)
  return {
    adaptive,
    // Thinking text is omitted by default on everything after the 4.6 family.
    summaryOptIn: adaptive && !isFourSix,
    effort: model.effort ?? adaptive,
    noXhigh: isFourSix,
    sampling: SAMPLING_FAMILIES.test(model.id),
    fallback: FALLBACK_MODELS.has(model.id),
  }
}

function effortFor(model: ModelInfo, effort: Effort | undefined): Anthropic.OutputConfig['effort'] | undefined {
  const caps = capabilities(model)
  if (!effort || !caps.effort) return undefined
  return effort === 'xhigh' && caps.noXhigh ? 'high' : effort
}

type SharedParams = Omit<Anthropic.MessageStreamParams, 'output_config'>

/** Request fields shared by the regular and beta endpoints (effort is added per endpoint). */
function buildParams(request: ChatRequest): SharedParams {
  const { model } = request
  const caps = capabilities(model)
  const params: SharedParams = {
    model: model.id,
    max_tokens: Math.max(1, Math.min(request.maxOutputTokens, model.maxOutput ?? 32000)),
    // History is sent as plain text. Thinking blocks are not replayed, which keeps
    // conversations valid when earlier turns are regenerated or switch models.
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    // Automatic prompt caching: repeat turns of a long chat cost far less.
    cache_control: { type: 'ephemeral' },
  }
  if (request.system) params.system = request.system
  if (request.temperature != null && caps.sampling) params.temperature = request.temperature
  if (caps.adaptive && request.provider.thinking !== false) {
    params.thinking = caps.summaryOptIn ? { type: 'adaptive', display: 'summarized' } : { type: 'adaptive' }
  }
  return params
}

function usesFallback(request: ChatRequest): boolean {
  const base = request.provider.baseUrl.replace(/\/+$/, '')
  return request.provider.refusalFallback !== false && base === FIRST_PARTY_API && capabilities(request.model).fallback
}

function summarize(message: Anthropic.Message | Anthropic.Beta.Messages.BetaMessage, maxTokens: number): ChatResult {
  const usage = message.usage
  const result: ChatResult = {
    stopReason: message.stop_reason ?? undefined,
    inputTokens:
      (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens,
  }
  if (message.stop_reason === 'refusal') {
    result.refusal = {
      category: message.stop_details?.category ?? null,
      explanation: message.stop_details?.explanation ?? null,
    }
  } else if (message.stop_reason === 'max_tokens') {
    result.notice = `The reply reached the output limit of ${maxTokens.toLocaleString()} tokens.`
  }
  return result
}

function apiMessage(err: InstanceType<typeof Anthropic.APIError>): string {
  const body = err.error as { error?: { message?: string } } | undefined
  return body?.error?.message ?? err.message
}

function toProviderError(err: unknown, request: ChatRequest | { provider: ProviderConfig }): unknown {
  if (err instanceof Anthropic.APIUserAbortError || isAbortError(err)) return abortError()
  const where = request.provider.name
  if (err instanceof Anthropic.AuthenticationError) {
    return new ProviderError(`${where} rejected the API key (401). Check it in Settings → Providers.`, 401)
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError(`${where} denied access (403): ${apiMessage(err)}`, 403)
  }
  if (err instanceof Anthropic.NotFoundError) {
    const model = 'model' in request ? ` "${request.model.id}"` : ''
    return new ProviderError(`${where} could not find the model${model} (404).`, 404)
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ProviderError(`${where} is rate limiting requests (429). Wait a moment, then retry.`, 429)
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new ProviderError(`${where} rejected the request (400): ${apiMessage(err)}`, 400)
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(`Could not reach ${request.provider.baseUrl}: ${err.message}`)
  }
  if (err instanceof Anthropic.APIError) {
    return new ProviderError(`${where} returned an error (${err.status ?? 'unknown'}): ${apiMessage(err)}`, err.status)
  }
  return err
}

export const anthropicAdapter: ProviderAdapter = {
  async stream(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResult> {
    const client = createClient(request.provider)
    const params = buildParams(request)
    const effort = effortFor(request.model, request.provider.effort)
    const options = { signal: request.signal }
    try {
      if (usesFallback(request)) {
        // If a safety classifier declines, the API retries on a fallback model
        // inside the same call; the switch shows up as a `fallback` block.
        const betaParams: BetaStreamParams = {
          ...params,
          ...(effort ? { output_config: { effort } } : {}),
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
        }
        const stream = client.beta.messages.stream(betaParams, options)
        let notice: string | undefined
        for await (const event of stream) {
          if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') handlers.onText(event.delta.text)
            else if (event.delta.type === 'thinking_delta') handlers.onReasoning(event.delta.thinking)
          } else if (event.type === 'content_block_start' && event.content_block.type === 'fallback') {
            notice = `${event.content_block.from.model} declined, so ${event.content_block.to.model} answered.`
          }
        }
        const message = await stream.finalMessage()
        const result = summarize(message, params.max_tokens)
        const fallbackRan = (message.usage.iterations ?? []).some((entry) => entry.type === 'fallback_message')
        if (fallbackRan && message.stop_reason !== 'refusal') {
          result.servedBy = message.model
          result.notice = notice ?? `Answered by the fallback model ${message.model}.`
        }
        return result
      }

      const stream = client.messages.stream({ ...params, ...(effort ? { output_config: { effort } } : {}) }, options)
      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') handlers.onText(event.delta.text)
          else if (event.delta.type === 'thinking_delta') handlers.onReasoning(event.delta.thinking)
        }
      }
      return summarize(await stream.finalMessage(), params.max_tokens)
    } catch (err) {
      throw toProviderError(err, request)
    }
  },

  async listModels(provider: ProviderConfig): Promise<ModelInfo[]> {
    const client = createClient(provider)
    try {
      const models: ModelInfo[] = []
      for await (const model of client.models.list({ limit: 100 })) {
        models.push({
          id: model.id,
          label: model.display_name,
          maxOutput: model.max_tokens ?? undefined,
          contextWindow: model.max_input_tokens ?? undefined,
          adaptiveThinking: model.capabilities?.thinking.types.adaptive.supported,
          effort: model.capabilities?.effort.supported,
        })
      }
      return models
    } catch (err) {
      throw toProviderError(err, { provider })
    }
  },
}
