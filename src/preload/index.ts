import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ChatGPTAccount, ChatGPTSignInResult, HttpEvent, ParallaxBridge, SavedKeyInfo } from '../shared/bridge'

const bridge: ParallaxBridge = {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
  },
  keys: {
    list: () => ipcRenderer.invoke('keys:list') as Promise<SavedKeyInfo[]>,
    set: (providerId, key, baseUrl) => ipcRenderer.invoke('keys:set', providerId, key, baseUrl),
    remove: (providerId) => ipcRenderer.invoke('keys:remove', providerId),
  },
  http: {
    start: (request) => ipcRenderer.invoke('http:start', request),
    abort: (id) => ipcRenderer.invoke('http:abort', id),
    onEvent: (listener) => {
      const handler = (_event: IpcRendererEvent, payload: HttpEvent) => listener(payload)
      ipcRenderer.on('http:event', handler)
      return () => {
        ipcRenderer.removeListener('http:event', handler)
      }
    },
  },
  chatgpt: {
    apiBase: () => ipcRenderer.invoke('chatgpt:apiBase') as Promise<string>,
    accounts: () => ipcRenderer.invoke('chatgpt:accounts') as Promise<ChatGPTAccount[]>,
    signIn: (providerId, options) => ipcRenderer.invoke('chatgpt:signIn', providerId, options) as Promise<ChatGPTSignInResult>,
    cancelSignIn: () => ipcRenderer.invoke('chatgpt:cancelSignIn'),
    signOut: (providerId) => ipcRenderer.invoke('chatgpt:signOut', providerId) as Promise<{ revoked: boolean }>,
    forget: (providerId) => ipcRenderer.invoke('chatgpt:forget', providerId),
  },
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
}

contextBridge.exposeInMainWorld('parallax', bridge)
