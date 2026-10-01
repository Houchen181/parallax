// Helpers for the Node programs that run outside Electron: the local web
// version (`npm run serve`) and the plugin's MCP server. Both use the same
// data folder, so keys saved in one are available in the other.
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Sealed } from '../main/chatgpt'

/** Kept apart from the desktop app's folder, whose files are encrypted with Electron's keys. */
export function localDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PARALLAX_DATA_DIR) return env.PARALLAX_DATA_DIR
  if (process.platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Parallax Local')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Parallax Local')
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'parallax-local')
}

/** Opens a URL in the default browser. Resolves once the launcher has started (or failed to). */
export function openInBrowser(url: string): Promise<void> {
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  return new Promise((done) => {
    try {
      const child = spawn(command, args as string[], { detached: true, stdio: 'ignore' })
      child.on('error', () => done())
      child.unref()
    } catch {
      // No browser launcher available; callers also show the URL.
    }
    done()
  })
}

// Credentials are stored in a file only this user account can read, the way
// OpenAI's docs describe for open-source clients (no OS keychain is involved).
export const plainSeal = {
  seal: (text: string): Sealed => ({ data: Buffer.from(text, 'utf8').toString('base64'), encrypted: false }),
  unseal: (sealed: Sealed) => Buffer.from(sealed.data, 'base64').toString('utf8'),
}
