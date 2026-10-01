<div align="center">

<img src="build/icon.png" width="96" alt="Parallax logo" />

# Parallax

**One prompt, many models.** A desktop chat app for Claude, GPT, Gemini and any OpenAI-compatible model.
Run several chats side by side, send one prompt to all of them, compare the answers, or put several models
in a single group chat and let them talk to each other.

[Download for Windows](https://github.com/Houchen181/parallax/releases/latest) ·
[Try it in your browser](https://houchen181.github.io/parallax/) ·
[Report an issue](https://github.com/Houchen181/parallax/issues)

</div>

![Three models answering the same prompt side by side](docs/screenshots/compare.png)

## Features

- **Bring your own key, any provider.** Anthropic (Claude), OpenAI (GPT), Google Gemini, OpenRouter, Groq,
  DeepSeek, Mistral, xAI, Together, local models through Ollama or LM Studio, and any server that speaks the
  OpenAI Chat Completions or Anthropic Messages API.
- **Split view.** Open up to six chats next to each other, each with its own model and history.
- **Broadcast.** With several chats open, one message goes to all of them at once. A pane's antenna button
  takes it out of the broadcast.
- **Compare.** Every broadcast prompt gets a *Compare* button that shows the replies side by side. The view
  marks the fastest start, the first to finish, and the most detailed and most concise answers, and can show
  a word-level diff against any reply.
- **Group chat.** Put several models in one conversation. They take turns, read what the others said, and can
  build on it or disagree. You choose how many rounds follow each message, the speaking order and a persona
  for each model. Start a message with `@name` to hear from specific models only.
- **Everything is optional.** Each of these features can be turned off in Settings → Features.
- **A familiar chat UI.** Streaming Markdown, syntax-highlighted code with copy buttons, LaTeX math, Claude's
  thinking summaries, edit-and-resend, regenerate, starred replies, reply stats (time to first token, total
  time, tokens, speed), light and dark themes, and JSON export and import.
- **Demo models.** Three simulated models let you try everything before you add a key.

| Comparing replies | A group chat |
|---|---|
| ![Compare dialog](docs/screenshots/compare-dialog.png) | ![Group chat in dark mode](docs/screenshots/group-chat.png) |

<details>
<summary>Settings: providers and feature toggles</summary>

![Provider settings](docs/screenshots/settings.png)
![Feature toggles](docs/screenshots/features.png)

</details>

## Install

### Windows desktop app

Download `Parallax-Setup-<version>.exe` from the
[latest release](https://github.com/Houchen181/parallax/releases/latest) and run it. The installer isn't
code-signed yet, so Windows SmartScreen may warn you. Choose **More info → Run anyway**.

### Web version

Open <https://houchen181.github.io/parallax/>. It's the same app running in the browser.

- Keys are stored in that browser's local storage and sent straight to each provider.
- Some providers don't accept requests from web pages (CORS), so they only work in the desktop app.
- Local servers such as Ollama need their own CORS setting (for Ollama, `OLLAMA_ORIGINS`).

## Getting started

1. Open **Settings → Providers**, pick a provider and paste your API key. Parallax fetches that provider's
   model list automatically. To add another provider, click **Add provider** and choose one of the presets.
2. Start a chat with **New chat** and pick a model at the top of the pane.
3. To compare models, click **Compare models**, tick the models you want and type a question. Each model gets
   its own pane, and your messages go to all of them.
4. For a group chat, click **New group chat**. Use the **+** button to add models and the sliders button to
   set the rounds and the speaking order.

Keyboard shortcuts:

- **Ctrl+N**: new chat
- **Ctrl+Shift+N**: new group chat
- **Ctrl+B**: show or hide the sidebar
- **Ctrl+,**: open Settings
- **Esc**: stop generating

**Ctrl+click** a chat in the sidebar to open it beside the current one.

### Why API keys and not a ChatGPT or Claude subscription?

Third-party apps can't use consumer ChatGPT Plus or Claude Pro logins. API keys are the supported way to
connect, and you pay the provider for what you use.

## Providers

| Provider | API | Notes |
|---|---|---|
| Anthropic | Messages API through the official `@anthropic-ai/sdk` | Thinking summaries, effort setting, prompt caching, refusal fallback |
| OpenAI | Chat Completions | GPT and o-series models |
| Google Gemini | Gemini's OpenAI-compatible endpoint | |
| OpenRouter, Groq, DeepSeek, Mistral, xAI, Together | Chat Completions | One preset each |
| Ollama, LM Studio | Chat Completions on `localhost` | No key needed |
| Custom | Either API | Any base URL, such as vLLM, LiteLLM or a company gateway |

Notes on Claude:

- Parallax asks the newer models for a **summary of their thinking** and streams it above the answer. You can
  turn this off per provider.
- **Effort** controls how much the model thinks. It defaults to each model's own setting.
- Requests use automatic **prompt caching**, so long chats cost less.
- When a supported model (Claude Fable 5.1, Opus 5.5, Opus 5, Sonnet 5.5) declines a request for safety
  reasons, the API's **refusal fallback** retries it on Anthropic's recommended fallback model. The reply is
  labelled with the model that wrote it. This is on by default for `api.anthropic.com`; turn it off in the
  provider's settings.

## Privacy and security

- **There is no Parallax server.** Messages go directly from the app to the providers you configure.
- **Desktop app.**
  - Once saved, API keys stay in the Electron main process, encrypted with Windows DPAPI (`safeStorage`).
    The UI never gets them back, and the main process attaches them to outgoing requests itself.
  - Each key is locked to the origin it was saved for, so it can't be sent to any other host.
- **Model output is untrusted.**
  - Raw HTML isn't rendered, and remote images become plain links (no tracking pixels).
  - Links open in your browser, not in the app.
  - A strict Content Security Policy applies.
- **Exports** contain chats, settings and the provider list, never keys.

## Development

You need Node.js 22 or newer.

```bash
git clone https://github.com/Houchen181/parallax.git
cd parallax
npm install
npm run dev        # desktop app with hot reload
```

Other commands:

| Command | What it does |
|---|---|
| `npm run dev:web` | The browser version at http://localhost:5173 |
| `npm test` | Unit tests (Vitest) |
| `npm run typecheck` | TypeScript checks for the renderer and the Electron code |
| `npm run mock` | A fake LLM server on port 8787 that speaks both APIs, for testing without keys (see `scripts/mock-llm-server.mjs`) |
| `npm run dist:win` | Builds the Windows installer into `release/` |
| `npm run icon` | Regenerates the app icon |

Project layout:

```
src/main/        Electron main process: window, encrypted key store, streaming HTTP proxy
src/preload/     The small, typed bridge exposed to the UI
src/shared/      Types shared across processes
src/renderer/    React UI
  src/lib/       Provider adapters, conversation engine, prompt building, SSE parsing
  src/store/     App state (Zustand, persisted to IndexedDB)
  src/components Chat panes, composer, sidebar, compare view, settings
scripts/         Dev runner, build helpers, mock server, icon generator
```

### Releasing

Push a tag such as `v0.2.0`. GitHub Actions builds the installer on Windows and attaches it to the release.
Every push to `main` runs the tests and deploys the web version to GitHub Pages.

## License

[MIT](LICENSE)
