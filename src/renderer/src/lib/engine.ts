// Runs conversations: sends prompts (to one session or broadcast to many),
// streams replies into the store, and drives group-chat rounds.
import { findModel, flushPersist, providerProblem, useStore } from '../store'
import { isAbortError } from './http'
import { newId } from './platform'
import { chatTurns, estimateTokens, groupTurns, parseMentions, stripSpeakerPrefix, systemPromptFor } from './prompt'
import { adapterFor } from './providers'
import { DEMO_COMPARE_PROMPT, DEMO_GROUP_PROMPT } from './providers/demo'
import { DEMO_MODELS, DEMO_PROVIDER_ID } from './providers/presets'
import { ProviderError, type ChatResult } from './providers/types'
import type { Participant } from './types'

const controllers = new Map<string, AbortController>()
const store = () => useStore.getState()

export function isRunning(sessionId: string): boolean {
  return controllers.has(sessionId)
}

function begin(sessionId: string): AbortController {
  const controller = new AbortController()
  controllers.set(sessionId, controller)
  store().setRunning(sessionId, true)
  return controller
}

function end(sessionId: string, controller: AbortController) {
  if (controllers.get(sessionId) === controller) {
    controllers.delete(sessionId)
    store().setRunning(sessionId, false)
  }
  flushPersist()
}

export function stop(sessionId: string) {
  controllers.get(sessionId)?.abort()
}

export function stopAll() {
  for (const controller of controllers.values()) controller.abort()
}

/** Sends one prompt to every target session. More than one target makes it a broadcast. */
export function sendPrompt(text: string, sessionIds: string[]): void {
  const prompt = text.trim()
  if (!prompt) return
  const state = store()
  const targets = sessionIds.filter((id) => state.sessions[id] && !controllers.has(id))
  if (targets.length === 0) return
  const broadcastId = targets.length > 1 ? newId() : undefined
  for (const id of targets) {
    state.addMessage(id, { id: newId(), role: 'user', content: prompt, createdAt: Date.now(), broadcastId })
    // Broadcast chats share a prompt, so lead their titles with the model to tell them apart.
    const session = state.sessions[id]
    const prefix = broadcastId ? (session.kind === 'group' ? 'Group' : session.participants[0]?.name) : undefined
    state.autoTitle(id, prompt, prefix)
    void respond(id, { prompt, broadcastId })
  }
}

/** Group chats: one more round without a new user message. */
export function continueGroup(sessionId: string) {
  if (controllers.has(sessionId)) return
  void respond(sessionId, { rounds: 1 })
}

/** Throws away a reply (and everything after it) and asks for it again. */
export function regenerate(sessionId: string, messageId: string) {
  if (controllers.has(sessionId)) return
  const session = store().sessions[sessionId]
  const message = session?.messages.find((m) => m.id === messageId)
  if (!session || !message || message.role !== 'assistant') return
  store().truncateFrom(sessionId, messageId)
  if (session.kind === 'group' && message.participantId) {
    void respond(sessionId, { only: [message.participantId], rounds: 1, broadcastId: message.broadcastId })
  } else {
    void respond(sessionId, { broadcastId: message.broadcastId })
  }
}

/** Replaces a user message (dropping what came after it) and sends the new text. */
export function editAndResend(sessionId: string, messageId: string, text: string) {
  const prompt = text.trim()
  if (!prompt || controllers.has(sessionId)) return
  const session = store().sessions[sessionId]
  const message = session?.messages.find((m) => m.id === messageId)
  if (!session || !message || message.role !== 'user') return
  store().truncateFrom(sessionId, messageId)
  store().addMessage(sessionId, { id: newId(), role: 'user', content: prompt, createdAt: Date.now() })
  void respond(sessionId, { prompt })
}

interface RespondOptions {
  prompt?: string
  broadcastId?: string
  rounds?: number
  only?: string[]
}

