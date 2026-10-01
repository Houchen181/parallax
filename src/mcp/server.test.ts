import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { TEST_KEY, startMockServer, type MockServer } from '../../scripts/mock-llm-server.mjs'
import { KeyStore } from '../main/backend'
import { plainSeal } from '../server/system'
import { createParallaxServer, type ParallaxServer, type ParallaxServerOptions } from './server'

let mock: MockServer
let dir: string
const open: Array<{ parallax: ParallaxServer; client: Client }> = []

// Nothing on these ports, so the local providers count as not running.
const CLOSED = 'http://127.0.0.1:9/v1'

function baseEnv(): NodeJS.ProcessEnv {
  return {
    PARALLAX_ANTHROPIC_BASE_URL: mock.origin,
    PARALLAX_ANTHROPIC_API_KEY: TEST_KEY,
    PARALLAX_OPENAI_BASE_URL: `${mock.origin}/v1`,
    PARALLAX_OPENAI_API_KEY: TEST_KEY,
    PARALLAX_OLLAMA_BASE_URL: CLOSED,
    PARALLAX_LMSTUDIO_BASE_URL: CLOSED,
  }
}

async function connect(options: ParallaxServerOptions & { clientName?: string } = {}) {
  const { clientName = 'parallax-test', ...serverOptions } = options
  const dataDir = serverOptions.dataDir ?? (await mkdtemp(join(dir, 'data-')))
  const parallax = createParallaxServer({ env: baseEnv(), dataDir, openUrl: async () => undefined, waitMs: 20_000, ...serverOptions })
  const client = new Client({ name: clientName, version: '1.0.0' })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await parallax.server.connect(serverSide)
  await client.connect(clientSide)
  open.push({ parallax, client })
  return { parallax, client, dataDir }
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
  const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
  return { text, isError: result.isError === true }
}

beforeAll(async () => {
  mock = await startMockServer({ port: 0 })
  dir = await mkdtemp(join(tmpdir(), 'parallax-mcp-'))
})

afterEach(async () => {
  for (const { parallax, client } of open.splice(0)) {
    await client.close()
    await parallax.close()
  }
})

afterAll(async () => {
  await mock.close()
  await rm(dir, { recursive: true, force: true })
})

