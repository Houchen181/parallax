// Development runner: Vite serves the renderer with hot reload, esbuild watches
// the main and preload sources, and Electron restarts when either changes.
import { spawn } from 'node:child_process'
import { context } from 'esbuild'
import { createServer } from 'vite'
import electronPath from 'electron'
import { electronBuildOptions } from './electron-options.mjs'

const server = await createServer({ mode: 'development' })
await server.listen()
const url = server.resolvedUrls?.local[0]
if (!url) throw new Error('Vite did not report a local URL')
server.printUrls()

let child = null
let restarting = false

function startElectron() {
  child = spawn(electronPath, ['.'], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: url, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  })
  child.on('exit', (code) => {
    if (!restarting) {
      void shutdown(code ?? 0)
    }
  })
}

function restartElectron() {
  if (child) {
    restarting = true
    child.once('exit', () => {
      restarting = false
      startElectron()
    })
    child.kill()
  } else {
    startElectron()
  }
}

const ctx = await context({
  ...electronBuildOptions,
  plugins: [
    {
      name: 'restart-electron',
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length === 0) restartElectron()
        })
      },
    },
  ],
})
await ctx.watch()

async function shutdown(code) {
  await ctx.dispose()
  await server.close()
  process.exit(code)
}

process.on('SIGINT', () => {
  restarting = true
  child?.kill()
  void shutdown(0)
})
