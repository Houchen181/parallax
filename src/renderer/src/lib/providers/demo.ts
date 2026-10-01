// Simulated models so the app can be explored without an API key. Replies are
// canned for the two built-in demo prompts and templated for everything else.
import { abortError } from '../http'
import type { ModelInfo } from '../types'
import { DEMO_MODELS } from './presets'
import type { ChatRequest, ChatResult, ChatTurn, ProviderAdapter, StreamHandlers } from './types'

export const DEMO_COMPARE_PROMPT = "What's the fastest way to get productive in a new programming language?"
export const DEMO_GROUP_PROMPT = 'Should a beginner learn Python or JavaScript first?'

type Persona = 'concise' | 'thorough' | 'skeptic'

const COMPARE_REPLIES: Record<Persona, string> = {
  concise: `Build something small on day one. Pick a project you already understand (a to-do list, a script that renames files, a tiny web scraper) and rebuild it in the new language. In one afternoon you'll meet the syntax, the standard library, the package manager and the error messages.

Keep three tabs open: the official tutorial, the standard library reference and a cheat sheet. Then read idiomatic code written by others before you write much of your own.`,

  thorough: `## A practical ramp-up plan

**1. Map the language (day 1)**
- Skim the official tour end to end. Don't memorise anything yet; just learn where things live.
- Note what is *different* from languages you know: memory model, error handling, concurrency, typing.

**2. Set up a real toolchain (day 1)**
- Formatter, linter, test runner and debugger, all wired into your editor.
- A REPL or scratch project for quick experiments.

**3. Port a project you've already built (days 2–4)**
Reimplementing something familiar separates the *language* from the *problem*:

\`\`\`python
# A word-frequency counter makes a good first port
from collections import Counter

words = open("book.txt", encoding="utf-8").read().lower().split()
print(Counter(words).most_common(10))
\`\`\`

**4. Read idiomatic code (ongoing)**
Pick a well-maintained library in the language and compare its style with yours.

**5. Teach it back**
Write a short note on what surprised you. Explaining things is the quickest way to find the gaps.

| Week | Focus | Output |
|---|---|---|
| 1 | Syntax and tooling | A ported project |
| 2 | Idioms and the standard library | A small library with tests |
| 3 | Ecosystem | A first open-source contribution |`,

  skeptic: `"Fastest" depends on what *productive* means for you. If it means shipping features at work, the quickest path is reading your team's codebase and making small, reviewed changes, not doing tutorials. If it means passing interviews, drill the standard library and common data structures instead.

Two traps to watch for:
1. **Tutorial loops**: feeling productive while building nothing of your own.
2. **Line-by-line translation** from a language you already know, which produces code you'll later have to unlearn.

So before choosing a method, decide what you'll build in the first week and how you'll know it worked.`,
}

// Two rounds of a scripted discussion. Each persona speaks once per round.
const GROUP_REPLIES: Record<Persona, string[]> = {
  concise: [
    `Python. The syntax gets out of the way, the error messages are readable, and you can be doing something useful (automating a spreadsheet, plotting data) within a week. JavaScript is a fine second language.`,
    `Fair point from Skeptic about the browser. I'd still say Python first for most people, but if the goal is "I want to make websites", start with JavaScript and don't look back.`,
  ],
  thorough: [
    `I agree with Concise for general-purpose learning, with one caveat: **the best first language is the one attached to a project you care about.**

- **Python** suits data, science, automation and scripting. Its clean syntax lets beginners focus on concepts like loops, functions and data structures.
- **JavaScript** suits anything visual or web-based. You get instant feedback in the browser, which is very motivating.

Both teach the same fundamentals, and moving from one to the other later takes weeks, not months.`,
    `To sum up the discussion:

| If you want to… | Start with |
|---|---|
| Analyse data, automate tasks, do science | Python |
| Build websites or interactive UIs | JavaScript |
| Not sure yet | Python, then add JavaScript |

We all agree the fundamentals transfer, so the choice matters less than starting.`,
  ],
  skeptic: [
    `I'll push back a little on both of you. Python's simplicity hides some things beginners eventually need to understand, like how values are passed around. And JavaScript has one huge advantage: **every computer already runs it.** No installation, and you can share what you build with a link.

The real risk isn't picking the "wrong" language. It's spending a month comparing languages instead of writing code.`,
    `Thorough's table is a good summary. My only addition: pick one, commit to it for at least a month, and ignore the internet arguments about which is better. Consistency beats optimisation at the start.`,
  ],
}

