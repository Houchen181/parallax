// Sign in with ChatGPT for open-source, locally run apps ("ChatGPT plan usage"):
// https://developers.openai.com/siwc/token-sharing-open-source
//
// Dynamic client registration, Authorization Code + PKCE over a 127.0.0.1
// loopback callback, ID-token validation, encrypted token storage, refresh and
// revocation. Kept free of Electron imports so it can be tested in plain Node.
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { calculateJwkThumbprintUri, createRemoteJWKSet, customFetch, exportJWK, generateKeyPair, jwtVerify } from 'jose'
import {
  CHATGPT_PLAN_NOT_ENABLED,
  CHATGPT_SIGN_IN_REQUIRED,
  type ChatGPTAccount,
  type ChatGPTSignInResult,
} from '../shared/bridge'

export const OPENAI_ISSUER = 'https://auth.openai.com'
export const OPENAI_API_BASE = 'https://api.openai.com/v1'

const RESOURCE = 'https://api.openai.com/v1'
const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`
const CALLBACK_PATH = '/auth/callback'
const PREFERRED_PORT = 1455
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000
const REFRESH_MARGIN_MS = 60 * 1000
const UNUSABLE_REFRESH = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
])

export interface Sealed {
  data: string
  encrypted: boolean
}

export interface ChatGPTDeps {
  /** Folder for chatgpt.json (the Electron userData folder). */
  dataDir: string
  /** OS-level encryption for tokens (Electron safeStorage). */
  seal(plain: string): Sealed
  unseal(sealed: Sealed): string
  /** Opens the authorization URL, normally in the system browser. */
  openUrl(url: string): Promise<void>
  /** Shown to the user as the agent name during registration. */
  appName: string
  issuer?: string
  apiBase?: string
  fetch?: typeof fetch
}

interface Secrets {
  idToken?: string
  accessToken: string
  refreshToken?: string
  expiresAt: number
  earliestRefreshAt?: number
  scopes: string[]
  savedAt: string
}

interface AccountRecord {
  /** Issued by dynamic registration (oaiapp_...); reused for every later sign-in. */
  clientId?: string
  subject?: string
  email?: string
  secret?: Sealed | null
  needsSignIn?: boolean
}

interface StoreFile {
  version: 1
  /** Stable per-installation agent host id (RFC 9278 JWK thumbprint URI). */
  hostId?: string
  hostKey?: Sealed
  accounts: Record<string, AccountRecord>
}

interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  revocation_endpoint?: string
  jwks_uri: string
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  id_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
  earliest_refresh_at?: number | string
}

export class ChatGPTError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ChatGPTError'
    this.code = code
  }
}

class OAuthError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'OAuthError'
    this.code = code
    this.status = status
  }
}

const b64url = (bytes: Buffer) => bytes.toString('base64url')
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function toMillis(value: number | string | undefined): number | undefined {
  if (value == null) return undefined
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function callbackPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Parallax</title></head>
<body style="font-family: system-ui, sans-serif; display: grid; place-items: center; height: 100vh; margin: 0; background: #f7f7f8; color: #0d0d0d">
<p style="font-size: 16px">${message}</p></body></html>`
}

interface Loopback {
  port: number
  result: Promise<URLSearchParams>
  close(): void
}

/** Listens on 127.0.0.1 (port 1455 if free) for the single OAuth redirect of this attempt. */
function startLoopback(expectedState: string): Promise<Loopback> {
  return new Promise((resolveStart, rejectStart) => {
    let settle!: { resolve(params: URLSearchParams): void; reject(err: Error): void }
    const result = new Promise<URLSearchParams>((resolve, reject) => {
      settle = { resolve, reject }
    })
    result.catch(() => undefined)

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not found')
        return
      }
      if (url.searchParams.get('state') !== expectedState) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        res.end(callbackPage('This sign-in link is no longer valid. Return to Parallax and try again.'))
        return
      }
      const failed = url.searchParams.has('error')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(
        callbackPage(
          failed
            ? 'Sign-in was not completed. You can close this tab and return to Parallax.'
            : 'You’re signed in. You can close this tab and return to Parallax.',
        ),
      )
      settle.resolve(url.searchParams)
    })

    let closed = false
    const timer = setTimeout(() => close(new Error('Sign-in timed out. Try again.')), SIGN_IN_TIMEOUT_MS)
    const close = (reason = new Error('Sign-in was cancelled.')) => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      server.close()
      server.closeAllConnections?.()
      settle.reject(reason)
    }

    const listen = (port: number) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && port !== 0) listen(0)
        else {
          clearTimeout(timer)
          rejectStart(err)
        }
      })
      server.listen(port, '127.0.0.1', () => {
        resolveStart({ port: (server.address() as AddressInfo).port, result, close: () => close() })
      })
    }
    listen(PREFERRED_PORT)
  })
}

