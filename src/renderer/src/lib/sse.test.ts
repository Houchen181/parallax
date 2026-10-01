import { describe, expect, it } from 'vitest'
import { parseSSE } from './sse'

async function* from(chunks: string[]) {
  for (const chunk of chunks) yield chunk
}

async function collect(chunks: string[]) {
  const out = []
  for await (const event of parseSSE(from(chunks))) out.push(event)
  return out
}

describe('parseSSE', () => {
  it('parses events split across chunk boundaries', async () => {
    const events = await collect(['data: {"a"', ':1}\n', '\ndata: [DO', 'NE]\n\n'])
    expect(events).toEqual([
      { event: undefined, data: '{"a":1}' },
      { event: undefined, data: '[DONE]' },
    ])
  })

  it('handles CRLF line endings, event names and comments', async () => {
    const events = await collect([': keep-alive\r\n\r\nevent: message_start\r\ndata: {}\r', '\n\r\n'])
    expect(events).toEqual([{ event: 'message_start', data: '{}' }])
  })

  it('joins multi-line data fields', async () => {
    const events = await collect(['data: one\ndata: two\n\n'])
    expect(events).toEqual([{ event: undefined, data: 'one\ntwo' }])
  })

  it('emits a trailing event without a final blank line', async () => {
    const events = await collect(['data: last'])
    expect(events).toEqual([{ event: undefined, data: 'last' }])
  })
})
