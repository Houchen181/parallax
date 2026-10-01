// The bridge used when the web app is served by `npm run serve` on this
// computer. It talks to that local server over HTTP and offers the same
// interface as the desktop app's preload bridge, so the rest of the UI works
// unchanged: keys and ChatGPT tokens stay in the server, and provider requests
// are proxied through it.
import type {
  ChatGPTAccount,
  ChatGPTSignInResult,
  HttpEvent,
  HttpRequest,
  ParallaxBridge,
  SavedKeyInfo,
} from '../../../shared/bridge'

class LocalServerError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'LocalServerError'
    this.code = code
  }
}

export function createLocalBridge(token: string): ParallaxBridge {
  const headers = (json: boolean): Record<string, string> => ({
    'x-parallax-token': token,
    ...(json ? { 'content-type': 'application/json' } : {}),
  })

  async function call<T>(route: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await fetch(`./api/${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      throw new LocalServerError('The local Parallax server is not running. Start it again with "npm run serve".')
    }
    const text = await response.text()
    const json = text ? (JSON.parse(text) as unknown) : undefined
    if (!response.ok) {
      const error = json as { message?: string; code?: string } | undefined
      throw new LocalServerError(error?.message ?? `The local server returned ${response.status}.`, error?.code)
    }
    return json as T
  }

  const listeners = new Set<(event: HttpEvent) => void>()
  const emit = (event: HttpEvent) => listeners.forEach((listener) => listener(event))
  const inflight = new Map<string, AbortController>()
  let popup: Window | null = null

  async function proxy(request: HttpRequest, controller: AbortController) {
    try {
      const response = await fetch('./api/proxy', {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify(request),
        signal: controller.signal,
      })
      if (!response.ok || response.headers.get('x-parallax-error')) {
        const error = (await response.json().catch(() => ({}))) as { message?: string; code?: string }
        emit({ id: request.id, type: 'error', message: error.message ?? `Local server error ${response.status}`, aborted: false, code: error.code })
        return
      }
      emit({
        id: request.id,
        type: 'head',
        status: Number(response.headers.get('x-parallax-status') ?? 502),
        statusText: decodeURIComponent(response.headers.get('x-parallax-status-text') ?? ''),
        headers: JSON.parse(decodeURIComponent(response.headers.get('x-parallax-headers') ?? '%7B%7D')) as Record<string, string>,
      })
      if (response.body) {
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = decoder.decode(value, { stream: true })
          if (chunk) emit({ id: request.id, type: 'data', chunk })
        }
        const tail = decoder.decode()
        if (tail) emit({ id: request.id, type: 'data', chunk: tail })
      }
      emit({ id: request.id, type: 'end' })
    } catch (err) {
      emit({
        id: request.id,
        type: 'error',
        message: controller.signal.aborted
          ? 'aborted'
          : `The local Parallax server didn't respond (${err instanceof Error ? err.message : String(err)}).`,
        aborted: controller.signal.aborted,
      })
    } finally {
      inflight.delete(request.id)
    }
  }

  return {
    runtime: 'local',
    platform: navigator.platform,
    versions: { electron: '', chrome: '', node: '' },
    keys: {
      list: () => call<SavedKeyInfo[]>('keys'),
      set: (providerId, key, baseUrl) => call('keys', { providerId, key, baseUrl }),
      remove: (providerId) => call('keys/remove', { providerId }),
    },
    http: {
      async start(request) {
        const controller = new AbortController()
        inflight.set(request.id, controller)
        void proxy(request, controller)
      },
      async abort(id) {
        inflight.get(id)?.abort()
      },
      onEvent(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    chatgpt: {
      apiBase: async () => (await call<{ apiBase: string }>('chatgpt/api-base')).apiBase,
      accounts: () => call<ChatGPTAccount[]>('chatgpt/accounts'),
      async signIn(providerId, options) {
        // Open the tab right away, while the click still counts as user-initiated,
        // then point it at OpenAI once the server has prepared the sign-in.
        popup = window.open('', '_blank')
        if (popup) popup.opener = null
        const start = await call<{ attempt?: string; url?: string; done?: ChatGPTSignInResult }>('chatgpt/sign-in/start', {
          providerId,
          enablePlan: options?.enablePlan === true,
          openInSystemBrowser: !popup,
        })
        if (start.done) {
          popup?.close()
          return start.done
        }
        if (popup && start.url) popup.location.href = start.url
        const result = await call<ChatGPTSignInResult>('chatgpt/sign-in/wait', { attempt: start.attempt })
        popup?.close()
        popup = null
        window.focus()
        return result
      },
      async cancelSignIn() {
        await call('chatgpt/cancel', {})
        popup?.close()
        popup = null
      },
      signOut: (providerId) => call<{ revoked: boolean }>('chatgpt/sign-out', { providerId }),
      forget: (providerId) => call('chatgpt/forget', { providerId }),
    },
    async openExternal(url) {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
  }
}
