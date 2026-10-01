// Types shared by the Electron main process, the preload script and the renderer.
// The renderer reaches the network and the key store only through this bridge.

export interface AuthSpec {
  /** Provider whose saved API key should be attached to the request. */
  providerId: string
  /** Header that carries the key, e.g. "authorization" or "x-api-key". */
  header: string
  /** Text placed before the key, e.g. "Bearer ". */
  prefix?: string
}

export interface HttpRequest {
  id: string
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  auth?: AuthSpec
}

export type HttpEvent =
  | { id: string; type: 'head'; status: number; statusText: string; headers: Record<string, string> }
  | { id: string; type: 'data'; chunk: string }
  | { id: string; type: 'end' }
  | { id: string; type: 'error'; message: string; aborted: boolean }

export interface SavedKeyInfo {
  providerId: string
  /** The key is only ever sent to this origin. */
  origin: string
  /** False when the OS offers no encryption (the key is then only obfuscated). */
  encrypted: boolean
}

export interface ParallaxBridge {
  isDesktop: true
  platform: string
  versions: { electron: string; chrome: string; node: string }
  keys: {
    list(): Promise<SavedKeyInfo[]>
    set(providerId: string, key: string, baseUrl: string): Promise<void>
    remove(providerId: string): Promise<void>
  }
  http: {
    start(request: HttpRequest): Promise<void>
    abort(id: string): Promise<void>
    onEvent(listener: (event: HttpEvent) => void): () => void
  }
  openExternal(url: string): Promise<void>
}
