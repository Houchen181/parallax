// A fake LLM server for testing Parallax without real accounts, keys or costs.
// It speaks the OpenAI Chat Completions and Anthropic Messages streaming
// formats, and fakes Sign in with ChatGPT: an OAuth/OIDC server plus the
// Responses API that plan-funded requests use.
//
//   npm run mock            # listens on http://localhost:8787
//
// In Parallax, add "Custom (OpenAI-compatible)" with base URL
// http://localhost:8787/v1 and/or "Custom (Anthropic-compatible)" with base URL
// http://localhost:8787, using the test key below.
//
// Models: mock-gpt, mock-gpt-slow, mock-error (OpenAI side), mock-claude,
// mock-refuse (Anthropic side) and mock-gpt-plan, mock-gpt-plan-limit,
// mock-gpt-plan-noreason (ChatGPT plan side).
//
// To point the desktop app's Sign in with ChatGPT at this server, start it with
// PARALLAX_CHATGPT_ISSUER=http://127.0.0.1:8787 and
// PARALLAX_CHATGPT_API=http://127.0.0.1:8787/v1 (and PARALLAX_CHATGPT_OPEN=fetch
// to skip the browser).
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { SignJWT, exportJWK } from 'jose'

// Local test credential. Not a real key for any service.
export const TEST_KEY = 'parallax-test-key'

const RESOURCE = 'https://api.openai.com/v1'
const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
const REQUIRED_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_SCOPE]
const HOST_ID = /^(urn:ietf:params:oauth:jwk-thumbprint:sha-256:[A-Za-z0-9_-]{43}|urn:uuid:[0-9a-f-]{36}|did:key:\S+)$/
const UNSUPPORTED_RESPONSES_FIELDS = [
  'background',
  'conversation',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'moderation',
  'prompt',
  'prompt_cache_retention',
  'safety_identifier',
  'temperature',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
  'previous_response_id',
]

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const random = (prefix) => `${prefix}${randomBytes(18).toString('base64url')}`

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS })
  res.end(JSON.stringify(body))
}

async function readRaw(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw
}

async function readJson(req) {
  const raw = await readRaw(req)
  return raw ? JSON.parse(raw) : {}
}

async function readForm(req) {
  return new URLSearchParams(await readRaw(req))
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : (b.text ?? ''))).join('')
  return ''
}

function lastUserText(messages) {
  const last = [...(messages ?? [])].reverse().find((m) => m.role === 'user')
  return textOf(last?.content).trim()
}

function replyFor(model, messages, system) {
  const asked = lastUserText(messages).replace(/\s+/g, ' ')
  const excerpt = asked.length > 120 ? `${asked.slice(0, 119)}…` : asked
  const speaker = /You are "([^"]+)"/.exec(system ?? '')?.[1]
  return [
    speaker ? `Speaking as **${speaker}** (model \`${model}\`).` : `This is **${model}**, a mock model.`,
    '',
    `> ${excerpt || '(empty message)'}`,
    '',
    'Some formatting to check the renderer:',
    '',
    '1. A numbered item',
    '2. Another one with `inline code`',
    '',
    '```js',
    `console.log('hello from ${model}')`,
    '```',
    '',
    'And some math: $e^{i\\pi} + 1 = 0$.',
  ].join('\n')
}

const pieces = (text) => text.match(/\s*\S+/g) ?? []

function openStream(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...CORS })
  let closed = false
  res.on('close', () => {
    closed = true
  })
  return { isClosed: () => closed || res.writableEnded }
}

const bearer = (req) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]

