// Runs ask_models and group_discussion in the background. A tool call waits
// for its job up to a time limit and hands back what has finished; get_results
// collects the rest. Hosts such as Codex stop a tool call after 60 seconds, and
// strong models often think for longer than that.
import { randomBytes } from 'node:crypto'
import { groupTurns, stripSpeakerPrefix, systemPromptFor, type PromptSettings } from '../renderer/src/lib/prompt'
import { isAbortError } from '../renderer/src/lib/http'
import type { ChatTurn } from '../renderer/src/lib/providers/types'
import type { Message, Participant, Session } from '../renderer/src/lib/types'
import { adapterFor, type ResolvedModel } from './providers'

export type ReplyStatus = 'running' | 'done' | 'refused' | 'error' | 'stopped'

export interface Reply {
  ref: string
  /** Model label, or the participant's name in a discussion. */
  name: string
  status: ReplyStatus
  text: string
  error?: string
  notice?: string
  ms?: number
  outputTokens?: number
  /** Already returned to the caller. */
  delivered: boolean
}

export interface Turn extends Reply {
  round: number
}

abstract class Job {
  readonly id = randomBytes(4).toString('hex')
  readonly createdAt = Date.now()
  readonly controller = new AbortController()
  finishedAt?: number
  private listeners = new Set<() => void>()

  get finished(): boolean {
    return this.finishedAt !== undefined
  }

  abstract get progress(): { done: number; total: number; message?: string }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  protected changed() {
    for (const listener of [...this.listeners]) listener()
  }

  protected finish() {
    this.finishedAt = Date.now()
    this.changed()
  }

  stop() {
    this.controller.abort()
  }

  /** Resolves when the job finishes, `ms` pass, or `signal` aborts, whichever comes first. */
  wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.finished || signal?.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        unsubscribe()
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      const unsubscribe = this.onChange(() => {
        if (this.finished) done()
      })
      signal?.addEventListener('abort', done, { once: true })
    })
  }
}

interface Streamed {
  text: string
  ms: number
  outputTokens?: number
  notice?: string
  refusal?: string
}

/** One request through the shared provider adapters; `onText` sees the reply as it streams. */
async function streamReply(
  target: ResolvedModel,
  request: { system?: string; messages: ChatTurn[]; maxOutputTokens: number; temperature: number | null; thinking?: boolean },
  signal: AbortSignal,
  onText: (text: string) => void,
): Promise<Streamed> {
  const started = Date.now()
  let text = ''
  const provider = request.thinking === false ? { ...target.provider.config, thinking: false } : target.provider.config
  const result = await adapterFor(provider.kind).stream(
    {
      provider,
      model: target.model,
      system: request.system,
      messages: request.messages,
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
      signal,
    },
    {
      onText(delta) {
        text += delta
        onText(text)
      },
      onReasoning() {
        // Reasoning summaries stay out of the results to keep them short.
      },
    },
  )
  const refusal = result.refusal
    ? `Declined to answer${result.refusal.category ? ` (${result.refusal.category})` : ''}${result.refusal.explanation ? `: ${result.refusal.explanation}` : ''}.`
    : undefined
  return { text, ms: Date.now() - started, outputTokens: result.outputTokens, notice: result.notice, refusal }
}

function failure(err: unknown, signal: AbortSignal): { status: ReplyStatus; error?: string } {
  if (signal.aborted || isAbortError(err)) return { status: 'stopped' }
  return { status: 'error', error: err instanceof Error ? err.message : String(err) }
}

export interface AskInput {
  prompt: string
  system?: string
  models: ResolvedModel[]
  /** Requested models that couldn't be used, reported next to the answers. */
  problems?: Array<{ ref: string; error: string }>
  maxOutputTokens: number
  temperature: number | null
}

export class AskJob extends Job {
  readonly kind = 'ask'
  readonly replies: Reply[]

  constructor(input: AskInput) {
    super()
    this.replies = [
      ...input.models.map((m): Reply => ({ ref: m.ref, name: m.label, status: 'running', text: '', delivered: false })),
      ...(input.problems ?? []).map((p): Reply => ({ ref: p.ref, name: p.ref, status: 'error', error: p.error, text: '', delivered: false })),
    ]
    const signal = this.controller.signal
    const runs = input.models.map(async (target, index) => {
      const reply = this.replies[index]
      try {
        const out = await streamReply(
          target,
          { system: input.system, messages: [{ role: 'user', content: input.prompt }], maxOutputTokens: input.maxOutputTokens, temperature: input.temperature },
          signal,
          (text) => {
            reply.text = text
          },
        )
        Object.assign(reply, { text: out.text, ms: out.ms, outputTokens: out.outputTokens, notice: out.notice })
        reply.status = out.refusal ? 'refused' : 'done'
        if (out.refusal) reply.error = out.refusal
      } catch (err) {
        Object.assign(reply, failure(err, signal))
      }
      this.changed()
    })
    void Promise.allSettled(runs).finally(() => this.finish())
  }

