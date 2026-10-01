// Minimal Server-Sent Events parser for streaming chat completions.

export interface SSEEvent {
  event?: string
  data: string
}

export async function* parseSSE(chunks: AsyncIterable<string>): AsyncGenerator<SSEEvent> {
  let buffer = ''
  let data: string[] = []
  let event: string | undefined

  const takeLine = (line: string): SSEEvent | null => {
    if (line === '') {
      if (data.length === 0) {
        event = undefined
        return null
      }
      const out: SSEEvent = { event, data: data.join('\n') }
      data = []
      event = undefined
      return out
    }
    if (line.startsWith(':')) return null
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
    return null
  }

  for await (const chunk of chunks) {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      const out = takeLine(line)
      if (out) yield out
    }
  }
  if (buffer) {
    const out = takeLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer)
    if (out) yield out
  }
  if (data.length) yield { event, data: data.join('\n') }
}

/** Decodes a fetch body into text chunks. */
export async function* textChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      if (text) yield text
    }
    const tail = decoder.decode()
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}
