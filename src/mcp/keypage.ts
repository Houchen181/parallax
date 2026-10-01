// The configure_keys tool opens this page in the user's browser so API keys go
// straight from the user to this computer, never through the chat.
//
// The server listens on 127.0.0.1 only. Its API needs the per-launch token
// from the link the tool opens, requests must come from the page's own origin,
// and the Host header must be 127.0.0.1 or localhost (which stops DNS-rebinding
// tricks). Saved keys are never sent back to the page.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PROVIDERS, type Registry } from './providers'

export interface KeyPage {
  url: string
  close(): Promise<void>
}

const MAX_BODY = 64 * 1024
const TEST_TIMEOUT_MS = 20_000

const isCustom = (id: string) => id.startsWith('custom-')
const KEY_PROVIDERS = PROVIDERS.filter((p) => p.requiresKey || isCustom(p.id))

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > MAX_BODY) throw new Error('Request body too large')
  }
  const parsed = raw ? (JSON.parse(raw) as unknown) : {}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object')
  return parsed as Record<string, unknown>
}

function normalizeBaseUrl(value: unknown): string {
  const text = String(value ?? '').trim().replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error('Enter the server address, e.g. https://example.com/v1')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The address must start with https:// or http://')
  if (url.username || url.password) throw new Error("Don't put credentials in the address; use the key field.")
  return text
}

