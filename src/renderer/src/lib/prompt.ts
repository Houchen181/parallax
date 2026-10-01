// Turns a session's history into the message list one model should see.
import type { ChatTurn } from './providers/types'
import type { GroupSettings, Message, Participant, Session, Settings } from './types'

const usable = (m: Message) => m.content.trim().length > 0 && m.status !== 'error' && m.status !== 'refused'

/** The settings a system prompt depends on (the plugin passes just these). */
export type PromptSettings = Pick<Settings, 'defaultSystemPrompt'> & { group: Pick<GroupSettings, 'announceRoster'> }

export function systemPromptFor(session: Session, participant: Participant, settings: PromptSettings): string | undefined {
  const parts = [
    (session.systemPrompt ?? '').trim() || settings.defaultSystemPrompt.trim(),
    (participant.systemPrompt ?? '').trim(),
  ].filter(Boolean)
  if (session.kind === 'group') parts.push(groupInstructions(session, participant, settings.group.announceRoster))
  return parts.length ? parts.join('\n\n') : undefined
}

function groupInstructions(session: Session, me: Participant, announceRoster: boolean): string {
  const others = session.participants.filter((p) => p.id !== me.id && !p.muted).map((p) => p.name)
  const roster = announceRoster && others.length ? ` The other AI participants are: ${others.join(', ')}.` : ''
  return (
    `You are "${me.name}", one of several AI assistants in a group chat with a human user.${roster} ` +
    'Messages from everyone else start with the speaker\'s name in square brackets, for example "[User]: ...". ' +
    `Reply only as ${me.name}, without a name prefix, and never write lines for the other participants. ` +
    'Build on, question or disagree with what the others said. Keep replies focused and conversational.'
  )
}

/** A one-on-one chat: history maps directly onto user and assistant turns. */
export function chatTurns(messages: Message[]): ChatTurn[] {
  return normalize(
    messages.filter(usable).map((m) => ({ role: m.role, content: m.content })),
    { opening: '(The conversation starts here.)', nudge: 'Please continue.' },
  )
}

/**
 * A group chat from one participant's point of view: its own replies are
 * assistant turns, and everything said by the user or other models becomes
 * user turns labelled with the speaker's name.
 */
export function groupTurns(session: Session, me: Participant, messages: Message[]): ChatTurn[] {
  const names = new Map(session.participants.map((p) => [p.id, p.name]))
  const turns = messages.filter(usable).map((m): ChatTurn => {
    if (m.role === 'assistant' && m.participantId === me.id) return { role: 'assistant', content: m.content }
    const speaker = m.role === 'user' ? 'User' : (names.get(m.participantId ?? '') ?? m.model?.label ?? 'Assistant')
    return { role: 'user', content: `[${speaker}]: ${m.content}` }
  })
  return normalize(turns, { opening: '[System]: The conversation starts here.', nudge: '[System]: It is your turn again.' })
}

/** Merges consecutive same-role turns and makes the list start and end with a user turn. */
function normalize(turns: ChatTurn[], fillers: { opening: string; nudge: string }): ChatTurn[] {
  const out: ChatTurn[] = []
  for (const turn of turns) {
    const last = out[out.length - 1]
    if (last && last.role === turn.role) last.content += `\n\n${turn.content}`
    else out.push({ ...turn })
  }
  if (out.length && out[0].role === 'assistant') out.unshift({ role: 'user', content: fillers.opening })
  if (out.length && out[out.length - 1].role === 'assistant') out.push({ role: 'user', content: fillers.nudge })
  return out
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Removes a leading "[Name]:" or "**Name:**" that models sometimes copy from the transcript. */
export function stripSpeakerPrefix(text: string, name: string): string {
  const pattern = new RegExp(`^\\s*(?:\\*\\*)?\\[?${escapeRegExp(name)}\\]?(?:\\*\\*)?\\s*:(?:\\*\\*)?[ \\t]*`, 'i')
  return text.replace(pattern, '')
}

export function handleFor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Participants addressed with @handle in a message. A handle prefix of 3+ characters matches. */
export function parseMentions(text: string, participants: Participant[]): string[] {
  const ids = new Set<string>()
  for (const match of text.matchAll(/@([\w.-]+)/g)) {
    const wanted = handleFor(match[1])
    if (!wanted) continue
    for (const p of participants) {
      const handle = handleFor(p.name)
      if (handle === wanted || (wanted.length >= 3 && handle.startsWith(wanted))) ids.add(p.id)
    }
  }
  return [...ids]
}

export function autoTitle(text: string): string {
  const line = text.trim().split('\n')[0].replace(/\s+/g, ' ')
  return line.length > 52 ? `${line.slice(0, 51)}…` : line || 'New chat'
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
