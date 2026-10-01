// Helpers for the Node programs that run outside Electron: the local web
// version (`npm run serve`) and the plugin's MCP server. They share one data
// folder, so keys saved in one are available in the other.
import { spawn } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import { copyFile, mkdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Sealed } from '../main/chatgpt'

/**
 * Kept apart from the desktop app's folder, whose files are encrypted with Electron's keys.
 *
 * On Windows this is not under AppData: Microsoft Store apps such as Claude and Codex get a
 * private copy of AppData, and so does every program they start, including the plugin. A
 * folder in the user profile is the same for all of them.
 */
export function localDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PARALLAX_DATA_DIR) return env.PARALLAX_DATA_DIR
  if (process.platform === 'win32') return join(homedir(), '.parallax')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Parallax Local')
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'parallax-local')
}

/** Where versions up to 0.4.0 kept this data on Windows. */
export function legacyDataDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.PARALLAX_DATA_DIR || process.platform !== 'win32') return undefined
  return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Parallax Local')
}

const DATA_FILES = ['api-keys.json', 'providers.json', 'chatgpt.json']

/** Moves keys and sign-ins from the old folder the first time the new one is used. */
export async function adoptLegacyData(dir: string, legacy: string | undefined): Promise<void> {
  if (!legacy || existsSync(dir) || !existsSync(legacy)) return
  await mkdir(dir, { recursive: true })
  for (const name of DATA_FILES) {
    try {
      await copyFile(join(legacy, name), join(dir, name), constants.COPYFILE_EXCL)
    } catch {
      continue // Not there, or another Parallax process copied it first.
    }
    // Don't leave a second copy of the keys behind.
    await unlink(join(legacy, name)).catch(() => undefined)
  }
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