export async function startKeyPage(options: { registry: Registry; dataDir: string; idleMs?: number; onClose?: () => void }): Promise<KeyPage> {
  const { registry } = options
  const token = randomBytes(32).toString('base64url')
  const nonce = randomBytes(16).toString('base64')
  const idleMs = options.idleMs ?? 30 * 60_000
  let port = 0
  let idleTimer: NodeJS.Timeout | undefined
  let closed = false

  const headers = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  }

  function sendJson(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }

  function state() {
    return {
      dataDir: options.dataDir,
      providers: KEY_PROVIDERS.map((preset) => {
        const provider = registry.get(preset.id)!
        return {
          id: preset.id,
          name: preset.name,
          description: preset.description,
          keyUrl: preset.keyUrl ?? null,
          custom: isCustom(preset.id),
          baseUrl: provider.config.baseUrl,
          ready: !provider.problem,
          source: provider.key?.source ?? (provider.keyless ? 'keyless' : null),
          from: provider.key?.from ?? null,
          problem: provider.problem ?? null,
          saved: registry.keys.saved(preset.id) !== undefined,
        }
      }),
      local: PROVIDERS.filter((p) => !p.requiresKey && !isCustom(p.id)).map((p) => ({ name: p.name, baseUrl: registry.get(p.id)!.config.baseUrl })),
    }
  }

  async function test(providerId: string) {
    const provider = registry.get(providerId)
    if (!provider) throw new Error('Unknown provider')
    const listing = await registry.models(provider, { refresh: true, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) })
    return listing.models ? { ok: true, count: listing.models.length } : { ok: false, error: listing.error }
  }

  function providerFrom(body: Record<string, unknown>) {
    const preset = KEY_PROVIDERS.find((p) => p.id === body.providerId)
    if (!preset) throw new Error('Unknown provider')
    return preset
  }

  async function api(req: IncomingMessage, res: ServerResponse, route: string) {
    const provided = req.headers['x-parallax-token']
    if (typeof provided !== 'string' || !sameToken(provided, token)) {
      return sendJson(res, 403, { message: 'This page has expired. Ask for the Parallax key page again (configure_keys).' })
    }
    const origin = req.headers.origin
    if (origin && origin !== `http://${req.headers.host}`) return sendJson(res, 403, { message: 'Requests from other sites are not allowed.' })
    if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return sendJson(res, 415, { message: 'Expected JSON' })
    }
    try {
      const body = req.method === 'POST' ? await readJson(req) : {}
      await registry.refresh()
      switch (`${req.method} ${route}`) {
        case 'GET state':
          return sendJson(res, 200, state())
        case 'POST save': {
          const preset = providerFrom(body)
          const key = String(body.key ?? '').trim()
          if (key.length > 4096 || /\s/.test(key)) throw new Error("That doesn't look like an API key.")
          let baseUrl = registry.baseUrlFor(preset)
          if (isCustom(preset.id)) {
            baseUrl = normalizeBaseUrl(body.baseUrl)
            await registry.saveBaseUrl(preset.id, baseUrl)
          }
          if (key) await registry.keys.set(preset.id, key, baseUrl)
          else if (!isCustom(preset.id)) throw new Error('Paste a key first.')
          await registry.refresh()
          return sendJson(res, 200, { test: await test(preset.id), state: state() })
        }
        case 'POST remove': {
          const preset = providerFrom(body)
          await registry.keys.remove(preset.id)
          await registry.refresh()
          return sendJson(res, 200, { state: state() })
        }
        case 'POST test':
          return sendJson(res, 200, { test: await test(providerFrom(body).id), state: state() })
        default:
          return sendJson(res, 404, { message: 'Not found' })
      }
    } catch (err) {
      return sendJson(res, 400, { message: err instanceof Error ? err.message : String(err) })
    }
  }

  const server = createServer((req, res) => {
    const host = req.headers.host
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(403, { 'content-type': 'text/plain', ...headers })
      res.end('This page only answers on 127.0.0.1.')
      return
    }
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => void page.close(), idleMs)
    const { pathname } = new URL(req.url ?? '/', `http://${host}`)
    if (pathname.startsWith('/api/')) {
      void api(req, res, pathname.slice('/api/'.length))
      return
    }
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers })
      res.end(PAGE.replaceAll('__NONCE__', nonce))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain', ...headers })
    res.end('Not found')
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  port = (server.address() as AddressInfo).port
  idleTimer = setTimeout(() => void page.close(), idleMs)

  const page: KeyPage = {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    close: () =>
      new Promise<void>((resolve) => {
        clearTimeout(idleTimer)
        if (closed) return resolve()
        closed = true
        options.onClose?.()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
  return page
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parallax API keys</title>
<style nonce="__NONCE__">
:root { --bg: #f7f7f5; --card: #ffffff; --text: #1f1f1e; --muted: #6b6a66; --line: #e4e3df; --accent: #c2410c; --ok: #15803d; --warn: #b45309; --bad: #b91c1c; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #1c1c1b; --card: #262625; --text: #ecebe8; --muted: #a3a29d; --line: #3a3937; --accent: #fb923c; --ok: #4ade80; --warn: #fbbf24; --bad: #f87171; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 6px; }
p { margin: 0 0 12px; }
.muted { color: var(--muted); }
code { font: 13px ui-monospace, Consolas, monospace; background: var(--line); padding: 1px 5px; border-radius: 4px; word-break: break-all; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin: 14px 0; }
.head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.head h2 { font-size: 16px; margin: 0; }
.pill { font-size: 12px; border-radius: 999px; padding: 1px 9px; border: 1px solid currentColor; }
.ready { color: var(--ok); } .missing { color: var(--muted); } .problem { color: var(--warn); }
.head a { margin-left: auto; color: var(--accent); font-size: 13px; }
.row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
input { flex: 1 1 260px; min-width: 0; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font: inherit; }
button { padding: 8px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font: inherit; cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button:disabled { opacity: .6; cursor: default; }
.msg { margin-top: 8px; font-size: 13px; min-height: 1em; }
.msg.ok { color: var(--ok); } .msg.bad { color: var(--bad); }
.note { font-size: 13px; }
</style>
</head>
<body>
<main>
<h1>Parallax API keys</h1>
<p class="muted">Keys you save here stay on this computer and are sent only to their provider. The Parallax plugin in Claude and Codex and the Parallax web version (<code>npm run serve</code>) all use them.</p>
<p class="muted note" id="where"></p>
<div id="list"><p class="muted">Loading…</p></div>
<p class="muted note" id="local"></p>
<p class="muted note">When you're done, close this tab and go back to your chat.</p>
</main>
<script nonce="__NONCE__">
var token = new URLSearchParams(location.search).get('token') || sessionStorage.getItem('parallax-token') || '';
if (token) { sessionStorage.setItem('parallax-token', token); history.replaceState(null, '', '/' + location.hash); }

function api(route, body) {
  return fetch('/api/' + route, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-parallax-token': token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  }).then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok) throw new Error(data.message || res.statusText);
      return data;
    });
  });
}

function el(tag, attrs, children) {
  var node = document.createElement(tag);
  Object.keys(attrs || {}).forEach(function (name) {
    if (name === 'text') node.textContent = attrs[name];
    else if (name === 'onclick') node.addEventListener('click', attrs[name]);
    else node.setAttribute(name, attrs[name]);
  });
  (children || []).forEach(function (child) { if (child) node.appendChild(child); });
  return node;
}

function statusText(p) {
  if (p.ready && p.source === 'plugin') return ['ready', 'Ready · key from your plugin settings (' + p.from + ')'];
  if (p.ready && p.source === 'env') return ['ready', 'Ready · key from the ' + p.from + ' environment variable'];
  if (p.ready && p.source === 'keyless') return ['ready', 'Ready · no key'];
  if (p.ready) return ['ready', 'Ready · key saved'];
  if (p.problem === 'no API key' || p.problem === 'needs a base URL') return ['missing', 'Not set up'];
  return ['problem', p.problem];
}

function card(p) {
  var status = statusText(p);
  var msg = el('div', { class: 'msg' });
  var key = el('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: p.saved ? 'Replace the saved key' : 'Paste your API key', 'aria-label': p.name + ' API key' });
  var base = p.custom ? el('input', { type: 'url', placeholder: 'Server address, e.g. https://example.com/v1', 'aria-label': p.name + ' address' }) : null;
  if (base) base.value = p.baseUrl || '';

  function run(button, route, body, okText) {
    button.disabled = true;
    msg.className = 'msg';
    msg.textContent = 'Working…';
    api(route, body).then(function (data) {
      var t = data.test;
      var lead = okText ? okText + ' ' : '';
      if (t && t.ok) { msg.className = 'msg ok'; msg.textContent = lead + 'It works: ' + t.count + ' models available.'; }
      else if (t) { msg.className = 'msg bad'; msg.textContent = lead + (okText ? 'But the test failed: ' : 'The test failed: ') + t.error; }
      else { msg.className = 'msg ok'; msg.textContent = okText; }
      render(data.state, p.id, msg.textContent, msg.className);
    }).catch(function (err) {
      msg.className = 'msg bad'; msg.textContent = err.message;
    }).finally(function () { button.disabled = false; });
  }

  var save = el('button', { class: 'primary', text: 'Save', onclick: function () {
    run(save, 'save', { providerId: p.id, key: key.value, baseUrl: base ? base.value : undefined }, 'Saved.');
  } });
  var testButton = el('button', { text: 'Test', onclick: function () { run(testButton, 'test', { providerId: p.id }, ''); } });
  var remove = p.saved ? el('button', { text: 'Remove key', onclick: function () {
    run(remove, 'remove', { providerId: p.id }, 'Removed.');
  } }) : null;

  var head = el('div', { class: 'head' }, [
    el('h2', { text: p.name }),
    el('span', { class: 'pill ' + status[0], text: status[1] }),
    p.keyUrl ? el('a', { href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Get a key ↗' }) : null
  ]);
  var node = el('section', { class: 'card', id: 'p-' + p.id }, [
    head,
    el('p', { class: 'muted note', text: p.description + (p.custom ? '' : ' Requests go to ' + p.baseUrl + '.') }),
    base ? el('div', { class: 'row' }, [base]) : null,
    el('div', { class: 'row' }, [key, save, p.ready ? testButton : null, remove]),
    msg
  ]);
  node.msg = msg;
  return node;
}

function render(state, focusId, text, className) {
  document.getElementById('where').textContent = 'Saved in ' + state.dataDir + ' (readable only by your user account).';
  var list = document.getElementById('list');
  list.textContent = '';
  state.providers.forEach(function (p) {
    var node = card(p);
    if (p.id === focusId && text) { node.msg.textContent = text; node.msg.className = className; }
    list.appendChild(node);
  });
  document.getElementById('local').textContent = 'No key needed for models on this computer: ' +
    state.local.map(function (l) { return l.name + ' at ' + l.baseUrl; }).join(', ') + '. Start the app and Parallax finds its models.';
  var focus = new URLSearchParams(location.hash.slice(1)).get('provider');
  if (focus && !focusId) { var target = document.getElementById('p-' + focus); if (target) target.scrollIntoView(); }
}

if (!token) {
  document.getElementById('list').textContent = 'This link is missing its access token. Ask for the Parallax key page again.';
} else {
  api('state').then(function (state) { render(state); }).catch(function (err) {
    document.getElementById('list').textContent = err.message;
  });
}
</script>
</body>
</html>
`
