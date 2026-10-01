// A fake LLM server for testing Parallax without real API keys or costs.
// It speaks both the OpenAI Chat Completions and the Anthropic Messages
// streaming formats.
//
//   npm run mock            # listens on http://localhost:8787
//
// In Parallax, add "Custom (OpenAI-compatible)" with base URL
// http://localhost:8787/v1 and/or "Custom (Anthropic-compatible)" with base URL
// http://localhost:8787, using the test key below.
//
// Models: mock-gpt, mock-gpt-slow, mock-error (OpenAI side) and
// mock-claude, mock-refuse (Anthropic side).
import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_PORT ?? 8787)
// Local test credential. Not a real key for any service.
const TEST_KEY = 'parallax-test-key'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw ? JSON.parse(raw) : {}
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

function systemText(body) {
  if (body.system) return textOf(body.system)
  return textOf((body.messages ?? []).find((m) => m.role === 'system')?.content)
}

function replyFor(model, body) {
  const asked = lastUserText(body.messages).replace(/\s+/g, ' ')
  const excerpt = asked.length > 120 ? `${asked.slice(0, 119)}…` : asked
  const speaker = /You are "([^"]+)"/.exec(systemText(body))?.[1]
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

// ---------------------------------------------------------------- OpenAI side

const OPENAI_MODELS = ['mock-gpt', 'mock-gpt-slow', 'mock-error']

async function openaiChat(req, res) {
  if (req.headers.authorization !== `Bearer ${TEST_KEY}`) {
    return sendJson(res, 401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error' } })
  }
  const body = await readJson(req)
  if (body.model === 'mock-error') {
    return sendJson(res, 500, { error: { message: 'The mock server was asked to fail.', type: 'server_error' } })
  }
  const stream = openStream(res)
  const text = replyFor(body.model, body)
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

// ------------------------------------------------------------- Anthropic side

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

function anthropicAuthError(res) {
  sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
}

async function anthropicMessages(req, res) {
  if (req.headers['x-api-key'] !== TEST_KEY) return anthropicAuthError(res)
  const body = await readJson(req)
  const stream = openStream(res)
  const event = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
  const id = `msg_mock_${Date.now()}`
  event('message_start', {
    message: {
      id,
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

  const parts = pieces(replyFor(body.model, body))
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

// ---------------------------------------------------------------------- router

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      return res.end()
    }
    if (req.method === 'GET' && path === '/v1/models') {
      if (req.headers['anthropic-version']) {
        if (req.headers['x-api-key'] !== TEST_KEY) return anthropicAuthError(res)
        const data = ANTHROPIC_MODELS.map(anthropicModel)
        return sendJson(res, 200, { data, has_more: false, first_id: data[0].id, last_id: data.at(-1).id })
      }
      if (req.headers.authorization !== `Bearer ${TEST_KEY}`) {
        return sendJson(res, 401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error' } })
      }
      return sendJson(res, 200, { object: 'list', data: OPENAI_MODELS.map((id) => ({ id, object: 'model', owned_by: 'mock' })) })
    }
    if (req.method === 'POST' && path === '/v1/chat/completions') return await openaiChat(req, res)
    if (req.method === 'POST' && path === '/v1/messages') return await anthropicMessages(req, res)
    sendJson(res, 404, { error: { message: `No route for ${req.method} ${path}` } })
  } catch (err) {
    console.error(err)
    if (!res.headersSent) sendJson(res, 500, { error: { message: String(err) } })
    else res.end()
  }
})

server.listen(PORT, () => {
  console.log(`Mock LLM server on http://localhost:${PORT}`)
})
