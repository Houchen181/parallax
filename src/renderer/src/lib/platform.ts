import type { ParallaxBridge } from '../../../shared/bridge'
import { createLocalBridge } from './localBridge'

/**
 * desktop: the Electron app.
 * local: the web app served by `npm run serve` on this computer.
 * web: the static site (GitHub Pages), with no back end.
 */
export type Runtime = 'desktop' | 'local' | 'web'

function detectBridge(): ParallaxBridge | undefined {
  if (typeof window === 'undefined') return undefined
  if (window.parallax) return window.parallax
  const token = document.querySelector<HTMLMetaElement>('meta[name="parallax-local-token"]')?.content
  return token ? createLocalBridge(token) : undefined
}

export const bridge: ParallaxBridge | undefined = detectBridge()
export const runtime: Runtime = bridge?.runtime ?? 'web'
export const isDesktop = runtime === 'desktop'
/** A trusted process on this computer holds keys and tokens (the desktop app or the local server). */
export const hasBackend = runtime !== 'web'

export const REPO_URL = 'https://github.com/Houchen181/parallax'
export const RUN_LOCALLY_URL = `${REPO_URL}#run-the-web-version-on-your-computer`

export function openExternal(url: string) {
  if (bridge) void bridge.openExternal(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}

export function newId(): string {
  return crypto.randomUUID()
}
