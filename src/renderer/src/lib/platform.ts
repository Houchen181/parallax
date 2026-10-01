import type { ParallaxBridge } from '../../../shared/bridge'

export const bridge: ParallaxBridge | undefined = typeof window !== 'undefined' ? window.parallax : undefined
export const isDesktop = Boolean(bridge?.isDesktop)

export const REPO_URL = 'https://github.com/Houchen181/parallax'

export function openExternal(url: string) {
  if (bridge) void bridge.openExternal(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}

export function newId(): string {
  return crypto.randomUUID()
}
