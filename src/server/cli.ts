// `npm run serve`: runs the Parallax web app on this computer, with a local back
// end so Sign in with ChatGPT and every provider work in the browser.
//
//   --port <n>      port to listen on (default 4747; chats are stored per address)
//   --no-open       don't open the browser
//   --static <dir>  built web app to serve (default: dist/web)
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { KeyStore } from '../main/backend'
import { ChatGPTAuth, OPENAI_API_BASE, OPENAI_ISSUER } from '../main/chatgpt'
import { startLocalServer } from './local-server'
import { adoptLegacyData, legacyDataDir, localDataDir, openInBrowser, plainSeal as plain } from './system'

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const port = Number(argValue('--port') ?? process.env.PORT ?? 4747)
  const staticDir = resolve(argValue('--static') ?? join(__dirname, '..', 'web'))
  if (!existsSync(join(staticDir, 'index.html'))) {
    console.error(`No built web app in ${staticDir}. Run "npm run build:web" first (npm run serve does this for you).`)
    process.exit(1)
  }
  const dir = localDataDir()
  await adoptLegacyData(dir, legacyDataDir())
  const keys = new KeyStore(join(dir, 'api-keys.json'), plain.seal, plain.unseal)
  await keys.load()
  const chatgpt = new ChatGPTAuth({
    dataDir: dir,
    ...plain,
    appName: 'Parallax',
    issuer: process.env.PARALLAX_CHATGPT_ISSUER || OPENAI_ISSUER,
    apiBase: process.env.PARALLAX_CHATGPT_API || OPENAI_API_BASE,
    openUrl: openInBrowser,
  })
  await chatgpt.load()

  let server
  try {
    server = await startLocalServer({ staticDir, port, keys, chatgpt, openUrl: openInBrowser })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Is Parallax already running? Otherwise pick another port with --port.`)
      process.exit(1)
    }
    throw err
  }
  console.log(`\nParallax is running at ${server.url}`)
  console.log(`Keys and ChatGPT sign-ins are stored in ${dir}`)
  console.log('Press Ctrl+C to stop.\n')
  if (!process.argv.includes('--no-open')) await openInBrowser(server.url)

  const stop = () => {
    void server.close().then(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
