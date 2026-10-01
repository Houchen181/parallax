// Pieces shared by the local back ends: the Electron main process (desktop
// app), the local web server (`npm run serve`) and the plugin's MCP server.
// They keep API keys and ChatGPT tokens out of the UI and the chat, and attach
// them to outgoing requests themselves.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { HttpRequest, SavedKeyInfo } from '../shared/bridge'
import type { ChatGPTAuth, Sealed } from './chatgpt'

interface StoredKey extends Sealed {
  origin: string
}

/** API keys sealed by the host (OS encryption on the desktop) and locked to one origin each. */
export class KeyStore {
  private keys: Record<string, StoredKey> = {}
  private writes: Promise<void> = Promise.resolve()
  private readonly file: string
  private readonly seal: (plain: string) => Sealed
  private readonly unseal: (sealed: Sealed) => string

  constructor(file: string, seal: (plain: string) => Sealed, unseal: (sealed: Sealed) => string) {
    this.file = file
    this.seal = seal
    this.unseal = unseal
  }

  async load(): Promise<void> {
    try {
      this.keys = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, StoredKey>
    } catch {
      this.keys = {}
    }
  }

  // Reads and writes run one at a time. The local web version and the plugin
  // share one file, so each change re-reads it first to keep the other's edits.
  private queue(task: () => Promise<void>): Promise<void> {
    this.writes = this.writes.catch(() => undefined).then(task)
    return this.writes
  }

  /** Picks up changes another Parallax process made to the file. */
  refresh(): Promise<void> {
    return this.queue(() => this.load())
  }

  private update(change: (keys: Record<string, StoredKey>) => void): Promise<void> {
    return this.queue(async () => {
      await this.load()
      change(this.keys)
      const snapshot = JSON.stringify(this.keys, null, 2)
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      await writeFile(tmp, snapshot, { mode: 0o600 })
      await rename(tmp, this.file)
    })
  }

  list(): SavedKeyInfo[] {
    return Object.entries(this.keys).map(([providerId, k]) => ({ providerId, origin: k.origin, encrypted: k.encrypted }))
  }

  async set(providerId: string, key: string, baseUrl: string): Promise<void> {
    if (typeof providerId !== 'string' || !providerId) throw new Error('Missing provider id')
    if (typeof key !== 'string' || !key.trim()) throw new Error('The API key is empty')
    const sealed = { ...this.seal(key.trim()), origin: new URL(baseUrl).origin }
    await this.update((keys) => {
      keys[providerId] = sealed
    })
  }

  async remove(providerId: string): Promise<void> {
    await this.update((keys) => {
      delete keys[providerId]
    })
  }

  /** The key saved for a provider and the origin it is locked to, if any. */
  saved(providerId: string): { key: string; origin: string } | undefined {
    const stored = this.keys[providerId]
    return stored ? { key: this.unseal(stored), origin: stored.origin } : undefined
  }

  /** The key for a request to `url`; refuses any origin other than the one it was saved for. */
  keyFor(providerId: string, url: URL): string {
    const stored = this.keys[providerId]
    if (!stored) throw new Error('No API key is saved for this provider. Add one in Settings → Providers.')
    if (stored.origin !== url.origin) {
      throw new Error(`The saved API key is locked to ${stored.origin}. Save the key again after changing the base URL.`)
    }
    return this.unseal(stored)
  }
}

const DROPPED_HEADERS = new Set(['host', 'content-length', 'connection', 'origin', 'referer', 'cookie'])

/** Validates a request from the UI and attaches the right credential. */
export async function prepareUpstream(
  request: HttpRequest,
  keys: KeyStore,
  chatgpt: ChatGPTAuth,
): Promise<{ url: string; init: { method: string; headers: Record<string, string>; body?: string } }> {
  const url = new URL(request.url)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Unsupported URL scheme: ${url.protocol}`)
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    const lower = name.toLowerCase()
    if (!DROPPED_HEADERS.has(lower)) headers[lower] = value
  }
  if (request.auth?.source === 'chatgpt') {
    // OAuth tokens from Sign in with ChatGPT only ever go to the OpenAI API.
    if (url.origin !== chatgpt.apiOrigin) throw new Error(`ChatGPT sign-in only works with ${chatgpt.apiOrigin}.`)
    headers.authorization = `Bearer ${await chatgpt.accessToken(request.auth.providerId)}`
  } else if (request.auth) {
    headers[request.auth.header.toLowerCase()] = (request.auth.prefix ?? '') + keys.keyFor(request.auth.providerId, url)
  }
  return { url: url.href, init: { method: request.method || 'GET', headers, body: request.body } }
}
