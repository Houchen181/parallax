import type { ParallaxBridge } from '../../shared/bridge'

declare global {
  const __APP_VERSION__: string

  interface Window {
    /** Present only inside the desktop app. */
    parallax?: ParallaxBridge
  }
}

export {}
