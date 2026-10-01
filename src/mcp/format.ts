// Turns job state into the text a tool call returns. Replies are wrapped in
// tags so the calling model can tell where each one starts and ends, and only
// replies not returned before are included.
import type { AskJob, GroupJob, Reply, Turn } from './jobs'

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function details(reply: Reply): string {
  const parts = [`model="${attr(reply.ref)}"`, `name="${attr(reply.name)}"`]
  if (reply.ms !== undefined) parts.push(`seconds="${(reply.ms / 1000).toFixed(1)}"`)
  if (reply.outputTokens !== undefined) parts.push(`output_tokens="${reply.outputTokens}"`)
  return parts.join(' ')
}

function block(tag: string, reply: Reply, extra = ''): string {
  const head = `<${tag} ${extra}${details(reply)}`
  switch (reply.status) {
    case 'done':
      return `${head}>\n${reply.text.trim() || '(empty reply)'}${reply.notice ? `\n[Note: ${reply.notice}]` : ''}\n</${tag}>`
    case 'refused':
      return `${head} status="declined">\n${reply.error}${reply.text.trim() ? `\nPartial text before it stopped:\n${reply.text.trim()}` : ''}\n</${tag}>`
    case 'error':
      return `${head} status="error">\n${reply.error}\n</${tag}>`
    case 'stopped':
      return `${head} status="stopped">\n${reply.text.trim() ? `Stopped. Partial text:\n${reply.text.trim()}` : 'Stopped before it answered.'}\n</${tag}>`
    case 'running':
      return `${head} status="running" />`
  }
}

/** Adds blocks until `maxChars` is reached (always at least one) and marks them delivered. */
function take<T extends Reply>(items: T[], maxChars: number, render: (item: T) => string): { text: string[]; left: number } {
  const text: string[] = []
  let used = 0
  let left = 0
  for (const item of items) {
    const rendered = render(item)
    if (text.length && used + rendered.length > maxChars) {
      left++
      continue
    }
    text.push(rendered)
    used += rendered.length
    item.delivered = true
  }
  return { text, left }
}

function more(jobId: string, what: string): string {
  return `${what} Call get_results with job_id "${jobId}" to collect it.`
}

export function formatAsk(job: AskJob, maxChars: number): string {
  const total = job.replies.length
  const finished = job.replies.filter((r) => r.status !== 'running')
  const fresh = finished.filter((r) => !r.delivered)
  const alreadySent = finished.length - fresh.length
  const { text, left } = take(fresh, maxChars, (r) => block('answer', r))
  const running = job.replies.filter((r) => r.status === 'running')

  const lines = [
    `Parallax job ${job.id}: ${finished.length} of ${total} model${total === 1 ? '' : 's'} finished${alreadySent ? ` (${alreadySent} returned earlier)` : ''}.`,
    ...text,
  ]
  if (!text.length && !running.length && !left) lines.push('Nothing new: every answer was already returned.')
  if (running.length) {
    const names = running.map((r) => `${r.name} (${r.ref}, ${r.text.length.toLocaleString('en-US')} characters so far)`).join(', ')
    lines.push(more(job.id, `Still answering: ${names}. They keep running in the background.`))
  } else if (left) {
    lines.push(more(job.id, `${left} more answer${left === 1 ? ' is' : 's are'} ready but didn't fit in this result.`))
  }
  return lines.join('\n\n')
}

export function formatGroup(job: GroupJob, maxChars: number): string {
  // Turns are returned in order, so stop at the first one still being written.
  const ready: Turn[] = []
  for (const turn of job.turns) {
    if (turn.status === 'running') break
    if (!turn.delivered) ready.push(turn)
  }
  const { text, left } = take(ready, maxChars, (t) => block('turn', t, `round="${t.round}" `))
  const spoken = job.turns.filter((t) => t.status !== 'running').length
  const header = `Parallax discussion ${job.id}: ${spoken} of ${job.totalTurns} turns${job.finished ? ', finished' : ''}. Participants: ${job.members
    .map((m) => `${m.name} (${m.target.ref})`)
    .join(', ')}.`

  const lines = [header, ...text]
  if (job.finished && job.endNote) lines.push(job.endNote)
  const current = job.turns.find((t) => t.status === 'running')
  if (left) {
    lines.push(more(job.id, `${left} more turn${left === 1 ? ' is' : 's are'} ready but didn't fit in this result.`))
  } else if (!job.finished) {
    const now = current ? `${current.name} is speaking (round ${current.round}).` : 'The discussion is still going.'
    lines.push(more(job.id, `${now} The discussion keeps going in the background.`))
  } else if (!text.length) {
    lines.push('Nothing new: every turn was already returned.')
  }
  return lines.join('\n\n')
}
