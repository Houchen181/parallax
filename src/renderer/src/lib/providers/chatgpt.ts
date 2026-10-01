// Sign in with ChatGPT: chats paid for by the user's ChatGPT plan, through the
// Responses API. The desktop main process attaches (and refreshes) the OAuth
// access token; see src/main/chatgpt.ts.
// https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
import { CHATGPT_PLAN_NOT_ENABLED, CHATGPT_SIGN_IN_REQUIRED, type AuthSpec } from '../../../../shared/bridge'
import { abortError, httpFetch, isAbortError } from '../http'
import { bridge } from '../platform'
import { parseSSE, textChunks } from '../sse'
import type { ModelInfo, ProviderConfig } from '../types'
import { ProviderError, type ChatRequest, type ChatResult, type ProviderAdapter, type StreamHandlers } from './types'

export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'
export const CHATGPT_USAGE_LIMIT = 'chatgpt_usage_limit'
/** Error codes that are fixed by signing in again or enabling plan use in Settings. */
export const CHATGPT_SETTINGS_CODES = new Set([CHATGPT_SIGN_IN_REQUIRED, CHATGPT_PLAN_NOT_ENABLED, 'chatgpt_invalid_client'])

let apiBase: Promise<string> | null = null

function base(): Promise<string> {
  if (!bridge) return Promise.reject(new ProviderError('Signing in with ChatGPT needs the Parallax desktop app.'))
  apiBase ??= bridge.chatgpt.apiBase()
  return apiBase
}

const authFor = (provider: ProviderConfig): AuthSpec => ({ providerId: provider.id, header: 'authorization', source: 'chatgpt' })

// Models that rejected reasoning summaries get them turned off for the session.
const noReasoningSummary = new Set<string>()

interface ErrorBody {
  error?: { code?: string | null; message?: string | null; param?: string | null } | string | null
  detail?: string
  message?: string
}

interface StreamEvent {
  type?: string
  delta?: string
  code?: string
  message?: string
  param?: string
  response?: {
    usage?: { input_tokens?: number; output_tokens?: number } | null
    error?: { code?: string; message?: string; param?: string } | null
    incomplete_details?: { reason?: string } | null
  }
}

async function readBody(response: Response): Promise<ErrorBody> {
  const text = await response.text().catch(() => '')
  try {
    return JSON.parse(text) as ErrorBody
  } catch {
    return { detail: text.slice(0, 300) }
  }
}

/** Maps ChatGPT plan-usage errors to messages and codes the UI can act on. */
export function planError(status: number | undefined, body: ErrorBody | undefined): ProviderError {
  const error = body?.error && typeof body.error === 'object' ? body.error : undefined
  const code = error?.code ?? undefined
  const detail = error?.message ?? (typeof body?.error === 'string' ? body.error : undefined) ?? body?.detail ?? body?.message
  switch (code) {
    case 'subscription_sharing_usage_limit_exceeded':
      return new ProviderError(
        "You've reached a ChatGPT usage limit for Parallax. It can be your plan's limit or the weekly limit you set for this app.",
        status,
        CHATGPT_USAGE_LIMIT,
      )
    case 'subscription_sharing_user_not_eligible':
      return new ProviderError("ChatGPT plan usage isn't available for this account or workspace.", status, code)
    case 'subscription_sharing_unsupported_capability':
      return new ProviderError(
        `Your ChatGPT plan can't be used for part of this request${error?.param ? ` (${error.param})` : ''}.`,
        status,
        code,
      )
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable':
      return new ProviderError("ChatGPT couldn't check your plan usage just now. Try again in a moment.", status, code)
    case 'subscription_sharing_invalid_user':
      return new ProviderError(
        "ChatGPT couldn't validate your sign-in. Sign in again in Settings → Providers.",
        status,
        CHATGPT_SIGN_IN_REQUIRED,
      )
    case 'subscription_sharing_route_not_supported':
    case 'chatpass_v2_scope_not_authorized':
    case 'chatpass_v2_invalid_authorization_context':
      return new ProviderError(`ChatGPT didn't authorize this request (${code}).`, status, code)
  }
  const suffix = detail ? `: ${detail}` : '.'
  if (status === 401) {
    return new ProviderError(`ChatGPT didn't accept your sign-in${suffix} Sign in again in Settings → Providers.`, status, CHATGPT_SIGN_IN_REQUIRED)
  }
  if (status === 403) return new ProviderError(`ChatGPT refused the request${suffix}`, status, code)
  if (status === 503) return new ProviderError(`ChatGPT plan usage is temporarily unavailable${suffix}`, status, code)
  return new ProviderError(`ChatGPT returned an error${status ? ` (${status})` : ''}${suffix}`, status, code)
}

