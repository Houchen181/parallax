import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BrowserWindow,
  Menu,
  app,
  ipcMain,
  nativeTheme,
  net,
  safeStorage,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'
import type { HttpEvent, HttpRequest, SavedKeyInfo } from '../shared/bridge'
import { ChatGPTAuth, ChatGPTError, OPENAI_API_BASE, OPENAI_ISSUER, type Sealed } from './chatgpt'

const devServerUrl = process.env.VITE_DEV_SERVER_URL
const REPO_URL = 'https://github.com/Houchen181/parallax'

// Lets tests and screenshot runs use a throwaway profile.
if (process.env.PARALLAX_USER_DATA) app.setPath('userData', process.env.PARALLAX_USER_DATA)

// ---------------------------------------------------------------------------
// API keys: encrypted with the OS (DPAPI on Windows) and bound to one origin,
// so a key saved for api.openai.com can never be attached to another host.
// ---------------------------------------------------------------------------

interface StoredKey {
  data: string
  encrypted: boolean
  origin: string
}

let keys: Record<string, StoredKey> = {}
const keysFile = () => join(app.getPath('userData'), 'api-keys.json')

async function loadKeys() {
  try {
    keys = JSON.parse(await readFile(keysFile(), 'utf8')) as Record<string, StoredKey>
  } catch {
    keys = {}
  }
}

async function persistKeys() {
  const tmp = `${keysFile()}.tmp`
  await writeFile(tmp, JSON.stringify(keys, null, 2), { mode: 0o600 })
  await rename(tmp, keysFile())
}

function seal(plain: string): Sealed {
  if (safeStorage.isEncryptionAvailable()) {
    return { data: safeStorage.encryptString(plain).toString('base64'), encrypted: true }
  }
  return { data: Buffer.from(plain, 'utf8').toString('base64'), encrypted: false }
}

function unseal(stored: Sealed): string {
  const buf = Buffer.from(stored.data, 'base64')
  return stored.encrypted ? safeStorage.decryptString(buf) : buf.toString('utf8')
}

// ---------------------------------------------------------------------------
// Sign in with ChatGPT (plan usage). The PARALLAX_CHATGPT_* variables point it
// at a local mock server for tests; they are never set in normal use.
// ---------------------------------------------------------------------------

let chatgpt: ChatGPTAuth

function createChatGPTAuth(): ChatGPTAuth {
  const fetchViaElectron = ((input: string | URL | Request, init?: RequestInit) =>
    net.fetch(typeof input === 'string' ? input : input instanceof URL ? input.href : input, init)) as typeof fetch
  return new ChatGPTAuth({
    dataDir: app.getPath('userData'),
    seal,
    unseal,
    appName: 'Parallax',
    issuer: process.env.PARALLAX_CHATGPT_ISSUER || OPENAI_ISSUER,
    apiBase: process.env.PARALLAX_CHATGPT_API || OPENAI_API_BASE,
    fetch: fetchViaElectron,
    openUrl:
      process.env.PARALLAX_CHATGPT_OPEN === 'fetch'
        ? async (url) => {
            await fetch(url)
          }
        : (url) => shell.openExternal(url),
  })
}

// ---------------------------------------------------------------------------
// IPC: only our own renderer may call these.
// ---------------------------------------------------------------------------

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? ''
  return devServerUrl ? url.startsWith(devServerUrl) : url.startsWith('file://')
}

function handle(channel: string, fn: (event: IpcMainInvokeEvent, ...args: never[]) => unknown) {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!isTrustedSender(event)) throw new Error('Blocked IPC call from an untrusted page')
    return fn(event, ...(args as never[]))
  })
}

function registerIpc() {
  handle('keys:list', (): SavedKeyInfo[] =>
    Object.entries(keys).map(([providerId, k]) => ({ providerId, origin: k.origin, encrypted: k.encrypted })),
  )

  handle('keys:set', async (_event, providerId: string, key: string, baseUrl: string) => {
    if (typeof providerId !== 'string' || !providerId) throw new Error('Missing provider id')
    if (typeof key !== 'string' || !key.trim()) throw new Error('The API key is empty')
    const origin = new URL(baseUrl).origin
    keys[providerId] = { ...seal(key.trim()), origin }
    await persistKeys()
  })

  handle('keys:remove', async (_event, providerId: string) => {
    delete keys[providerId]
    await persistKeys()
  })

  handle('http:start', (event, request: HttpRequest) => {
    const controller = new AbortController()
    inflight.set(request.id, controller)
    void runRequest(event.sender, request, controller)
  })

  handle('http:abort', (_event, id: string) => {
    inflight.get(id)?.abort()
  })

  handle('shell:openExternal', (_event, url: string) => openExternalSafe(url))

  handle('chatgpt:apiBase', () => chatgpt.apiBaseUrl)
  handle('chatgpt:accounts', () => chatgpt.accounts())
  handle('chatgpt:signIn', async (_event, providerId: string, options?: { enablePlan?: boolean }) => {
    const result = await chatgpt.signIn(providerId, options)
    // The user finished in the browser; bring Parallax back to the front.
    if (mainWindow && !process.env.PARALLAX_HIDDEN) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
    return result
  })
  handle('chatgpt:cancelSignIn', () => chatgpt.cancelSignIn())
  handle('chatgpt:signOut', (_event, providerId: string) => chatgpt.signOut(providerId))
  handle('chatgpt:forget', (_event, providerId: string) => chatgpt.forget(providerId))
}

