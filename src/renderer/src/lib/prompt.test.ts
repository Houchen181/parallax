import { describe, expect, it } from 'vitest'
import { chatTurns, groupTurns, parseMentions, stripSpeakerPrefix, systemPromptFor } from './prompt'
import type { Message, Participant, Session, Settings } from './types'

const alice: Participant = { id: 'a', providerId: 'p', modelId: 'm1', name: 'Claude Opus 5.5', color: '#000' }
const bob: Participant = { id: 'b', providerId: 'p', modelId: 'm2', name: 'GPT', color: '#111' }

let n = 0
const msg = (role: Message['role'], content: string, participantId?: string, extra: Partial<Message> = {}): Message => ({
  id: String(n++),
  role,
  content,
  createdAt: n,
  participantId,
  status: 'done',
  ...extra,
})

const group = (messages: Message[]): Session => ({
  id: 's',
  title: 't',
  kind: 'group',
  participants: [alice, bob],
  messages,
  createdAt: 0,
  updatedAt: 0,
})

const settings = {
  defaultSystemPrompt: '',
  group: { rounds: 1, order: 'sequential', announceRoster: true },
} as unknown as Settings

describe('groupTurns', () => {
  it("labels other speakers and keeps the model's own replies as assistant turns", () => {
    const history = [msg('user', 'Hi all'), msg('assistant', 'Hello from Claude', 'a'), msg('assistant', 'Hello from GPT', 'b')]
    expect(groupTurns(group(history), alice, history)).toEqual([
      { role: 'user', content: '[User]: Hi all' },
      { role: 'assistant', content: 'Hello from Claude' },
      { role: 'user', content: '[GPT]: Hello from GPT' },
    ])
  })

  it('merges consecutive user turns into one', () => {
    const history = [msg('user', 'Question'), msg('assistant', 'First answer', 'a')]
    expect(groupTurns(group(history), bob, history)).toEqual([
      { role: 'user', content: '[User]: Question\n\n[Claude Opus 5.5]: First answer' },
    ])
  })

  it('skips failed and empty replies and ends on a user turn', () => {
    const history = [
      msg('user', 'Go'),
      msg('assistant', 'Mine', 'a'),
      msg('assistant', '', 'b', { status: 'error', error: 'boom' }),
    ]
    const turns = groupTurns(group(history), alice, history)
    expect(turns.at(-1)).toEqual({ role: 'user', content: '[System]: It is your turn again.' })
    expect(turns.some((t) => t.content.includes('boom'))).toBe(false)
  })
})

describe('chatTurns', () => {
  it('maps roles directly and drops refused replies', () => {
    const history = [msg('user', 'q'), msg('assistant', 'partial', 'a', { status: 'refused' }), msg('user', 'q2')]
    expect(chatTurns(history)).toEqual([{ role: 'user', content: 'q\n\nq2' }])
  })
})

describe('systemPromptFor', () => {
  it('adds group instructions with the roster', () => {
    const prompt = systemPromptFor(group([]), alice, settings)!
    expect(prompt).toContain('You are "Claude Opus 5.5"')
    expect(prompt).toContain('The other AI participants are: GPT.')
  })
})

describe('stripSpeakerPrefix', () => {
  it.each([
    ['[GPT]: Sure', 'Sure'],
    ['GPT: Sure', 'Sure'],
    ['**GPT:** Sure', 'Sure'],
    ['**GPT**: Sure', 'Sure'],
    ['GPTs are great', 'GPTs are great'],
  ])('%s', (input, expected) => {
    expect(stripSpeakerPrefix(input, 'GPT')).toBe(expected)
  })
})

describe('parseMentions', () => {
  it('matches full handles and prefixes of three or more characters', () => {
    expect(parseMentions('@claude-opus-5-5 what do you think?', [alice, bob])).toEqual(['a'])
    expect(parseMentions('@cla and @gpt', [alice, bob]).sort()).toEqual(['a', 'b'])
    expect(parseMentions('@cl hello', [alice, bob])).toEqual([])
  })
})