describe('Parallax MCP server', () => {
  it('offers the five tools', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['ask_models', 'configure_keys', 'get_results', 'group_discussion', 'list_models'])
    expect(client.getInstructions()).toContain('Never ask the user to paste an API key')
  })

  it('lists models from the configured providers and says what is missing', async () => {
    const { client } = await connect()
    const { text } = await call(client, 'list_models')
    expect(text).toContain('anthropic:mock-claude')
    expect(text).toContain('openai:mock-gpt')
    expect(text).toContain('key from the plugin settings')
    expect(text).toMatch(/Not set up: .*gemini \(no API key\)/)
    expect(text).toMatch(/Not running on this computer: .*ollama/)
    expect(text).not.toContain('demo:demo-concise')

    const filtered = await call(client, 'list_models', { search: 'slow' })
    expect(filtered.text).toContain('openai:mock-gpt-slow')
    expect(filtered.text).not.toContain('anthropic:')
  })

  it('asks several models in parallel and returns every answer', async () => {
    const { client } = await connect()
    const { text, isError } = await call(client, 'ask_models', {
      prompt: 'Name a prime number.',
      models: ['anthropic:mock-claude', 'mock-gpt', 'openai:mock-gpt'],
    })
    expect(isError).toBe(false)
    expect(text).toContain('3 of 3 models finished')
    expect(text).toContain('<answer model="anthropic:mock-claude" name="Mock Claude"')
    expect(text).toContain('This is **mock-claude**, a mock model.')
    expect(text).toContain('This is **mock-gpt**, a mock model.')
    expect(text).toContain('> Name a prime number.')
    // A bare id with no obvious provider is reported, not guessed.
    expect(text).toContain('<answer model="mock-gpt" name="mock-gpt" status="error">')
    expect(text).toContain('Write it as provider:model')
  })

  it('reports provider errors per model and flags a call where every model failed', async () => {
    const { client } = await connect()
    const { text, isError } = await call(client, 'ask_models', { prompt: 'Hi', models: ['openai:mock-error'] })
    expect(isError).toBe(true)
    expect(text).toContain('status="error"')
    expect(text).toContain('The mock server was asked to fail.')

    const unset = await call(client, 'ask_models', { prompt: 'Hi', models: ['gemini:gemini-3-pro'] })
    expect(unset.isError).toBe(true)
    expect(unset.text).toContain('Google Gemini (gemini) no API key')
    expect(unset.text).toContain('configure_keys')
  })

  it('returns partial results when the wait runs out, and get_results collects the rest', async () => {
    // mock-gpt takes about 0.7 s, mock-gpt-slow about 3 s.
    const { client } = await connect({ waitMs: 1500 })
    const first = await call(client, 'ask_models', { prompt: 'Slow please', models: ['openai:mock-gpt', 'openai:mock-gpt-slow'] })
    expect(first.text).toContain('1 of 2 models finished')
    expect(first.text).toContain('This is **mock-gpt**')
    const jobId = /job_id "([0-9a-f]+)"/.exec(first.text)?.[1]
    expect(jobId).toBeTruthy()
    expect(first.text).toContain('Still answering: mock-gpt-slow')

    let rest = await call(client, 'get_results', { job_id: jobId })
    for (let i = 0; i < 20 && rest.text.includes('Still answering'); i++) rest = await call(client, 'get_results', { job_id: jobId })
    expect(rest.text).toContain('2 of 2 models finished (1 returned earlier)')
    expect(rest.text).toContain('This is **mock-gpt-slow**')
    expect(rest.text).not.toContain('This is **mock-gpt**,')

    // Without a job id, the latest job is used.
    expect((await call(client, 'get_results')).text).toContain('Nothing new')
    expect((await call(client, 'get_results', { job_id: 'nope' })).isError).toBe(true)
  })

  it('can stop a running job', async () => {
    const { client } = await connect({ waitMs: 200 })
    const first = await call(client, 'ask_models', { prompt: 'Take your time', models: ['openai:mock-gpt-slow'] })
    const jobId = /job_id "([0-9a-f]+)"/.exec(first.text)?.[1]
    const stopped = await call(client, 'get_results', { job_id: jobId, stop: true })
    expect(stopped.text).toContain('status="stopped"')
  })

  it('runs a group discussion where each model sees the others', async () => {
    const { client } = await connect()
    const { text, isError } = await call(client, 'group_discussion', {
      topic: 'Tabs or spaces?',
      participants: [{ model: 'anthropic:mock-claude' }, { model: 'openai:mock-gpt', name: 'Skeptic', persona: 'Disagree politely.' }],
      rounds: 2,
    })
    expect(isError).toBe(false)
    expect(text).toContain('4 of 4 turns, finished')
    expect(text.match(/<turn /g)).toHaveLength(4)
    expect(text).toContain('<turn round="1" model="anthropic:mock-claude" name="Mock Claude"')
    expect(text).toContain('<turn round="2" model="openai:mock-gpt" name="Skeptic"')
    // Each participant is told who it is, and hears the previous speaker by name.
    expect(text).toContain('Speaking as **Mock Claude**')
    expect(text).toContain('Speaking as **Skeptic**')
    expect(text).toContain('[Mock Claude]: Speaking as **Mock Claude**')
  })

  it('says when nothing is reachable, and points Claude Code at subagents for Claude models', async () => {
    const env = { PARALLAX_OLLAMA_BASE_URL: CLOSED, PARALLAX_LMSTUDIO_BASE_URL: CLOSED }
    const inClaudeCode = await connect({ env, clientName: 'claude-code' })
    const listed = await call(inClaudeCode.client, 'list_models')
    expect(listed.text).toContain('No provider can be reached yet')
    expect(listed.text).toContain('parallax:panelist')

    const asked = await call(inClaudeCode.client, 'ask_models', { prompt: 'Hi', models: ['anthropic:claude-opus-5-5'] })
    expect(asked.isError).toBe(true)
    expect(asked.text).toContain('parallax:panelist')
    expect(asked.text).toContain('No provider has an API key yet')
    expect(asked.text).toContain('Without a key, if they\'re running: ollama, lmstudio')

    // Other hosts have no Claude subagents to offer.
    const elsewhere = await connect({ env, clientName: 'codex-mcp-client' })
    expect((await call(elsewhere.client, 'list_models')).text).not.toContain('panelist')
  })

  it('refuses a discussion with a participant it cannot reach', async () => {
    const { client } = await connect()
    const { text, isError } = await call(client, 'group_discussion', {
      topic: 'Hi',
      participants: [{ model: 'anthropic:mock-claude' }, { model: 'xai:grok-9' }],
    })
    expect(isError).toBe(true)
    expect(text).toContain('xAI (xai) no API key')
  })

  it('uses keys from the key page, standard variables, and ignores unexpanded placeholders', async () => {
    const dataDir = await mkdtemp(join(dir, 'data-'))
    const keys = new KeyStore(join(dataDir, 'api-keys.json'), plainSeal.seal, plainSeal.unseal)
    await keys.set('anthropic', TEST_KEY, mock.origin)
    // Saved for the real OpenAI API, so it must not be sent to the mock server.
    await keys.set('openai', TEST_KEY, 'https://api.openai.com/v1')
    const env = {
      ...baseEnv(),
      PARALLAX_ANTHROPIC_API_KEY: '${user_config.anthropic_api_key}',
      PARALLAX_OPENAI_API_KEY: '',
      PARALLAX_GEMINI_API_KEY: '${user_config.gemini_api_key}',
      OPENROUTER_API_KEY: TEST_KEY,
      PARALLAX_OPENROUTER_BASE_URL: `${mock.origin}/v1`,
    }
    const { client } = await connect({ env, dataDir })
    const { text } = await call(client, 'list_models')
    expect(text).toMatch(/Anthropic \[anthropic\]: ready, key from the Parallax key page/)
    expect(text).toContain(`openai (the saved key is for https://api.openai.com, not ${mock.origin})`)
    expect(text).toMatch(/OpenRouter \[openrouter\]: ready, key from the OPENROUTER_API_KEY environment variable/)
    expect(text).toMatch(/gemini \(no API key\)/)

    const answer = await call(client, 'ask_models', { prompt: 'Hi', models: ['anthropic:mock-claude', 'openrouter:mock-gpt'] })
    expect(answer.text).toContain('This is **mock-claude**')
    expect(answer.text).toContain('This is **mock-gpt**')
  })

  it('serves a key page that saves keys without ever sending them back', async () => {
    let opened = ''
    const env = { ...baseEnv(), PARALLAX_OPENAI_API_KEY: undefined }
    const { client, dataDir } = await connect({ env, openUrl: async (url) => void (opened = url) })
    const result = await call(client, 'configure_keys', { provider: 'openai' })
    expect(result.text).toContain('Opened the Parallax key page')
    const url = new URL(opened)
    expect(url.hostname).toBe('127.0.0.1')
    expect(url.hash).toBe('#provider=openai')
    const token = url.searchParams.get('token')!
    const base = url.origin

    const page = await fetch(base)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")

    const api = (route: string, body?: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-parallax-token': token, 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      })

    expect((await api('state', undefined, { 'x-parallax-token': 'wrong' })).status).toBe(403)
    expect((await api('state', undefined, { origin: 'https://evil.example' })).status).toBe(403)
    const rebind = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: Number(url.port), path: '/api/state', headers: { host: 'evil.example', 'x-parallax-token': token } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })
    expect(rebind).toBe(403)

    const before = await (await api('state')).json()
    expect(before.providers.find((p: { id: string }) => p.id === 'openai')).toMatchObject({ ready: false, saved: false })

    const saved = await api('save', { providerId: 'openai', key: TEST_KEY })
    expect(saved.status).toBe(200)
    const savedBody = await saved.text()
    expect(savedBody).not.toContain(TEST_KEY)
    expect(JSON.parse(savedBody).test).toEqual({ ok: true, count: 3 })

    const file = JSON.parse(await readFile(join(dataDir, 'api-keys.json'), 'utf8'))
    expect(file.openai.origin).toBe(mock.origin)
    expect((await call(client, 'list_models', { provider: 'openai' })).text).toContain('key from the Parallax key page')

    const custom = await api('save', { providerId: 'custom-openai', key: '', baseUrl: 'ftp://example.com' })
    expect(custom.status).toBe(400)
    expect((await api('save', { providerId: 'chatgpt', key: 'x' })).status).toBe(400)

    await api('remove', { providerId: 'openai' })
    expect(JSON.parse(await readFile(join(dataDir, 'api-keys.json'), 'utf8')).openai).toBeUndefined()
  })
})