// ---------------------------------------------------------------------------
// Streaming HTTP on behalf of the renderer. Requests run here so that keys stay
// in the main process and providers without browser CORS support still work.
// ---------------------------------------------------------------------------

const inflight = new Map<string, AbortController>()
const DROPPED_HEADERS = new Set(['host', 'content-length', 'connection', 'origin', 'referer'])

async function runRequest(sender: WebContents, request: HttpRequest, controller: AbortController) {
  const send = (event: HttpEvent) => {
    if (!sender.isDestroyed()) sender.send('http:event', event)
  }
  try {
    const url = new URL(request.url)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`Unsupported URL scheme: ${url.protocol}`)
    }
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
      const stored = keys[request.auth.providerId]
      if (!stored) throw new Error('No API key is saved for this provider. Add one in Settings → Providers.')
      if (stored.origin !== url.origin) {
        throw new Error(
          `The saved API key is locked to ${stored.origin}. Save the key again after changing the base URL.`,
        )
      }
      headers[request.auth.header.toLowerCase()] = (request.auth.prefix ?? '') + unseal(stored)
    }

    const response = await net.fetch(url.href, {
      method: request.method,
      headers,
      body: request.body,
      signal: controller.signal,
    })
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, name) => {
      responseHeaders[name] = value
    })
    send({
      id: request.id,
      type: 'head',
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })

    if (response.body) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        if (chunk) send({ id: request.id, type: 'data', chunk })
      }
      const tail = decoder.decode()
      if (tail) send({ id: request.id, type: 'data', chunk: tail })
    }
    send({ id: request.id, type: 'end' })
  } catch (err) {
    send({
      id: request.id,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      aborted: controller.signal.aborted,
      code: err instanceof ChatGPTError ? err.code : undefined,
    })
  } finally {
    inflight.delete(request.id)
  }
}

async function openExternalSafe(url: string) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:') {
      await shell.openExternal(parsed.href)
    }
  } catch {
    // Ignore malformed URLs.
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 860,
    minHeight: 560,
    title: 'Parallax',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#212121' : '#ffffff',
    icon: app.isPackaged ? undefined : join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  })
  mainWindow = win

  win.once('ready-to-show', () => {
    if (!process.env.PARALLAX_CAPTURE && !process.env.PARALLAX_HIDDEN) win.show()
  })

  // Links in model output open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalSafe(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL()
    if (url.split('#')[0] !== current.split('#')[0]) {
      event.preventDefault()
      void openExternalSafe(url)
    }
  })

  const query = process.env.PARALLAX_QUERY
  if (devServerUrl) {
    void win.loadURL(query ? `${devServerUrl}?${query}` : devServerUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), query ? { search: query } : undefined)
  }

  if (process.env.PARALLAX_CAPTURE) void captureAndQuit(win, process.env.PARALLAX_CAPTURE)

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
}

// Screenshot mode used to produce the README images: render offscreen, save, exit.
async function captureAndQuit(win: BrowserWindow, file: string) {
  const delay = Number(process.env.PARALLAX_CAPTURE_DELAY ?? 6000)
  await new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve()))
  await new Promise((resolve) => setTimeout(resolve, delay))
  const image = await win.webContents.capturePage()
  await writeFile(file, image.toPNG())
  app.quit()
}

function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Parallax on GitHub', click: () => void openExternalSafe(REPO_URL) },
        { label: 'Report an issue', click: () => void openExternalSafe(`${REPO_URL}/issues`) },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId('io.github.houchen181.parallax')
    await loadKeys()
    chatgpt = createChatGPTAuth()
    await chatgpt.load()
    registerIpc()
    buildMenu()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
