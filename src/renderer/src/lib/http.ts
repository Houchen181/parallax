// One fetch-shaped function for both builds. On the desktop the request is
// proxied through the main process, which attaches the API key; in the browser
// it is a plain fetch with the key read from localStorage.
import type { AuthSpec, HttpEvent } from '../../../shared/bridge'
import { webKey } from './keys'
import { bridge, newId } from './platform'

export interface HttpOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  auth?: AuthSpec
  signal?: AbortSignal
}

export function abortError(): DOMException {
  return new DOMException('The request was stopped.', 'AbortError')
}

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && (err.name === 'AbortError' || err.name === 'APIUserAbortError'))
  )
}

export type Transport = (url: string, options: HttpOptions) => Promise<Response>

let transport: Transport | null = null

/**
 * Replaces the network layer. The Parallax plugin (an MCP server running in
 * Node) reuses the provider adapters and attaches API keys itself.
 */
export function setTransport(next: Transport | null) {
  transport = next
}

export function httpFetch(url: string, options: HttpOptions = {}): Promise<Response> {
  if (transport) return transport(url, options)
  return bridge ? desktopFetch(url, options) : webFetch(url, options)
}

async function webFetch(url: string, options: HttpOptions): Promise<Response> {
  const headers = { ...options.headers }
  if (options.auth) {
    const key = webKey(options.auth.providerId)
    if (!key) throw new Error('No API key is saved for this provider. Add one in Settings → Providers.')
    headers[options.auth.header] = (options.auth.prefix ?? '') + key
  }
  return fetch(url, { method: options.method ?? 'GET', headers, body: options.body, signal: options.signal })
}

type Listener = (event: HttpEvent) => void
const listeners = new Map<string, Listener>()
let unsubscribe: (() => void) | null = null

function ensureSubscribed() {
  if (!unsubscribe && bridge) {
    unsubscribe = bridge.http.onEvent((event) => listeners.get(event.id)?.(event))
  }
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304])

function desktopFetch(url: string, options: HttpOptions): Promise<Response> {
  const api = bridge!
  ensureSubscribed()
  const id = newId()
  const encoder = new TextEncoder()

  return new Promise<Response>((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    let settled = false

    const onAbort = () => void api.http.abort(id)
    const cleanup = () => {
      listeners.delete(id)
      options.signal?.removeEventListener('abort', onAbort)
    }

    listeners.set(id, (event) => {
      switch (event.type) {
        case 'head': {
          const body = NULL_BODY_STATUS.has(event.status)
            ? null
            : new ReadableStream<Uint8Array>({
                start(c) {
                  controller = c
                },
                cancel() {
                  void api.http.abort(id)
                },
              })
          settled = true
          resolve(new Response(body, { status: event.status, statusText: event.statusText, headers: event.headers }))
          break
        }
        case 'data':
          controller?.enqueue(encoder.encode(event.chunk))
          break
        case 'end':
          controller?.close()
          cleanup()
          break
        case 'error': {
          const err = event.aborted ? abortError() : Object.assign(new TypeError(event.message), { code: event.code })
          if (!settled) {
            settled = true
            reject(err)
          } else {
            controller?.error(err)
          }
          cleanup()
          break
        }
      }
    })

    if (options.signal?.aborted) {
      cleanup()
      reject(abortError())
      return
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    api.http
      .start({
        id,
        url,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        body: options.body,
        auth: options.auth,
      })
      .catch((err: unknown) => {
        if (!settled) {
          settled = true
          reject(err instanceof Error ? err : new Error(String(err)))
        }
        cleanup()
      })
  })
}

/** Adapts httpFetch to the `fetch` signature that SDK clients accept. */
export function fetchWithAuth(auth: AuthSpec | undefined): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value
    })
    const raw = init?.body
    const body = raw == null ? undefined : typeof raw === 'string' ? raw : await new Response(raw).text()
    return httpFetch(url, { method: init?.method ?? 'GET', headers, body, auth, signal: init?.signal ?? undefined })
  }
}

/** Reads an error response into a short, human-readable message. */
export async function describeHttpError(response: Response): Promise<string> {
  let detail = ''
  try {
    const text = await response.text()
    try {
      const json = JSON.parse(text) as Record<string, unknown>
      const error = json.error as Record<string, unknown> | string | undefined
      detail =
        (typeof error === 'string' ? error : (error?.message as string | undefined)) ??
        (json.message as string | undefined) ??
        (typeof json.detail === 'string' ? json.detail : '') ??
        ''
    } catch {
      detail = text.slice(0, 300)
    }
  } catch {
    // Body unreadable; fall back to the status line.
  }
  const prefix = response.status === 401 || response.status === 403 ? 'The provider rejected the API key' : 'Request failed'
  return `${prefix} (${response.status}${response.statusText ? ` ${response.statusText}` : ''})${detail ? `: ${detail}` : ''}`
}