function transportError(err: unknown): ProviderError {
  const code = (err as { code?: string } | null)?.code
  const message = err instanceof Error ? err.message : String(err)
  return code ? new ProviderError(message, undefined, code) : new ProviderError(`Could not reach ChatGPT: ${message}`)
}

async function post(url: string, body: Record<string, unknown>, request: ChatRequest): Promise<Response> {
  try {
    return await httpFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      auth: authFor(request.provider),
      signal: request.signal,
    })
  } catch (err) {
    if (isAbortError(err)) throw abortError()
    throw transportError(err)
  }
}

function incompleteNotice(reason: string | undefined): string {
  if (reason === 'max_output_tokens') return 'The reply reached its output limit.'
  if (reason === 'content_filter') return 'Part of this reply was filtered.'
  return `The reply stopped early${reason ? ` (${reason})` : ''}.`
}

export const chatgptAdapter: ProviderAdapter = {
  async stream(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResult> {
    const url = `${await base()}/responses`
    const model = request.model.id
    // Plan-funded requests must not be stored and must stream. Temperature and
    // output limits aren't accepted on this route, so they are never sent.
    const body: Record<string, unknown> = {
      model,
      input: request.messages.map((m) => ({ role: m.role, content: m.content })),
      store: false,
      stream: true,
    }
    if (request.system) body.instructions = request.system
    const wantSummary = request.provider.thinking !== false && !noReasoningSummary.has(model)
    if (wantSummary) body.reasoning = { summary: 'auto' }

    let response = await post(url, body, request)
    if (!response.ok && response.status === 400 && wantSummary) {
      const payload = await readBody(response)
      if (!JSON.stringify(payload).toLowerCase().includes('reasoning')) throw planError(400, payload)
      noReasoningSummary.add(model)
      delete body.reasoning
      response = await post(url, body, request)
    }
    if (!response.ok) throw planError(response.status, await readBody(response))
    if (!response.body) throw new ProviderError('ChatGPT returned an empty response.')

    const result: ChatResult = {}
    let finished = false
    let summaryParts = 0
    try {
      for await (const event of parseSSE(textChunks(response.body))) {
        if (!event.data || event.data === '[DONE]') continue
        let data: StreamEvent
        try {
          data = JSON.parse(event.data) as StreamEvent
        } catch {
          continue
        }
        switch (data.type) {
          case 'response.output_text.delta':
            if (data.delta) handlers.onText(data.delta)
            break
          case 'response.reasoning_summary_part.added':
            if (summaryParts++ > 0) handlers.onReasoning('\n\n')
            break
          case 'response.reasoning_summary_text.delta':
            if (data.delta) handlers.onReasoning(data.delta)
            break
          case 'response.completed':
          case 'response.incomplete': {
            finished = true
            const usage = data.response?.usage
            result.inputTokens = usage?.input_tokens
            result.outputTokens = usage?.output_tokens
            result.stopReason = data.type === 'response.completed' ? 'completed' : 'incomplete'
            if (data.type === 'response.incomplete') result.notice = incompleteNotice(data.response?.incomplete_details?.reason)
            break
          }
          case 'response.failed':
            throw planError(undefined, { error: data.response?.error ?? null })
          case 'error':
            throw planError(undefined, { error: { code: data.code, message: data.message, param: data.param } })
        }
      }
    } catch (err) {
      if (isAbortError(err) || request.signal.aborted) throw abortError()
      throw err
    }
    // Only response.completed (or .incomplete) means the reply really finished.
    if (!finished) throw new ProviderError('The connection closed before ChatGPT finished the reply.')
    return result
  },

  async listModels(provider: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]> {
    let response: Response
    try {
      response = await httpFetch(`${await base()}/models`, { headers: { accept: 'application/json' }, auth: authFor(provider), signal })
    } catch (err) {
      if (isAbortError(err)) throw abortError()
      throw transportError(err)
    }
    if (!response.ok) throw planError(response.status, await readBody(response))
    const json = (await response.json()) as {
      models?: Array<{ slug?: string; display_name?: string; visibility?: string }>
      data?: Array<{ id?: string }>
    }
    // The account's catalog keeps server order; only "list" models are meant for pickers.
    if (Array.isArray(json.models)) {
      return json.models
        .filter((m) => m.slug && (m.visibility ?? 'list') === 'list')
        .map((m) => ({ id: m.slug!, label: m.display_name || undefined }))
    }
    if (Array.isArray(json.data)) return json.data.filter((m) => m.id).map((m) => ({ id: m.id! }))
    return []
  },
}