  get progress() {
    const done = this.replies.filter((r) => r.status !== 'running')
    const last = done[done.length - 1]
    return { done: done.length, total: this.replies.length, message: last ? `${last.name} finished` : undefined }
  }
}

export interface GroupMember {
  target: ResolvedModel
  name: string
  persona?: string
}

export interface GroupInput {
  topic: string
  system?: string
  members: GroupMember[]
  rounds: number
  order: 'sequential' | 'random'
  maxOutputTokens: number
}

const GROUP_SETTINGS: PromptSettings = { defaultSystemPrompt: '', group: { announceRoster: true } }

function shuffled<T>(items: T[]): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

export class GroupJob extends Job {
  readonly kind = 'group'
  readonly turns: Turn[] = []
  readonly members: GroupMember[]
  readonly rounds: number
  /** Set when the discussion ended early. */
  endNote?: string

  constructor(input: GroupInput) {
    super()
    this.members = input.members
    this.rounds = input.rounds
    void this.run(input)
      .catch((err: unknown) => {
        this.endNote = `The discussion stopped because of an error: ${err instanceof Error ? err.message : String(err)}`
      })
      .finally(() => this.finish())
  }

  get totalTurns(): number {
    return this.members.length * this.rounds
  }

  get progress() {
    const done = this.turns.filter((t) => t.status !== 'running')
    const last = done[done.length - 1]
    return { done: done.length, total: this.totalTurns, message: last ? `${last.name} spoke (round ${last.round})` : undefined }
  }

  private async run(input: GroupInput) {
    const signal = this.controller.signal
    const now = Date.now()
    const participants: Participant[] = input.members.map((m, index) => ({
      id: `p${index}`,
      providerId: m.target.provider.id,
      modelId: m.target.model.id,
      name: m.name,
      color: '',
      systemPrompt: m.persona,
    }))
    const session: Session = {
      id: this.id,
      title: 'Parallax discussion',
      kind: 'group',
      participants,
      messages: [{ id: 'topic', role: 'user', content: input.topic, createdAt: now }],
      systemPrompt: input.system,
      createdAt: now,
      updatedAt: now,
    }

    for (let round = 1; round <= input.rounds; round++) {
      const order = input.order === 'random' ? shuffled(participants) : participants
      let spoke = 0
      for (const participant of order) {
        if (signal.aborted) {
          this.endNote = 'Stopped before the end.'
          return
        }
        const member = input.members[participants.indexOf(participant)]
        const turn: Turn = { round, ref: member.target.ref, name: member.name, status: 'running', text: '', delivered: false }
        this.turns.push(turn)
        try {
          const out = await streamReply(
            member.target,
            {
              system: systemPromptFor(session, participant, GROUP_SETTINGS),
              messages: groupTurns(session, participant, session.messages),
              maxOutputTokens: input.maxOutputTokens,
              temperature: null,
              // Quick, conversational turns.
              thinking: false,
            },
            signal,
            (text) => {
              turn.text = text
            },
          )
          const text = stripSpeakerPrefix(out.text, member.name).trim()
          Object.assign(turn, { text, ms: out.ms, outputTokens: out.outputTokens, notice: out.notice })
          if (out.refusal) {
            Object.assign(turn, { status: 'refused', error: out.refusal })
          } else {
            turn.status = 'done'
            if (text) spoke++
            const message: Message = {
              id: `t${this.turns.length}`,
              role: 'assistant',
              content: text,
              createdAt: Date.now(),
              participantId: participant.id,
              status: 'done',
            }
            session.messages.push(message)
          }
        } catch (err) {
          Object.assign(turn, failure(err, signal))
        }
        this.changed()
      }
      if (signal.aborted) {
        this.endNote = 'Stopped before the end.'
        return
      }
      if (spoke === 0) {
        this.endNote = `Ended after round ${round}: no participant could answer.`
        return
      }
    }
  }
}

export type AnyJob = AskJob | GroupJob

const KEEP_FINISHED_MS = 30 * 60_000
const MAX_JOBS = 50

export class JobStore {
  private jobs = new Map<string, AnyJob>()

  add<T extends AnyJob>(job: T): T {
    this.prune()
    this.jobs.set(job.id, job)
    return job
  }

  get(id: string): AnyJob | undefined {
    return this.jobs.get(id.trim())
  }

  latest(): AnyJob | undefined {
    return [...this.jobs.values()].pop()
  }

  private prune() {
    const now = Date.now()
    for (const [id, job] of this.jobs) {
      if (job.finishedAt && now - job.finishedAt > KEEP_FINISHED_MS) this.jobs.delete(id)
    }
    for (const [id, job] of this.jobs) {
      if (this.jobs.size < MAX_JOBS) break
      job.stop()
      this.jobs.delete(id)
    }
  }

  stopAll() {
    for (const job of this.jobs.values()) job.stop()
  }
}