async function respond(sessionId: string, options: RespondOptions) {
  const controller = begin(sessionId)
  try {
    const session = store().sessions[sessionId]
    if (!session) return
    if (session.kind === 'chat') {
      const participant = session.participants[0]
      if (participant) await generate(sessionId, participant, controller.signal, options.broadcastId)
      return
    }

    const settings = store().settings.group
    const mentioned = options.only ?? (options.prompt ? parseMentions(options.prompt, session.participants) : [])
    const rounds = mentioned.length && !options.only ? 1 : (options.rounds ?? session.rounds ?? settings.rounds)
    for (let round = 0; round < rounds; round++) {
      const current = store().sessions[sessionId]
      if (!current) return
      let speakers = current.participants.filter((p) => !p.muted && (!mentioned.length || mentioned.includes(p.id)))
      if ((current.order ?? settings.order) === 'random') speakers = shuffle(speakers)
      for (const speaker of speakers) {
        if (controller.signal.aborted) return
        await generate(sessionId, speaker, controller.signal, options.broadcastId)
      }
    }
  } finally {
    end(sessionId, controller)
  }
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Batches streamed text so the UI re-renders at most every 40 ms. */
class DeltaBuffer {
  private text = ''
  private reasoning = ''
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly sessionId: string,
    private readonly messageId: string,
    private readonly transform?: (content: string) => string,
  ) {}

  push(text: string, reasoning: string) {
    this.text += text
    this.reasoning += reasoning
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 40)
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.text && !this.reasoning) return
    store().appendToMessage(this.sessionId, this.messageId, this.text, this.reasoning, this.transform)
    this.text = ''
    this.reasoning = ''
  }
}

function refusalNotice(refusal: NonNullable<ChatResult['refusal']>): string {
  const category = refusal.category ? ` (${refusal.category.replace(/_/g, ' ')})` : ''
  return `The model declined to answer${category}.${refusal.explanation ? ` ${refusal.explanation}` : ''}`
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

async function generate(sessionId: string, participant: Participant, signal: AbortSignal, broadcastId?: string) {
  const state = store()
  const session = state.sessions[sessionId]
  if (!session) return
  const provider = state.providers.find((p) => p.id === participant.providerId)
  const history = session.messages
  const messageId = newId()
  state.addMessage(sessionId, {
    id: messageId,
    role: 'assistant',
    content: '',
    createdAt: Date.now(),
    participantId: participant.id,
    model: { providerId: participant.providerId, modelId: participant.modelId, label: participant.name },
    status: 'streaming',
    broadcastId,
  })

  const problem = providerProblem(state, provider)
  if (problem || !provider) {
    store().patchMessage(sessionId, messageId, { status: 'error', error: problem ?? 'Unknown provider.' })
    return
  }

  const group = session.kind === 'group'
  const buffer = new DeltaBuffer(sessionId, messageId, group ? (s) => stripSpeakerPrefix(s, participant.name) : undefined)
  const started = performance.now()
  let firstTokenMs: number | undefined
  const markFirst = () => {
    if (firstTokenMs === undefined) firstTokenMs = performance.now() - started
  }

  try {
    const result = await adapterFor(provider.kind).stream(
      {
        provider,
        model: findModel(provider, participant.modelId),
        system: systemPromptFor(session, participant, state.settings),
        messages: group ? groupTurns(session, participant, history) : chatTurns(history),
        temperature: state.settings.temperature,
        maxOutputTokens: state.settings.maxOutputTokens,
        signal,
      },
      {
        onText: (delta) => {
          markFirst()
          buffer.push(delta, '')
        },
        onReasoning: (delta) => {
          markFirst()
          buffer.push('', delta)
        },
      },
    )
    buffer.flush()
    const totalMs = performance.now() - started
    store().patchMessage(sessionId, messageId, (m) => ({
      status: result.refusal ? 'refused' : 'done',
      notice: result.refusal ? refusalNotice(result.refusal) : result.notice,
      metrics: {
        firstTokenMs,
        totalMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens ?? estimateTokens(m.content),
        servedBy: result.servedBy,
      },
    }))
  } catch (err) {
    buffer.flush()
    const totalMs = performance.now() - started
    if (signal.aborted || isAbortError(err)) {
      store().patchMessage(sessionId, messageId, { status: 'stopped', metrics: { firstTokenMs, totalMs } })
    } else {
      console.error(err)
      store().patchMessage(sessionId, messageId, {
        status: 'error',
        error: describeError(err),
        errorCode: err instanceof ProviderError ? err.code : undefined,
        metrics: { firstTokenMs, totalMs },
      })
    }
  }
}

/** Opens a ready-made demo that needs no API key. */
export function startDemo(kind: 'compare' | 'group') {
  const state = store()
  state.updateFeatures({ demoProvider: true, splitView: true, broadcast: true, compare: true, groupChat: true })
  const refs = DEMO_MODELS.map((m) => ({ providerId: DEMO_PROVIDER_ID, modelId: m.id }))
  if (kind === 'compare') {
    const ids = refs.map((ref) => store().createSession({ kind: 'chat', models: [ref], placement: 'none' }))
    store().setPanes(ids)
    sendPrompt(DEMO_COMPARE_PROMPT, ids)
  } else {
    const id = store().createSession({ kind: 'group', models: refs, placement: 'none' })
    store().updateSession(id, { rounds: 2 })
    store().setPanes([id])
    sendPrompt(DEMO_GROUP_PROMPT, [id])
  }
}
