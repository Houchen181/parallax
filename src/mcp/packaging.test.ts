// Checks the plugin packages (Claude Code, Codex, Claude Desktop) against each
// other and runs the bundled server the way the hosts do: `node <file>` over stdio.
//
// Layout, worked out against Claude Code 2.1 and Codex 0.130 and 0.159:
// - Codex reads plugins/parallax: plugin.json + mcp.json (Agent Plugins), and
//   .codex-plugin/plugin.json + codex-mcp.json for builds that predate it.
// - Claude Code's manifest lives in the marketplace entry. Codex also reads
//   .claude-plugin/plugin.json and .mcp.json in a plugin folder, so neither may exist there.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { build } from 'esbuild'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TEST_KEY, startMockServer, type MockServer } from '../../scripts/mock-llm-server.mjs'
import { pluginBuildOptions } from '../../scripts/plugin-options.mjs'

const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'))

const pkg = json('package.json')
const claudeMarket = json('.claude-plugin/marketplace.json')
const claudePlugin = claudeMarket.plugins[0]
const codexPlugin = json('plugins/parallax/plugin.json')
const codexMcp = json('plugins/parallax/mcp.json')
const codexOverlay = json('plugins/parallax/.codex-plugin/plugin.json')
const codexOverlayMcp = json('plugins/parallax/codex-mcp.json')
const mcpb = json('mcpb/manifest.json')
const codexMarket = json('.agents/plugins/marketplace.json')

const TOOLS = ['ask_models', 'configure_keys', 'get_results', 'group_discussion', 'list_models']

describe('plugin packages', () => {
  it('share the app version and name', () => {
    for (const manifest of [claudePlugin, codexPlugin, codexOverlay, mcpb]) {
      expect(manifest.version).toBe(pkg.version)
      expect(manifest.name).toBe('parallax')
    }
    expect(claudePlugin.source).toBe('./plugins/parallax')
    expect(codexMarket.plugins[0]).toMatchObject({ name: 'parallax', source: { source: 'local', path: './plugins/parallax' } })
    expect(codexOverlay.interface).toEqual(codexPlugin.extensions['com.openai'].interface)
  })

  it("keep Claude Code's files out of the plugin folder, where Codex would read them", () => {
    expect(existsSync('plugins/parallax/.claude-plugin')).toBe(false)
    expect(existsSync('plugins/parallax/.mcp.json')).toBe(false)
  })

  it('run the same bundled server', () => {
    expect(claudePlugin.mcpServers.parallax.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/server/parallax-mcp.cjs'])
    expect(codexMcp.mcpServers.parallax).toEqual({ type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/server/parallax-mcp.cjs'] })
    expect(codexOverlay.mcpServers).toBe('./codex-mcp.json')
    expect(codexOverlayMcp.mcpServers.parallax).toEqual({ command: 'node', args: ['./server/parallax-mcp.cjs'], cwd: '.' })
    expect(mcpb.server.entry_point).toBe('server/parallax-mcp.cjs')
    expect(mcpb.server.mcp_config.args).toEqual(['${__dirname}/server/parallax-mcp.cjs'])
  })

  it('pass every setting to the server under the variable it reads', () => {
    const expected = {
      PARALLAX_ANTHROPIC_API_KEY: '${user_config.anthropic_api_key}',
      PARALLAX_OPENAI_API_KEY: '${user_config.openai_api_key}',
      PARALLAX_GEMINI_API_KEY: '${user_config.gemini_api_key}',
      PARALLAX_OPENROUTER_API_KEY: '${user_config.openrouter_api_key}',
      PARALLAX_DEFAULT_MODELS: '${user_config.default_models}',
    }
    expect(claudePlugin.mcpServers.parallax.env).toMatchObject(expected)
    expect(mcpb.server.mcp_config.env).toEqual(expected)
    const keys = Object.values(expected).map((v) => /user_config\.(\w+)/.exec(v)![1]).sort()
    expect(Object.keys(claudePlugin.userConfig).sort()).toEqual(keys)
    expect(Object.keys(mcpb.user_config).sort()).toEqual(keys)
    for (const [key, option] of Object.entries<Record<string, unknown>>(claudePlugin.userConfig)) {
      expect(option.sensitive === true).toBe(key.endsWith('_api_key'))
      expect(mcpb.user_config[key].sensitive === true).toBe(key.endsWith('_api_key'))
    }
  })

  it('list the tools the server registers', () => {
    expect(mcpb.tools.map((t: { name: string }) => t.name).sort()).toEqual(TOOLS)
  })

  it('ship the panelist subagent that the skill names', () => {
    const agent = readFileSync('plugins/parallax/agents/panelist.md', 'utf8')
    expect(agent).toMatch(/^---\nname: panelist\n/)
    expect(agent).toMatch(/\ntools: Read, Grep, Glob\n/)
    expect(readFileSync('plugins/parallax/skills/parallax/SKILL.md', 'utf8')).toContain('parallax:panelist')
  })
})

describe('bundled server over stdio', () => {
  let mock: MockServer
  let dir: string
  let client: Client

  beforeAll(async () => {
    mock = await startMockServer({ port: 0 })
    dir = await mkdtemp(join(tmpdir(), 'parallax-bundle-'))
    const outfile = join(dir, 'parallax-mcp.cjs')
    await build({ ...pluginBuildOptions, outfile, logLevel: 'silent' })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [outfile],
      env: {
        ...getDefaultEnvironment(),
        PARALLAX_DATA_DIR: join(dir, 'data'),
        PARALLAX_ANTHROPIC_BASE_URL: mock.origin,
        PARALLAX_ANTHROPIC_API_KEY: TEST_KEY,
        PARALLAX_OLLAMA_BASE_URL: 'http://127.0.0.1:9/v1',
        PARALLAX_LMSTUDIO_BASE_URL: 'http://127.0.0.1:9/v1',
      },
      stderr: 'pipe',
    })
    client = new Client({ name: 'parallax-test', version: '1.0.0' })
    await client.connect(transport)
  }, 60_000)

  afterAll(async () => {
    await client?.close()
    await mock?.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('starts, reports its version and answers a tool call', async () => {
    expect(client.getServerVersion()).toMatchObject({ name: 'parallax', version: pkg.version })
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(TOOLS)
    const result = (await client.callTool({ name: 'ask_models', arguments: { prompt: 'Hello', models: ['anthropic:mock-claude'] } })) as CallToolResult
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    expect(text).toContain('This is **mock-claude**')
  })
})