export class ChatGPTAuth {
  private data: StoreFile = { version: 1, accounts: {} }
  private discovery?: Promise<Discovery>
  private jwks?: ReturnType<typeof createRemoteJWKSet>
  private readonly refreshing = new Map<string, Promise<string>>()
  private pending: { cancel(): void } | null = null
  private writes: Promise<void> = Promise.resolve()
  private readonly deps: ChatGPTDeps
  private readonly issuer: string
  private readonly apiBase: string
  private readonly fetchImpl: typeof fetch
  private readonly file: string

  constructor(deps: ChatGPTDeps) {
    this.deps = deps
    this.issuer = (deps.issuer ?? OPENAI_ISSUER).replace(/\/+$/, '')
    this.apiBase = (deps.apiBase ?? OPENAI_API_BASE).replace(/\/+$/, '')
    this.fetchImpl = deps.fetch ?? fetch
    this.file = join(deps.dataDir, 'chatgpt.json')
  }

  /** The Responses API base URL the access tokens are used with. */
  get apiBaseUrl(): string {
    return this.apiBase
  }

  /** Tokens are only ever attached to requests for this origin. */
  get apiOrigin(): string {
    return new URL(this.apiBase).origin
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as StoreFile
      if (raw?.version === 1) this.data = { ...raw, accounts: raw.accounts ?? {} }
    } catch {
      // First run, or an unreadable file: start empty.
    }
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2)
    this.writes = this.writes
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.deps.dataDir, { recursive: true })
        const tmp = `${this.file}.tmp`
        await writeFile(tmp, snapshot, { mode: 0o600 })
        await rename(tmp, this.file)
      })
    return this.writes
  }

  /** Chosen once per installation, before the first sign-in, and reused afterwards. */
  async hostId(): Promise<string> {
    if (this.data.hostId) return this.data.hostId
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true })
    this.data.hostId = await calculateJwkThumbprintUri(await exportJWK(publicKey))
    this.data.hostKey = this.deps.seal(JSON.stringify(await exportJWK(privateKey)))
    await this.persist()
    return this.data.hostId
  }

  accounts(): ChatGPTAccount[] {
    return Object.entries(this.data.accounts).map(([providerId, record]) => this.describe(providerId, record))
  }

  private describe(providerId: string, record: AccountRecord): ChatGPTAccount {
    const secrets = this.readSecrets(record)
    return {
      providerId,
      email: record.email,
      signedIn: !!secrets && !record.needsSignIn,
      planEnabled: !!secrets?.scopes.includes(PLAN_SCOPE),
      needsSignIn: !!record.needsSignIn,
    }
  }

  private readSecrets(record: AccountRecord | undefined): Secrets | undefined {
    if (!record?.secret) return undefined
    try {
      return JSON.parse(this.deps.unseal(record.secret)) as Secrets
    } catch {
      return undefined
    }
  }

  private getDiscovery(): Promise<Discovery> {
    this.discovery ??= (async () => {
      const res = await this.fetchImpl(`${this.issuer}/.well-known/openid-configuration`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`ChatGPT sign-in is unavailable right now (discovery returned ${res.status}).`)
      const doc = (await res.json()) as Discovery
      if (doc.issuer !== this.issuer) throw new Error('The OpenAI discovery document names an unexpected issuer.')
      return doc
    })().catch((err: unknown) => {
      this.discovery = undefined
      throw err
    })
    return this.discovery
  }

  private async tokenRequest(doc: Discovery, form: Record<string, string>): Promise<TokenResponse> {
    const res = await this.fetchImpl(doc.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    })
    const text = await res.text()
    let json: Record<string, unknown> = {}
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch {
      // Non-JSON error body; fall through with the raw text.
    }
    if (!res.ok || typeof json.access_token !== 'string') {
      const code = typeof json.error === 'string' ? json.error : String(res.status)
      const detail = json.error_description ?? json.message ?? json.detail ?? text.slice(0, 200)
      throw new OAuthError(code, `OpenAI sign-in failed (${code}): ${String(detail)}`, res.status)
    }
    return json as unknown as TokenResponse
  }

  private async verifyIdToken(doc: Discovery, idToken: string | undefined, clientId: string, nonce: string) {
    if (!idToken) throw new Error('OpenAI did not return an ID token.')
    this.jwks ??= createRemoteJWKSet(new URL(doc.jwks_uri), { [customFetch]: this.fetchImpl })
    const { payload } = await jwtVerify(idToken, this.jwks, {
      issuer: doc.issuer,
      audience: clientId,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp', 'iat'],
      clockTolerance: 5,
    })
    if (payload.nonce !== nonce) throw new Error('The ID token nonce did not match.')
    if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('The ID token has no subject.')
    return { sub: payload.sub, email: typeof payload.email === 'string' ? payload.email : undefined }
  }

  /**
   * Runs one browser sign-in for the account behind `providerId`. The first
   * sign-in registers Parallax as an agent and returns an issued client id;
   * later ones reuse it. `enablePlan` asks again for plan-usage consent, and
   * `openUrl` replaces the default way of opening the authorization page.
   */
  async signIn(
    providerId: string,
    options: { enablePlan?: boolean; openUrl?: (url: string) => Promise<void> } = {},
  ): Promise<ChatGPTSignInResult> {
    this.pending?.cancel()
    const record = this.data.accounts[providerId]
    const savedClient = record?.clientId
    const previous = this.readSecrets(record)

    let doc: Discovery
    let hostId: string
    let loopback: Loopback
    const state = b64url(randomBytes(32))
    const nonce = b64url(randomBytes(32))
    const verifier = b64url(randomBytes(48))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    try {
      doc = await this.getDiscovery()
      hostId = await this.hostId()
      loopback = await startLoopback(state)
    } catch (err) {
      return { status: 'error', message: errorText(err) }
    }

    let cancelled = false
    const attempt = {
      cancel: () => {
        cancelled = true
        loopback.close()
      },
    }
    this.pending = attempt

    const redirectUri = `http://127.0.0.1:${loopback.port}${CALLBACK_PATH}`
    const params: Record<string, string> = {
      client_id: savedClient ?? 'dynamic_agent_client',
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      ext_agent_host_id: hostId,
    }
    if (!savedClient) {
      params.agent_name_hint = this.deps.appName
    } else {
      if (previous?.idToken) params.id_token_hint = previous.idToken
      if (record?.email) params.login_hint = record.email
      if (options.enablePlan) params.prompt = 'consent'
    }
    const query = Object.entries(params)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&')

    try {
      await (options.openUrl ?? this.deps.openUrl)(`${doc.authorization_endpoint}?${query}`)
      const callback = await loopback.result

      const error = callback.get('error')
      if (error === 'access_denied') return { status: 'declined' }
      if (error) return { status: 'error', message: `ChatGPT sign-in failed: ${callback.get('error_description') ?? error}` }
      const code = callback.get('code')
      if (!code) return { status: 'error', message: 'ChatGPT sign-in did not return an authorization code.' }

      const returnedClient = callback.get('client_id') ?? undefined
      let clientId: string
      if (!savedClient) {
        if (!returnedClient || returnedClient === 'dynamic_agent_client') {
          return { status: 'error', message: 'ChatGPT did not finish registering Parallax. Try signing in again.' }
        }
        clientId = returnedClient
      } else {
        if (returnedClient && returnedClient !== savedClient) {
          return { status: 'error', message: 'ChatGPT returned a different app registration than expected. Try again.' }
        }
        clientId = savedClient
      }

      const tokens = await this.tokenRequest(doc, {
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: RESOURCE,
      })
      const identity = await this.verifyIdToken(doc, tokens.id_token, clientId, nonce)
      if (record?.subject && identity.sub !== record.subject) {
        return {
          status: 'error',
          message: 'You signed in with a different ChatGPT account. To use another account, add a second "ChatGPT plan" provider.',
        }
      }

      const scopes = (tokens.scope ?? callback.get('scope') ?? '').split(/[\s+]+/).filter(Boolean)
      const secrets: Secrets = {
        idToken: tokens.id_token,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        earliestRefreshAt: toMillis(tokens.earliest_refresh_at),
        scopes,
        savedAt: new Date().toISOString(),
      }
      const next: AccountRecord = {
        clientId,
        subject: identity.sub,
        email: identity.email ?? record?.email,
        secret: this.deps.seal(JSON.stringify(secrets)),
        needsSignIn: false,
      }
      this.data.accounts[providerId] = next
      await this.persist()
      return { status: 'signed-in', account: this.describe(providerId, next), firstTime: !savedClient }
    } catch (err) {
      if (cancelled) return { status: 'cancelled' }
      return { status: 'error', message: errorText(err) }
    } finally {
      loopback.close()
      if (this.pending === attempt) this.pending = null
    }
  }

  cancelSignIn(): void {
    this.pending?.cancel()
  }

  /** A valid access token for the account, refreshed when it is about to expire. */
  async accessToken(providerId: string): Promise<string> {
    const record = this.data.accounts[providerId]
    const secrets = this.readSecrets(record)
    if (!record || !secrets || record.needsSignIn) {
      throw new ChatGPTError(CHATGPT_SIGN_IN_REQUIRED, 'Sign in with ChatGPT in Settings → Providers to use your ChatGPT plan.')
    }
    if (!secrets.scopes.includes(PLAN_SCOPE)) {
      throw new ChatGPTError(
        CHATGPT_PLAN_NOT_ENABLED,
        "ChatGPT plan use isn't enabled for this sign-in. Enable it in Settings → Providers.",
      )
    }
    const now = Date.now()
    if (now < secrets.expiresAt - REFRESH_MARGIN_MS) return secrets.accessToken
    if (secrets.earliestRefreshAt && now < secrets.earliestRefreshAt && now < secrets.expiresAt) return secrets.accessToken

    // Refresh tokens rotate, so never run two refreshes for one account at once.
    let pending = this.refreshing.get(providerId)
    if (!pending) {
      pending = this.refresh(providerId, record, secrets).finally(() => this.refreshing.delete(providerId))
      this.refreshing.set(providerId, pending)
    }
    return pending
  }

  private async refresh(providerId: string, record: AccountRecord, secrets: Secrets): Promise<string> {
    const signInAgain = new ChatGPTError(
      CHATGPT_SIGN_IN_REQUIRED,
      'Your ChatGPT sign-in has expired. Continue with ChatGPT in Settings → Providers to sign in again.',
    )
    if (!secrets.refreshToken || !record.clientId) {
      record.secret = null
      record.needsSignIn = true
      await this.persist()
      throw signInAgain
    }
    const doc = await this.getDiscovery()
    try {
      const tokens = await this.tokenRequest(doc, {
        grant_type: 'refresh_token',
        client_id: record.clientId,
        refresh_token: secrets.refreshToken,
        resource: RESOURCE,
      })
      const next: Secrets = {
        ...secrets,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? secrets.refreshToken,
        idToken: tokens.id_token ?? secrets.idToken,
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        earliestRefreshAt: toMillis(tokens.earliest_refresh_at),
        scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : secrets.scopes,
        savedAt: new Date().toISOString(),
      }
      this.data.accounts[providerId] = { ...record, secret: this.deps.seal(JSON.stringify(next)), needsSignIn: false }
      await this.persist()
      return next.accessToken
    } catch (err) {
      if (err instanceof OAuthError && UNUSABLE_REFRESH.has(err.code)) {
        this.data.accounts[providerId] = { ...record, secret: null, needsSignIn: true }
        await this.persist()
        throw signInAgain
      }
      if (err instanceof OAuthError && err.code === 'invalid_client') {
        throw new ChatGPTError('chatgpt_invalid_client', 'OpenAI no longer recognizes this app registration. Sign out and sign in again.')
      }
      // Network trouble or a server error: keep the credentials and let the caller retry later.
      throw err
    }
  }

  /** Revokes the renewable session (best effort) and clears the tokens, keeping the registration. */
  async signOut(providerId: string): Promise<{ revoked: boolean }> {
    const record = this.data.accounts[providerId]
    if (!record) return { revoked: true }
    const secrets = this.readSecrets(record)
    let revoked = !secrets?.refreshToken
    if (secrets?.refreshToken && record.clientId) {
      try {
        const doc = await this.getDiscovery()
        if (doc.revocation_endpoint) {
          for (let attempt = 0; attempt < 3 && !revoked; attempt++) {
            try {
              const res = await this.fetchImpl(doc.revocation_endpoint, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  token: secrets.refreshToken,
                  token_type_hint: 'refresh_token',
                  client_id: record.clientId,
                }).toString(),
              })
              if (res.ok) revoked = true
              else if (res.status < 500) break
            } catch {
              // Network failure: retry with backoff.
            }
            if (!revoked) await sleep(400 * 2 ** attempt)
          }
        }
      } catch {
        // Discovery failed; sign out locally anyway.
      }
    }
    this.data.accounts[providerId] = { ...record, secret: null, needsSignIn: false }
    await this.persist()
    return { revoked }
  }

  /** Signs out and forgets the registration entirely. */
  async forget(providerId: string): Promise<void> {
    await this.signOut(providerId)
    delete this.data.accounts[providerId]
    await this.persist()
  }
}
