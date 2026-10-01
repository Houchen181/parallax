// Entry point of the bundled plugin server (plugins/parallax/server/parallax-mcp.cjs).
// Hosts start it with `node parallax-mcp.cjs` and talk MCP over stdin/stdout, so
// nothing else may be written to stdout.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createParallaxServer } from './server'

async function main() {
  if (process.argv.includes('--version')) {
    console.log(__APP_VERSION__)
    return
  }
  // One failed request must not take the whole server down. stderr ends up in the host's MCP log.
  process.on('unhandledRejection', (reason) => console.error('Parallax: unhandled rejection:', reason))
  const parallax = createParallaxServer()
  let closing = false
  const shutdown = () => {
    if (closing) return
    closing = true
    void parallax.close().finally(() => process.exit(0))
  }
  parallax.server.server.onclose = shutdown
  process.stdin.on('end', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  await parallax.server.connect(new StdioServerTransport())
}

main().catch((err: unknown) => {
  console.error('Parallax MCP server failed to start:', err)
  process.exit(1)
})