function personaOf(modelId: string): Persona {
  if (modelId.includes('thorough')) return 'thorough'
  if (modelId.includes('skeptic')) return 'skeptic'
  return 'concise'
}

const SPEAKER = /^\[([^\]]+)\]:\s*/
const BLOCK_SPLIT = /\n\n(?=\[[^\]]+\]:)/

/** The human's latest message. Group transcripts arrive as "[Name]: text" blocks. */
function lastHumanText(messages: ChatTurn[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const turn = messages[i]
    if (turn.role !== 'user') continue
    if (!SPEAKER.test(turn.content)) return turn.content.trim()
    const human = turn.content
      .split(BLOCK_SPLIT)
      .reverse()
      .find((block) => block.startsWith('[User]:'))
    if (human) return human.replace(SPEAKER, '').trim()
  }
  return ''
}

function lastOtherSpeaker(messages: ChatTurn[]): string | undefined {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'user') return undefined
  const blocks = last.content.split(BLOCK_SPLIT)
  for (let i = blocks.length - 1; i >= 0; i--) {
    const name = SPEAKER.exec(blocks[i])?.[1]
    if (name && name !== 'User' && name !== 'System') return name
  }
  return undefined
}

function excerpt(text: string, max = 90): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function templated(persona: Persona, prompt: string, other: string | undefined): string {
  const topic = excerpt(prompt) || 'your message'
  const footer = '\n\n*This is a simulated reply. Add an API key in Settings → Providers to compare real models.*'
  switch (persona) {
    case 'concise':
      return `${other ? `Building on ${other}: ` : ''}here's my quick take on **"${topic}"**. Start with the simplest version that works, check it against a concrete example, then refine it.${footer}`
    case 'thorough':
      return `## Breaking it down

**What you asked:** "${topic}"

1. **Clarify the goal.** What would a good answer let you do?
2. **List the constraints.** Time, tools, and what you already know.
3. **Try a first pass.** A rough version you can test beats a perfect plan.
4. **Review and iterate.** Compare the result with the goal from step 1.${other ? `\n\n${other} raised a good point too; the two approaches combine well.` : ''}${footer}`
    case 'skeptic':
      return `${other ? `I'm not fully convinced by ${other}. ` : ''}Before answering "${topic}", it's worth checking the premise: is this the right question, and how would you know an answer is correct? Pin down one concrete success criterion first.${footer}`
  }
}

function replyFor(request: ChatRequest): { text: string; reasoning?: string } {
  const persona = personaOf(request.model.id)
  const prompt = lastHumanText(request.messages)
  const ownTurns = request.messages.filter((m) => m.role === 'assistant').length
  let text: string
  if (prompt.includes(DEMO_GROUP_PROMPT)) {
    const script = GROUP_REPLIES[persona]
    text = script[Math.min(ownTurns, script.length - 1)]
  } else if (prompt.includes(DEMO_COMPARE_PROMPT)) {
    text = COMPARE_REPLIES[persona]
  } else {
    text = templated(persona, prompt, lastOtherSpeaker(request.messages))
  }
  const reasoning =
    persona === 'thorough'
      ? 'Identify what the user is really asking, list the options, then give a structured answer with a concrete example.'
      : undefined
  return { text, reasoning }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const SPEED: Record<Persona, { first: number; perChunk: number }> = {
  concise: { first: 350, perChunk: 14 },
  thorough: { first: 700, perChunk: 9 },
  skeptic: { first: 500, perChunk: 20 },
}

export const demoAdapter: ProviderAdapter = {
  async stream(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResult> {
    const persona = personaOf(request.model.id)
    const { text, reasoning } = replyFor(request)
    const speed = SPEED[persona]
    await sleep(speed.first, request.signal)
    if (reasoning) {
      for (const piece of reasoning.match(/\S+\s*/g) ?? []) {
        handlers.onReasoning(piece)
        await sleep(6, request.signal)
      }
    }
    const pieces = text.match(/\s*\S+/g) ?? []
    for (const piece of pieces) {
      handlers.onText(piece)
      await sleep(speed.perChunk + Math.random() * speed.perChunk, request.signal)
    }
    const inputChars = request.messages.reduce((n, m) => n + m.content.length, request.system?.length ?? 0)
    return { stopReason: 'end_turn', inputTokens: Math.ceil(inputChars / 4), outputTokens: Math.ceil(text.length / 4) }
  },

  async listModels(): Promise<ModelInfo[]> {
    return DEMO_MODELS.map((m) => ({ ...m }))
  },
}
