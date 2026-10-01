import type { MessageMetrics, Session } from './types'

export function formatSeconds(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
}

export function tokensPerSecond(metrics: MessageMetrics | undefined): number | undefined {
  if (!metrics?.outputTokens || metrics.totalMs == null) return undefined
  const streamingMs = metrics.totalMs - (metrics.firstTokenMs ?? 0)
  if (streamingMs < 200) return undefined
  return metrics.outputTokens / (streamingMs / 1000)
}

export function metricParts(metrics: MessageMetrics | undefined): string[] {
  if (!metrics) return []
  const parts: string[] = []
  if (metrics.firstTokenMs != null) parts.push(`${formatSeconds(metrics.firstTokenMs)} to first token`)
  if (metrics.totalMs != null) parts.push(`${formatSeconds(metrics.totalMs)} total`)
  if (metrics.outputTokens) parts.push(`${formatCount(metrics.outputTokens)} tokens`)
  const tps = tokensPerSecond(metrics)
  if (tps) parts.push(`${Math.round(tps)} tok/s`)
  return parts
}

const DAY = 24 * 60 * 60 * 1000

export function sessionGroups(sessions: Session[]): Array<{ label: string; sessions: Session[] }> {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const buckets: Array<{ label: string; test: (t: number) => boolean; sessions: Session[] }> = [
    { label: 'Today', test: (t) => t >= startOfToday, sessions: [] },
    { label: 'Yesterday', test: (t) => t >= startOfToday - DAY, sessions: [] },
    { label: 'Previous 7 days', test: (t) => t >= startOfToday - 7 * DAY, sessions: [] },
    { label: 'Previous 30 days', test: (t) => t >= startOfToday - 30 * DAY, sessions: [] },
    { label: 'Older', test: () => true, sessions: [] },
  ]
  const pinned: Session[] = []
  for (const session of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (session.pinned) {
      pinned.push(session)
      continue
    }
    buckets.find((b) => b.test(session.updatedAt))!.sessions.push(session)
  }
  const groups = buckets.filter((b) => b.sessions.length).map(({ label, sessions }) => ({ label, sessions }))
  return pinned.length ? [{ label: 'Pinned', sessions: pinned }, ...groups] : groups
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
