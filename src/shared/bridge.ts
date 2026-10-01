// Types shared by the Electron main process, the preload script and the renderer.
// The renderer reaches the network and the key store only through this bridge.

export interface AuthSpec {
  /** Provider whose saved API key should be attached to the request. */
  providerId: string
  /** Header that carries the key, e.g. "authorization" or "x-api-key". */
  header: string
  /** Text placed before the key, e.g. "Bearer ". */
  prefix?: string
  /** "chatgpt" attaches the OAuth access token from Sign in with ChatGPT instead of an API key. */
  source?: 'key' | 'chatgpt'
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
  | { id: string; type: 'error'; message: string; aborted: boolean; code?: string }

export interface SavedKeyInfo {
  providerId: string
  /** The key is only ever sent to this origin. */
  origin: string
  /** False when the OS offers no encryption (the key is then only obfuscated). */
  encrypted: boolean
}

/** One ChatGPT account registration (one per ChatGPT provider in Parallax). */
export interface ChatGPTAccount {
  providerId: string
  email?: string
  /** A usable token set is stored. */
  signedIn: boolean
  /** The user allowed Parallax to use their ChatGPT plan (scope chatgpt.tokens.use.direct). */
  planEnabled: boolean
  /** The tokens stopped working (expired session or revoked access); sign in again. */
  needsSignIn: boolean
}

export type ChatGPTSignInResult =
  | { status: 'signed-in'; account: ChatGPTAccount; firstTime: boolean }
  | { status: 'declined' }
  | { status: 'cancelled' }
  | { status: 'error'; message: string }

/** Error codes the main process attaches to failed requests. */
export const CHATGPT_SIGN_IN_REQUIRED = 'chatgpt_sign_in_required'
export const CHATGPT_PLAN_NOT_ENABLED = 'chatgpt_plan_not_enabled'

export interface ParallaxBridge {
  /** desktop = the Electron app; local = the web app served by `npm run serve` on this computer. */
  runtime: 'desktop' | 'local'
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
  chatgpt: {
    /** The Responses API base the access token is valid for. */
    apiBase(): Promise<string>
    accounts(): Promise<ChatGPTAccount[]>
    signIn(providerId: string, options?: { enablePlan?: boolean }): Promise<ChatGPTSignInResult>
    cancelSignIn(): Promise<void>
    signOut(providerId: string): Promise<{ revoked: boolean }>
    /** Signs out and drops the registration (used when the provider is removed). */
    forget(providerId: string): Promise<void>
  }
  openExternal(url: string): Promise<void>
}
