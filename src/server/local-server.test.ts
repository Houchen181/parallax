import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TEST_KEY, startMockServer, type MockServer } from '../../scripts/mock-llm-server.mjs'
import { KeyStore } from '../main/backend'
import { ChatGPTAuth, type Sealed } from '../main/chatgpt'
import { startLocalServer, type LocalServer } from './local-server'

let mock: MockServer
let server: LocalServer
let dir: string
let token = ''

const plain = {
  seal: (text: string): Sealed => ({ data: Buffer.from(text).toString('base64'), encrypted: false }),
  unseal: (sealed: Sealed) => Buffer.from(sealed.data, 'base64').toString(),
}

function api(route: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  return fetch(`${server.url}api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-parallax-token': token, 'content-type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** A raw request, for headers fetch won't let us set (Host) and paths it would normalize. */
function raw(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.port, path, headers }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  mock = await startMockServer({ port: 0 })
  dir = await mkdtemp(join(tmpdir(), 'parallax-local-'))
  const web = join(dir, 'web')
  await mkdir(join(web, 'assets'), { recursive: true })
  await writeFile(join(web, 'index.html'), '<!doctype html><html><head><title>Parallax</title></head><body></body></html>')
  await writeFile(join(web, 'assets', 'app.js'), 'console.log(1)')
  await writeFile(join(dir, 'secret.txt'), 'outside the web folder')

  const keys = new KeyStore(join(dir, 'data', 'api-keys.json'), plain.seal, plain.unseal)
  const chatgpt = new ChatGPTAuth({
    dataDir: join(dir, 'data'),
    ...plain,
    appName: 'Parallax',
    issuer: mock.origin,
    apiBase: `${mock.origin}/v1`,
    openUrl: async () => undefined,
  })
  server = await startLocalServer({ staticDir: web, port: 0, keys, chatgpt, openUrl: async () => undefined })
})

afterAll(async () => {
  await server.close()
  await mock.close()
  await rm(dir, { recursive: true, force: true })
})

describe('local web server', () => {
  it('serves the app with a per-launch session token embedded in the page', async () => {
    const html = await (await fetch(server.url)).text()
    const match = /<meta name="parallax-local-token" content="([^"]+)"/.exec(html)
    expect(match).not.toBeNull()
    token = match![1]
    expect((await fetch(`${server.url}assets/app.js`)).status).toBe(200)
  })

  it('refuses API calls without the token, from other origins, or for other host names', async () => {
    expect((await fetch(`${server.url}api/keys`)).status).toBe(403)
    expect((await api('keys', undefined, { 'x-parallax-token': 'wrong' })).status).toBe(403)
    expect((await api('keys', undefined, { origin: 'https://evil.example' })).status).toBe(403)
    expect(await raw('/api/keys', { host: `evil.example:${server.port}`, 'x-parallax-token': token })).toBe(403)
    expect(await raw('/', { host: `evil.example:${server.port}` })).toBe(403)
  })

  it('does not serve files outside the web folder', async () => {
    expect(await raw('/..%2fsecret.txt', { host: `127.0.0.1:${server.port}` })).toBe(403)
  })

  it('stores API keys and attaches them to proxied requests', async () => {
    expect((await api('keys', { providerId: 'mock', key: TEST_KEY, baseUrl: `${mock.origin}/v1` })).status).toBe(200)
    expect(await (await api('keys')).json()).toEqual([{ providerId: 'mock', origin: mock.origin, encrypted: false }])

    const res = await api('proxy', {
      id: 'r1',
      url: `${mock.origin}/v1/chat/completions`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-gpt', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      auth: { providerId: 'mock', header: 'authorization', prefix: 'Bearer ' },
    })
    expect(res.headers.get('x-parallax-status')).toBe('200')
    const body = await res.text()
    expect(body).toContain('mock-gpt')
    expect(body).toContain('[DONE]')
  })

  it('signs in with ChatGPT through a browser tab and proxies plan-funded requests', async () => {
    const start = (await (await api('chatgpt/sign-in/start', { providerId: 'chatgpt' })).json()) as { attempt: string; url: string }
    expect(start.url).toContain('/api/accounts/authorize?')
    await fetch(start.url) // what the browser tab does: approve, then follow the redirect to the loopback callback
    const result = (await (await api('chatgpt/sign-in/wait', { attempt: start.attempt })).json()) as { status: string }
    expect(result.status).toBe('signed-in')
    const accounts = (await (await api('chatgpt/accounts')).json()) as Array<{ signedIn: boolean; planEnabled: boolean }>
    expect(accounts[0]).toMatchObject({ signedIn: true, planEnabled: true })

    const res = await api('proxy', {
      id: 'r2',
      url: `${mock.origin}/v1/responses`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-gpt-plan', input: [{ role: 'user', content: 'hi' }], store: false, stream: true }),
      auth: { providerId: 'chatgpt', header: 'authorization', source: 'chatgpt' },
    })
    expect(res.headers.get('x-parallax-status')).toBe('200')
    expect(await res.text()).toContain('response.completed')
  })

  it('never sends ChatGPT tokens anywhere but the OpenAI API', async () => {
    const res = await api('proxy', {
      id: 'r3',
      url: 'https://example.com/steal',
      method: 'GET',
      headers: {},
      auth: { providerId: 'chatgpt', header: 'authorization', source: 'chatgpt' },
    })
    expect(res.status).toBe(502)
    expect(res.headers.get('x-parallax-error')).toBe('1')
    expect(((await res.json()) as { message: string }).message).toContain('only works with')
  })

  it('signs out and revokes the session', async () => {
    expect(await (await api('chatgpt/sign-out', { providerId: 'chatgpt' })).json()).toEqual({ revoked: true })
    const accounts = (await (await api('chatgpt/accounts')).json()) as Array<{ signedIn: boolean }>
    expect(accounts[0].signedIn).toBe(false)
  })
})