export async function startMockServer({ port = 8787, tokenTtl = 3600 } = {}) {
  let origin = ''

  // ------------------------------------------------- Sign in with ChatGPT state

  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...(await exportJWK(publicKey)), kid: 'mock-key', alg: 'RS256', use: 'sig' }
  const codes = new Map()
  const refreshTokens = new Map()
  const accessTokens = new Map()
  const clients = new Set()
  /** Test hooks: what the next authorize request should do, and a log of requests. */
  const control = { next: 'approve', authorizeLog: [], revoked: [] }

  function issueTokens(clientId, scope, nonce) {
    const accessToken = random('mock-at-')
    const refreshToken = random('mock-rt-')
    accessTokens.set(accessToken, { clientId, scope, exp: Date.now() + tokenTtl * 1000 })
    refreshTokens.set(refreshToken, { clientId, scope })
    return { accessToken, refreshToken, nonce }
  }

  async function idToken(clientId, nonce) {
    return new SignJWT({ email: 'test.user@example.com', ...(nonce ? { nonce } : {}) })
      .setProtectedHeader({ alg: 'RS256', kid: 'mock-key' })
      .setIssuer(origin)
      .setAudience(clientId)
      .setSubject('mock-user-1')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey)
  }

  function authorize(url, res) {
    const p = url.searchParams
    control.authorizeLog.push(Object.fromEntries(p))
    const fail = (message) => sendJson(res, 400, { error: 'invalid_request', error_description: message })
    let redirect
    try {
      redirect = new URL(p.get('redirect_uri') ?? '')
    } catch {
      return fail('redirect_uri is not a URL')
    }
    if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || redirect.pathname !== '/auth/callback') {
      return fail('redirect_uri must be http://127.0.0.1:<port>/auth/callback')
    }
    const scopes = (p.get('scope') ?? '').split(' ')
    const clientId = p.get('client_id')
    if (p.get('response_type') !== 'code') return fail('response_type must be code')
    if (!REQUIRED_SCOPES.every((s) => scopes.includes(s))) return fail('missing scopes')
    if (p.get('resource') !== RESOURCE) return fail('resource must be https://api.openai.com/v1')
    if (!p.get('state') || !p.get('nonce')) return fail('state and nonce are required')
    if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) return fail('PKCE S256 is required')
    if (!HOST_ID.test(p.get('ext_agent_host_id') ?? '')) return fail('ext_agent_host_id is missing or malformed')
    if (clientId === 'dynamic_agent_client') {
      if (!p.get('agent_name_hint')) return fail('agent_name_hint is required for registration')
    } else if (!clients.has(clientId)) {
      return fail('unknown client_id')
    } else if (p.has('agent_name_hint')) {
      return fail('agent_name_hint is only for the first registration')
    }

    const back = new URL(redirect)
    back.searchParams.set('state', p.get('state'))
    const mode = control.next
    control.next = 'approve'
    if (mode === 'deny') {
      back.searchParams.set('error', 'access_denied')
    } else {
      const issued = clientId === 'dynamic_agent_client' ? random('oaiapp_mock_') : clientId
      clients.add(issued)
      const granted = mode === 'no-plan' ? REQUIRED_SCOPES.filter((s) => s !== PLAN_SCOPE) : REQUIRED_SCOPES
      const code = random('mock-code-')
      codes.set(code, {
        clientId: issued,
        redirectUri: p.get('redirect_uri'),
        challenge: p.get('code_challenge'),
        nonce: p.get('nonce'),
        scope: granted.join(' '),
      })
      back.searchParams.set('code', code)
      back.searchParams.set('scope', granted.join(' '))
      if (clientId === 'dynamic_agent_client') back.searchParams.set('client_id', issued)
    }
    res.writeHead(302, { location: back.href })
    res.end()
  }

  async function token(req, res) {
    const form = await readForm(req)
    const oauthError = (error, description) => sendJson(res, 400, { error, error_description: description })
    if (form.get('resource') !== RESOURCE) return oauthError('invalid_request', 'wrong resource')
    if (form.get('grant_type') === 'authorization_code') {
      const entry = codes.get(form.get('code'))
      if (!entry) return oauthError('invalid_grant', 'unknown or used code')
      codes.delete(form.get('code'))
      if (form.get('client_id') !== entry.clientId) return oauthError('invalid_client', 'client mismatch')
      if (form.get('redirect_uri') !== entry.redirectUri) return oauthError('invalid_grant', 'redirect_uri mismatch')
      const digest = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
      if (digest !== entry.challenge) return oauthError('invalid_grant', 'PKCE verification failed')
      const { accessToken, refreshToken } = issueTokens(entry.clientId, entry.scope)
      return sendJson(res, 200, {
        access_token: accessToken,
        refresh_token: refreshToken,
        id_token: await idToken(entry.clientId, entry.nonce),
        token_type: 'Bearer',
        expires_in: tokenTtl,
        scope: entry.scope,
      })
    }
    if (form.get('grant_type') === 'refresh_token') {
      const entry = refreshTokens.get(form.get('refresh_token'))
      if (!entry) return oauthError('invalid_grant', 'refresh token is invalid, expired or reused')
      if (form.get('client_id') !== entry.clientId) return oauthError('invalid_client', 'client mismatch')
      refreshTokens.delete(form.get('refresh_token'))
      const { accessToken, refreshToken } = issueTokens(entry.clientId, entry.scope)
      return sendJson(res, 200, {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: tokenTtl,
        scope: entry.scope,
      })
    }
    return oauthError('unsupported_grant_type', 'unsupported grant_type')
  }

  async function revoke(req, res) {
    const form = await readForm(req)
    control.revoked.push(form.get('token'))
    refreshTokens.delete(form.get('token'))
    res.writeHead(200, CORS)
    res.end()
  }

  function planToken(req) {
    const entry = accessTokens.get(bearer(req) ?? '')
    return entry && entry.exp > Date.now() ? entry : undefined
  }

  async function responses(req, res) {
    const entry = planToken(req)
    if (!entry || !entry.scope.split(' ').includes(PLAN_SCOPE)) return sendJson(res, 401, { detail: 'Unauthorized' })
    const body = await readJson(req)
    const unsupported = (param, message) =>
      sendJson(res, 400, { error: { code: 'subscription_sharing_unsupported_capability', param, message } })
    if (body.store !== false) return unsupported('store', 'store must be false')
    if (body.stream !== true) return unsupported('stream', 'stream must be true')
    const field = UNSUPPORTED_RESPONSES_FIELDS.find((f) => f in body)
    if (field) return unsupported(field, `${field} is not supported`)
    if ((body.input ?? []).some((item) => item.role === 'system')) return unsupported('input', 'system messages are rejected')
    if (body.model === 'mock-gpt-plan-noreason' && body.reasoning) {
      return sendJson(res, 400, {
        error: { code: 'unsupported_parameter', param: 'reasoning.summary', message: "Unsupported parameter: 'reasoning.summary'." },
      })
    }

    const stream = openStream(res)
    let sequence = 0
    const event = (type, payload = {}) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...payload })}\n\n`)
    const id = random('resp_')
    event('response.created', { response: { id, status: 'in_progress', model: body.model } })
    await sleep(120)

    if (body.model === 'mock-gpt-plan-limit') {
      event('response.failed', {
        response: {
          id,
          status: 'failed',
          error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Usage limit reached for this app.' },
        },
      })
      return res.end()
    }

    if (body.reasoning?.summary) {
      event('response.reasoning_summary_part.added', { summary_index: 0 })
      for (const part of pieces('**Planning** I will answer with a short mock reply that exercises formatting.')) {
        if (stream.isClosed()) return
        event('response.reasoning_summary_text.delta', { summary_index: 0, delta: part })
        await sleep(6)
      }
      event('response.reasoning_summary_part.done', { summary_index: 0 })
    }
    const parts = pieces(replyFor(body.model, body.input, body.instructions))
    for (const part of parts) {
      if (stream.isClosed()) return
      event('response.output_text.delta', { output_index: 0, content_index: 0, delta: part })
      await sleep(10)
    }
    event('response.completed', {
      response: { id, status: 'completed', model: body.model, usage: { input_tokens: 40, output_tokens: parts.length } },
    })
    res.end()
  }

  // -------------------------------------------------------------- OpenAI side

  const OPENAI_MODELS = ['mock-gpt', 'mock-gpt-slow', 'mock-error']
  const PLAN_MODELS = [
    { slug: 'mock-gpt-plan', display_name: 'Mock GPT (plan)', visibility: 'list' },
    { slug: 'mock-gpt-plan-limit', display_name: 'Mock GPT (usage limit)', visibility: 'list' },
    { slug: 'mock-gpt-plan-noreason', display_name: 'Mock GPT (no reasoning)', visibility: 'list' },
    { slug: 'mock-internal', display_name: 'Internal', visibility: 'hide' },
  ]

  async function openaiChat(req, res) {
    if (bearer(req) !== TEST_KEY) {
      return sendJson(res, 401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error' } })
    }
    const body = await readJson(req)
    if (body.model === 'mock-error') {
      return sendJson(res, 500, { error: { message: 'The mock server was asked to fail.', type: 'server_error' } })
    }
    const stream = openStream(res)
    const system = textOf((body.messages ?? []).find((m) => m.role === 'system')?.content)
    const text = replyFor(body.model, body.messages, system)
    const delay = body.model === 'mock-gpt-slow' ? 60 : 12
    const base = { id: `chatcmpl-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model }
    const write = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    await sleep(150)
    write({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
    const parts = pieces(text)
    for (const part of parts) {
      if (stream.isClosed()) return
      write({ ...base, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })
      await sleep(delay)
    }
    write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    if (body.stream_options?.include_usage) {
      write({ ...base, choices: [], usage: { prompt_tokens: 42, completion_tokens: parts.length, total_tokens: 42 + parts.length } })
    }
    res.write('data: [DONE]\n\n')
    res.end()
  }

  // ----------------------------------------------------------- Anthropic side

  const ANTHROPIC_MODELS = [
    { id: 'mock-claude', display_name: 'Mock Claude' },
    { id: 'mock-refuse', display_name: 'Mock Refuser' },
  ]
  const supported = (value) => ({ supported: value })

  function anthropicModel(m) {
    return {
      type: 'model',
      id: m.id,
      display_name: m.display_name,
      created_at: '2026-01-01T00:00:00Z',
      max_input_tokens: 200000,
      max_tokens: 8192,
      capabilities: {
        batch: supported(false),
        citations: supported(false),
        code_execution: supported(false),
        context_management: { supported: false },
        effort: { supported: true, low: supported(true), medium: supported(true), high: supported(true), max: supported(true), xhigh: supported(true) },
        image_input: supported(false),
        pdf_input: supported(false),
        structured_outputs: supported(false),
        thinking: { supported: true, types: { adaptive: supported(true), enabled: supported(false) } },
      },
    }
  }

  const anthropicAuthError = (res) =>
    sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })

  async function anthropicMessages(req, res) {
    if (req.headers['x-api-key'] !== TEST_KEY) return anthropicAuthError(res)
    const body = await readJson(req)
    const stream = openStream(res)
    const event = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
    event('message_start', {
      message: {
        id: `msg_mock_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 40, output_tokens: 1 },
      },
    })
    await sleep(150)

    if (body.model === 'mock-refuse') {
      event('message_delta', {
        delta: {
          stop_reason: 'refusal',
          stop_sequence: null,
          stop_details: { type: 'refusal', category: null, explanation: 'The mock model refuses everything.' },
        },
        usage: { output_tokens: 0 },
      })
      event('message_stop', {})
      return res.end()
    }

    let index = 0
    if (body.thinking) {
      event('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } })
      for (const part of pieces('The user wants a test reply. Show some formatting so the renderer can be checked.')) {
        if (stream.isClosed()) return
        event('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: part } })
        await sleep(8)
      }
      event('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'mock-signature' } })
      event('content_block_stop', { index })
      index++
    }

    const system = typeof body.system === 'string' ? body.system : textOf(body.system)
    const parts = pieces(replyFor(body.model, body.messages, system))
    event('content_block_start', { index, content_block: { type: 'text', text: '' } })
    for (const part of parts) {
      if (stream.isClosed()) return
      event('content_block_delta', { index, delta: { type: 'text_delta', text: part } })
      await sleep(12)
    }
    event('content_block_stop', { index })
    event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: parts.length } })
    event('message_stop', {})
    res.end()
  }

  // ------------------------------------------------------------------- router

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS)
        return res.end()
      }
      if (req.method === 'GET' && path === '/.well-known/openid-configuration') {
        return sendJson(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/api/accounts/authorize`,
          token_endpoint: `${origin}/api/accounts/oauth/token`,
          revocation_endpoint: `${origin}/api/accounts/oauth/revoke`,
          jwks_uri: `${origin}/.well-known/jwks.json`,
          id_token_signing_alg_values_supported: ['RS256'],
        })
      }
      if (req.method === 'GET' && path === '/.well-known/jwks.json') return sendJson(res, 200, { keys: [jwk] })
      if (req.method === 'GET' && path === '/api/accounts/authorize') return authorize(url, res)
      if (req.method === 'POST' && path === '/api/accounts/oauth/token') return await token(req, res)
      if (req.method === 'POST' && path === '/api/accounts/oauth/revoke') return await revoke(req, res)
      if (req.method === 'POST' && path === '/mock/next-authorize') {
        control.next = (await readJson(req)).mode ?? 'approve'
        return sendJson(res, 200, { next: control.next })
      }
      if (req.method === 'GET' && path === '/v1/models') {
        if (req.headers['anthropic-version']) {
          if (req.headers['x-api-key'] !== TEST_KEY) return anthropicAuthError(res)
          const data = ANTHROPIC_MODELS.map(anthropicModel)
          return sendJson(res, 200, { data, has_more: false, first_id: data[0].id, last_id: data.at(-1).id })
        }
        if (planToken(req)) return sendJson(res, 200, { models: PLAN_MODELS })
        if (bearer(req) !== TEST_KEY) {
          return sendJson(res, 401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error' } })
        }
        return sendJson(res, 200, { object: 'list', data: OPENAI_MODELS.map((id) => ({ id, object: 'model', owned_by: 'mock' })) })
      }
      if (req.method === 'POST' && path === '/v1/responses') return await responses(req, res)
      if (req.method === 'POST' && path === '/v1/chat/completions') return await openaiChat(req, res)
      if (req.method === 'POST' && path === '/v1/messages') return await anthropicMessages(req, res)
      sendJson(res, 404, { error: { message: `No route for ${req.method} ${path}` } })
    } catch (err) {
      console.error(err)
      if (!res.headersSent) sendJson(res, 500, { error: { message: String(err) } })
      else res.end()
    }
  })

  await new Promise((resolve) => server.listen(port, resolve))
  const actualPort = server.address().port
  origin = `http://127.0.0.1:${actualPort}`
  return {
    port: actualPort,
    origin,
    control,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startMockServer({
    port: Number(process.env.MOCK_PORT ?? 8787),
    tokenTtl: Number(process.env.MOCK_TOKEN_TTL ?? 3600),
  })
  console.log(`Mock LLM server on http://localhost:${server.port} (OAuth issuer ${server.origin})`)
}
