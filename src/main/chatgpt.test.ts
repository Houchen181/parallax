import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockServer, type MockServer } from '../../scripts/mock-llm-server.mjs'
import { ChatGPTAuth, type ChatGPTDeps, type Sealed } from './chatgpt'

let server: MockServer
let dir: string

function deps(overrides: Partial<ChatGPTDeps> = {}): ChatGPTDeps {
  return {
    dataDir: dir,
    // Stand-in for OS encryption: enough to check that tokens never hit the disk in plain text.
    seal: (plain: string): Sealed => ({ data: Buffer.from(plain).toString('base64'), encrypted: false }),
    unseal: (sealed: Sealed) => Buffer.from(sealed.data, 'base64').toString(),
    // Instead of a browser: request the authorize URL and follow its redirect into the loopback listener.
    openUrl: async (url: string) => {
      await fetch(url)
    },
    appName: 'Parallax',
    issuer: server.origin,
    apiBase: `${server.origin}/v1`,
    ...overrides,
  }
}

async function freshAuth(overrides?: Partial<ChatGPTDeps>) {
  const auth = new ChatGPTAuth(deps(overrides))
  await auth.load()
  return auth
}

beforeAll(async () => {
  // A 30 s token lifetime is inside the 60 s refresh margin, so every use refreshes.
  server = await startMockServer({ port: 0, tokenTtl: 30 })
  dir = await mkdtemp(join(tmpdir(), 'parallax-chatgpt-'))
})

afterAll(async () => {
  await server.close()
  await rm(dir, { recursive: true, force: true })
})

describe('Sign in with ChatGPT', () => {
  it('registers Parallax, signs in and stores sealed credentials', async () => {
    const auth = await freshAuth()
    const result = await auth.signIn('chatgpt')
    expect(result.status).toBe('signed-in')
    if (result.status !== 'signed-in') return
    expect(result.firstTime).toBe(true)
    expect(result.account).toMatchObject({ email: 'test.user@example.com', signedIn: true, planEnabled: true, needsSignIn: false })

    const request = server.control.authorizeLog.at(-1)!
    expect(request.client_id).toBe('dynamic_agent_client')
    expect(request.agent_name_hint).toBe('Parallax')
    expect(request.ext_agent_host_id).toMatch(/^urn:ietf:params:oauth:jwk-thumbprint:sha-256:/)
    expect(request.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
    expect(request.code_challenge_method).toBe('S256')

    const onDisk = await readFile(join(dir, 'chatgpt.json'), 'utf8')
    expect(onDisk).not.toContain('mock-at-')
    expect(onDisk).not.toContain('mock-rt-')
  })

  it('refreshes expiring access tokens, rotating the refresh token, one refresh at a time', async () => {
    const auth = await freshAuth()
    const first = await auth.accessToken('chatgpt')
    const second = await auth.accessToken('chatgpt')
    expect(first).toMatch(/^mock-at-/)
    expect(second).not.toBe(first)
    const [a, b] = await Promise.all([auth.accessToken('chatgpt'), auth.accessToken('chatgpt')])
    expect(a).toBe(b)

    // The token works against the plan-usage model catalog.
    const models = await fetch(`${server.origin}/v1/models`, { headers: { authorization: `Bearer ${a}` } })
    const json = (await models.json()) as { models: Array<{ slug: string }> }
    expect(json.models.map((m) => m.slug)).toContain('mock-gpt-plan')
  })

  it('reuses the issued client id, host id and hints when signing in again', async () => {
    const auth = await freshAuth()
    const result = await auth.signIn('chatgpt')
    expect(result.status).toBe('signed-in')
    if (result.status === 'signed-in') expect(result.firstTime).toBe(false)
    const [first] = server.control.authorizeLog
    const latest = server.control.authorizeLog.at(-1)!
    expect(latest.client_id).toMatch(/^oaiapp_mock_/)
    expect(latest.agent_name_hint).toBeUndefined()
    expect(latest.login_hint).toBe('test.user@example.com')
    expect(latest.id_token_hint).toBeTruthy()
    expect(latest.ext_agent_host_id).toBe(first.ext_agent_host_id)
  })

  it('reports a declined consent without touching stored credentials', async () => {
    const auth = await freshAuth()
    server.control.next = 'deny'
    expect((await auth.signIn('chatgpt')).status).toBe('declined')
    expect(await auth.accessToken('chatgpt')).toMatch(/^mock-at-/)
  })

  it('keeps the sign-in but disables plan use when that permission is not granted', async () => {
    const auth = await freshAuth()
    server.control.next = 'no-plan'
    const result = await auth.signIn('chatgpt-2')
    expect(result.status).toBe('signed-in')
    if (result.status === 'signed-in') expect(result.account).toMatchObject({ signedIn: true, planEnabled: false })
    await expect(auth.accessToken('chatgpt-2')).rejects.toMatchObject({ code: 'chatgpt_plan_not_enabled' })
  })

  it('asks for a new sign-in when the refresh token is revoked elsewhere', async () => {
    const stale = await freshAuth()
    const other = await freshAuth()
    await other.signOut('chatgpt')
    await expect(stale.accessToken('chatgpt')).rejects.toMatchObject({ code: 'chatgpt_sign_in_required' })
    expect(stale.accounts().find((a) => a.providerId === 'chatgpt')).toMatchObject({ signedIn: false, needsSignIn: true })
  })

  it('signs out by revoking the refresh token and keeps the registration', async () => {
    const auth = await freshAuth()
    expect((await auth.signIn('chatgpt')).status).toBe('signed-in')
    const revokedBefore = server.control.revoked.length
    expect(await auth.signOut('chatgpt')).toEqual({ revoked: true })
    expect(server.control.revoked.length).toBe(revokedBefore + 1)
    await expect(auth.accessToken('chatgpt')).rejects.toMatchObject({ code: 'chatgpt_sign_in_required' })
    expect((await auth.signIn('chatgpt')).status).toBe('signed-in')
    expect(server.control.authorizeLog.at(-1)!.client_id).toMatch(/^oaiapp_mock_/)
  })

  it('can cancel a sign-in that is waiting for the browser', async () => {
    const auth = await freshAuth({ openUrl: async () => undefined })
    const pending = auth.signIn('chatgpt')
    setTimeout(() => auth.cancelSignIn(), 50)
    expect((await pending).status).toBe('cancelled')
  })

  it('forgets an account completely', async () => {
    const auth = await freshAuth()
    await auth.forget('chatgpt-2')
    expect(auth.accounts().some((a) => a.providerId === 'chatgpt-2')).toBe(false)
  })
})
