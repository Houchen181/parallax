// API key storage. On the desktop keys live in the main process, encrypted by the
// OS; the renderer only learns which providers have one. In the browser build
// keys stay in this browser's localStorage and go straight to the provider.
import { bridge } from './platform'

const WEB_KEYS = 'parallax:keys'

function readWebKeys(): Record<string, string> {
  try {
    const raw = localStorage.getItem(WEB_KEYS)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function writeWebKeys(keys: Record<string, string>) {
  localStorage.setItem(WEB_KEYS, JSON.stringify(keys))
}

/** Provider id -> origin the key is locked to (empty string in the browser). */
export async function listSavedKeys(): Promise<Record<string, string>> {
  if (bridge) {
    const saved = await bridge.keys.list()
    return Object.fromEntries(saved.map((k) => [k.providerId, k.origin]))
  }
  return Object.fromEntries(Object.keys(readWebKeys()).map((id) => [id, '']))
}

export async function saveKey(providerId: string, key: string, baseUrl: string): Promise<void> {
  if (bridge) return bridge.keys.set(providerId, key, baseUrl)
  writeWebKeys({ ...readWebKeys(), [providerId]: key.trim() })
}

export async function removeKey(providerId: string): Promise<void> {
  if (bridge) return bridge.keys.remove(providerId)
  const keys = readWebKeys()
  delete keys[providerId]
  writeWebKeys(keys)
}

/** Browser build only: the key to attach to an outgoing request. */
export function webKey(providerId: string): string | undefined {
  return readWebKeys()[providerId]
}
