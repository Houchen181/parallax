import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')) as { version: string }

// The desktop renderer never talks to the network directly (the main process
// does), so its policy is strict. The web build calls providers from the page.
const CSP = {
  desktop:
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'",
  web:
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'",
}

function contentSecurityPolicy(mode: string): Plugin {
  return {
    name: 'parallax-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const policy = mode === 'web' ? CSP.web : CSP.desktop
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`)
    },
  }
}

export default defineConfig(({ mode }) => {
  const web = mode === 'web'
  return {
    root: resolve(import.meta.dirname, 'src/renderer'),
    base: web ? (process.env.BASE_PATH ?? '/parallax/') : './',
    plugins: [react(), tailwindcss(), contentSecurityPolicy(mode)],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    build: {
      outDir: resolve(import.meta.dirname, web ? 'dist/web' : 'dist/renderer'),
      emptyOutDir: true,
      chunkSizeWarningLimit: 4000,
    },
    server: {
      port: 5173,
      strictPort: true,
    },
  }
})
