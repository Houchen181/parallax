// Serves the Parallax web app from this computer and acts as its back end:
// API keys and ChatGPT tokens stay in this process (never in browser storage),
// requests to providers are proxied (so CORS doesn't matter), and Sign in with
// ChatGPT works because the whole app runs locally.
//
// Only the page this server hands out can use the API: requests must carry the
// per-launch session token embedded in that page, come from this origin, and
// name 127.0.0.1/localhost as the host (which stops DNS-rebinding tricks).
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, resolve, sep } from 'node:path'
import type { ChatGPTSignInResult, HttpRequest } from '../shared/bridge'
import { prepareUpstream, type KeyStore } from '../main/backend'
import { ChatGPTError, type ChatGPTAuth } from '../main/chatgpt'

export interface LocalServerOptions {
  /** Folder with the built web app (dist/web). */
  staticDir: string
  port: number
  keys: KeyStore
  chatgpt: ChatGPTAuth
  /** Opens a URL in the system browser, used when the page can't open a tab itself. */
  openUrl(url: string): Promise<void>
  fetch?: typeof fetch
}

export interface LocalServer {
  url: string
  port: number
  close(): Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  // The page must not be framed by other sites (clickjacking).
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
}

export const TOKEN_META = 'parallax-local-token'

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...extra })
  res.end(JSON.stringify(body ?? null))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 10 * 1024 * 1024) throw new Error('Request body too large')
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export async function startLocalServer(options: LocalServerOptions): Promise<LocalServer> {
  const token = randomBytes(32).toString('base64url')
  const fetchImpl = options.fetch ?? fetch
  const staticRoot = resolve(options.staticDir)
  const attempts = new Map<string, Promise<ChatGPTSignInResult>>()
  let port = options.port
  let indexHtml: string | null = null

  const allowedHost = (host: string | undefined) => host === `127.0.0.1:${port}` || host === `localhost:${port}`

  async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, SECURITY_HEADERS)
      res.end()
      return
    }
    let relative: string
    try {
      relative = decodeURIComponent(pathname)
    } catch {
      res.writeHead(400, SECURITY_HEADERS)
      res.end()
      return
    }
    if (relative === '/' || relative === '/index.html') {
      // The session token goes into the page itself; other sites can't read it.
      indexHtml ??= await readFile(join(staticRoot, 'index.html'), 'utf8')
      const html = indexHtml.replace('<head>', `<head>\n    <meta name="${TOKEN_META}" content="${token}" />`)
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store', ...SECURITY_HEADERS })
      res.end(req.method === 'HEAD' ? undefined : html)
      return
    }
    const file = resolve(staticRoot, `.${relative}`)
    if (file !== staticRoot && !file.startsWith(staticRoot + sep)) {
      res.writeHead(403, SECURITY_HEADERS)
      res.end()
      return
    }
    try {
      const info = await stat(file)
      if (!info.isFile()) throw new Error('not a file')
      res.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': relative.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        ...SECURITY_HEADERS,
      })
      res.end(req.method === 'HEAD' ? undefined : await readFile(file))
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain', ...SECURITY_HEADERS })
      res.end('Not found')
    }
  }

  async function proxy(res: ServerResponse, request: HttpRequest) {
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })
    let upstream: Response
    try {
      const { url, init } = await prepareUpstream(request, options.keys, options.chatgpt)
      upstream = await fetchImpl(url, { ...init, signal: controller.signal })
    } catch (err) {
      sendJson(res, 502, { message: message(err), code: err instanceof ChatGPTError ? err.code : undefined }, { 'x-parallax-error': '1' })
      return
    }
    const headers: Record<string, string> = {}
    upstream.headers.forEach((value, name) => {
      headers[name] = value
    })
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'x-parallax-status': String(upstream.status),
      'x-parallax-status-text': encodeURIComponent(upstream.statusText),
      'x-parallax-headers': encodeURIComponent(JSON.stringify(headers)),
      ...SECURITY_HEADERS,
    })
    if (upstream.body) {
      const reader = upstream.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
      } catch {
        // The browser went away or the provider dropped the connection.
      }
    }
    res.end()
  }

  async function startSignIn(body: Record<string, unknown>) {
    const providerId = String(body.providerId ?? '')
    const openHere = body.openInSystemBrowser === true
    let resolveUrl!: (url: string) => void
    const urlReady = new Promise<string>((r) => {
      resolveUrl = r
    })
    const result = options.chatgpt.signIn(providerId, {
      enablePlan: body.enablePlan === true,
      openUrl: async (authUrl) => {
        resolveUrl(authUrl)
        if (openHere) await options.openUrl(authUrl)
      },
    })
    const first = await Promise.race([urlReady.then((url) => ({ url })), result.then((done) => ({ done }))])
    if ('done' in first) return { done: first.done }
    const attempt = randomBytes(12).toString('base64url')
    attempts.set(attempt, result)
    void result.finally(() => setTimeout(() => attempts.delete(attempt), 60_000))
    return { attempt, url: first.url }
  }

  async function api(req: IncomingMessage, res: ServerResponse, route: string) {
    const provided = req.headers['x-parallax-token']
    if (typeof provided !== 'string' || !sameToken(provided, token)) {
      sendJson(res, 403, { message: 'The local Parallax server restarted. Reload this page.', code: 'local_session_expired' })
      return
    }
    const origin = req.headers.origin
    if (origin && origin !== `http://${req.headers.host}`) {
      sendJson(res, 403, { message: 'Requests from other sites are not allowed.' })
      return
    }
    try {
      const body = req.method === 'POST' ? await readJson(req) : {}
      const providerId = String(body.providerId ?? '')
      switch (`${req.method} ${route}`) {
        case 'GET keys':
          // The plugin's key page may have changed the shared file.
          await options.keys.refresh()
          return sendJson(res, 200, options.keys.list())
        case 'POST keys':
          await options.keys.set(providerId, String(body.key ?? ''), String(body.baseUrl ?? ''))
          return sendJson(res, 200, {})
        case 'POST keys/remove':
          await options.keys.remove(providerId)
          return sendJson(res, 200, {})
        case 'POST proxy':
          await options.keys.refresh()
          return await proxy(res, body as unknown as HttpRequest)
        case 'GET chatgpt/api-base':
          return sendJson(res, 200, { apiBase: options.chatgpt.apiBaseUrl })
        case 'GET chatgpt/accounts':
          return sendJson(res, 200, options.chatgpt.accounts())
        case 'POST chatgpt/sign-in/start':
          return sendJson(res, 200, await startSignIn(body))
        case 'POST chatgpt/sign-in/wait': {
          const pending = attempts.get(String(body.attempt ?? ''))
          if (!pending) return sendJson(res, 404, { message: 'That sign-in attempt has expired. Try again.' })
          return sendJson(res, 200, await pending)
        }
        case 'POST chatgpt/cancel':
          options.chatgpt.cancelSignIn()
          return sendJson(res, 200, {})
        case 'POST chatgpt/sign-out':
          return sendJson(res, 200, await options.chatgpt.signOut(providerId))
        case 'POST chatgpt/forget':
          await options.chatgpt.forget(providerId)
          return sendJson(res, 200, {})
        default:
          return sendJson(res, 404, { message: `Unknown API route: ${req.method} /api/${route}` })
      }
    } catch (err) {
      if (!res.headersSent) sendJson(res, 400, { message: message(err), code: err instanceof ChatGPTError ? err.code : undefined })
      else res.end()
    }
  }

  const server = createServer((req, res) => {
    if (!allowedHost(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'text/plain', ...SECURITY_HEADERS })
      res.end('Parallax only answers on 127.0.0.1 or localhost.')
      return
    }
    const { pathname } = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const work = pathname.startsWith('/api/') ? api(req, res, pathname.slice('/api/'.length)) : serveStatic(req, res, pathname)
    work.catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { message: message(err) })
      else res.end()
    })
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(options.port, '127.0.0.1', () => resolveListen())
  })
  port = (server.address() as AddressInfo).port
  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections?.()
        server.close(() => resolveClose())
      }),
  }
}
