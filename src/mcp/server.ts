// The Parallax MCP server: lets Claude, Codex and other MCP hosts ask several
// models at once or run a group discussion between them, with the user's own
// API keys. It reuses the desktop app's provider adapters and prompt builders.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import { z } from 'zod'
import { localDataDir, openInBrowser } from '../server/system'
import { formatAsk, formatGroup } from './format'
import { AskJob, GroupJob, JobStore, type AnyJob, type GroupMember } from './jobs'
import { startKeyPage, type KeyPage } from './keypage'
import { envValue, Registry, type ProviderState, type ResolvedModel } from './providers'

export interface ParallaxServerOptions {
  env?: NodeJS.ProcessEnv
  /** Where keys are kept; defaults to the local web version's folder. */
  dataDir?: string
  openUrl?: (url: string) => Promise<void>
  fetch?: typeof fetch
  /** How long a tool call waits for a job; overrides PARALLAX_WAIT_SECONDS. */
  waitMs?: number
}

export interface ParallaxServer {
  server: McpServer
  registry: Registry
  close(): Promise<void>
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>

const INSTRUCTIONS = `Parallax asks other AI models (Claude, GPT, Gemini, OpenRouter, local models and more) with the user's own API keys.
- ask_models sends one prompt to several models in parallel: second opinions, comparisons, cross-checking.
- group_discussion lets models take turns replying to each other: debates, critiques, brainstorming.
- Models are named provider:model, e.g. "anthropic:claude-opus-5-5". list_models shows what is set up.
- The other models see only the prompt you send, not this conversation, so include the context they need.
- Long jobs return what has finished plus a job_id; call get_results to collect the rest.
- Report each model's answer faithfully and never invent a reply for a model that failed.
- If no provider is set up, call configure_keys. Never ask the user to paste an API key into the chat.`

function numberSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const value = Number(envValue(env, name))
  return Number.isFinite(value) && value > 0 ? Math.min(max, Math.max(min, value)) : fallback
}

function text(content: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: content }], ...(isError ? { isError: true } : {}) }
}

function readySummary(registry: Registry): string {
  const ready = registry.ready()
  return ready.length
    ? `Set up: ${ready.map((p) => p.id).join(', ')}. Call list_models for model ids.`
    : 'No provider is set up yet. Call configure_keys so the user can add API keys.'
}

function describeSource(state: ProviderState): string {
  if (state.keyless) return 'no key needed'
  if (!state.key) return ''
  if (state.key.source === 'plugin') return 'key from the plugin settings'
  if (state.key.source === 'saved') return 'key from the Parallax key page'
  return `key from the ${state.key.from} environment variable`
}

export function createParallaxServer(options: ParallaxServerOptions = {}): ParallaxServer {
  const env = options.env ?? process.env
  const dataDir = options.dataDir ?? localDataDir(env)
  const openUrl = options.openUrl ?? openInBrowser
  const registry = new Registry({ env, dataDir })
  registry.installTransport(options.fetch)
  const jobs = new JobStore()
  // How long one tool call waits before returning partial results. Codex and
  // Claude Desktop give a tool call about 60 seconds.
  const waitMs = options.waitMs ?? numberSetting(env, 'PARALLAX_WAIT_SECONDS', 45, 1, 3600) * 1000
  const maxChars = numberSetting(env, 'PARALLAX_MAX_RESULT_CHARS', 40_000, 2_000, 1_000_000)
  const defaultModels = (envValue(env, 'PARALLAX_DEFAULT_MODELS') ?? '').split(/[\s,]+/).filter(Boolean)
  let keyPage: KeyPage | undefined

  const server = new McpServer({ name: 'parallax', title: 'Parallax', version: __APP_VERSION__ }, { instructions: INSTRUCTIONS })

  /** Resolves model references, first fetching (briefly) any model list not cached yet, for names and capabilities. */
  async function resolveAll(refs: string[]) {
    const providers = new Set<ProviderState>()
    for (const ref of refs) {
      const result = registry.resolveModel(ref)
      if (!('error' in result)) providers.add(result.provider)
    }
    await Promise.all([...providers].map((p) => registry.models(p, { signal: AbortSignal.timeout(3000) })))
    return refs.map((ref) => ({ ref, result: registry.resolveModel(ref) }))
  }

  /** Waits for a job (up to the limit), reporting progress to hosts that asked for it. */
  async function respond(job: AnyJob, extra: Extra): Promise<CallToolResult> {
    const progressToken = extra._meta?.progressToken
    const stopProgress =
      progressToken === undefined
        ? () => undefined
        : job.onChange(() => {
            const { done, total, message } = job.progress
            void extra
              .sendNotification({ method: 'notifications/progress', params: { progressToken, progress: done, total, message } })
              .catch(() => undefined)
          })
    try {
      await job.wait(waitMs, extra.signal)
    } finally {
      stopProgress()
    }
    if (job instanceof AskJob) {
      const failed = job.finished && job.replies.every((r) => r.status === 'error' || r.status === 'stopped')
      return text(formatAsk(job, maxChars), failed)
    }
    const failed = job.finished && !job.turns.some((t) => t.status === 'done')
    return text(formatGroup(job, maxChars), failed)
  }

  server.registerTool(
    'list_models',
    {
      title: 'List models',
      description:
        'Shows which AI providers Parallax can use with the API keys the user set up, and the models each one offers, as provider:model ids for ask_models and group_discussion.',
      inputSchema: {
        provider: z.string().optional().describe('Only this provider, e.g. "openai" or "openrouter".'),
        search: z.string().optional().describe('Only models whose id or name contains this text, e.g. "sonnet" or "llama".'),
        refresh: z.boolean().optional().describe('Fetch the model lists again instead of using the 10-minute cache.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ provider, search, refresh }, extra) => {
      await registry.refresh()
      let providers = registry.all()
      if (provider) {
        const wanted = registry.get(provider.trim().toLowerCase())
        if (!wanted) return text(`Unknown provider "${provider}". Providers: ${providers.map((p) => p.id).join(', ')}.`, true)
        providers = [wanted]
      }
      const needle = search?.trim().toLowerCase()
      const limit = needle ? 100 : provider ? 300 : 25
      const sections: string[] = []
      const notSetUp: string[] = []
      const notRunning: string[] = []
      const listings = await Promise.all(
        providers.map(async (state) => ({ state, listing: state.problem ? undefined : await registry.models(state, { refresh, signal: extra.signal }) })),
      )
      for (const { state, listing } of listings) {
        if (!listing) {
          notSetUp.push(`${state.id} (${state.problem})`)
          continue
        }
        if (listing.error && state.keyless && !provider) {
          notRunning.push(`${state.id} at ${state.config.baseUrl}`)
          continue
        }
        const head = `${state.preset.name} [${state.id}]: ${listing.error ? `error: ${listing.error}` : `ready, ${describeSource(state)}`}`
        if (!listing.models) {
          sections.push(head)
          continue
        }
        const models = listing.models.filter((m) => !needle || m.id.toLowerCase().includes(needle) || m.label?.toLowerCase().includes(needle))
        if (needle && !models.length) continue
        const lines = models.slice(0, limit).map((m) => `  ${state.id}:${m.id}${m.label && m.label !== m.id ? `  (${m.label})` : ''}`)
        if (models.length > limit) lines.push(`  …and ${models.length - limit} more. Narrow with search or provider.`)
        if (!models.length) lines.push('  (the provider listed no models)')
        sections.push([head, ...lines].join('\n'))
      }

      const out: string[] = []
      if (sections.length) out.push(sections.join('\n\n'))
      else if (needle) out.push(`No models match "${search}".`)
      if (notSetUp.length && !needle) out.push(`Not set up: ${notSetUp.join(', ')}. The user can add keys with configure_keys.`)
      if (notRunning.length && !needle) out.push(`Not running on this computer: ${notRunning.join(', ')}.`)
      if (!registry.ready().length) {
        out.push(
          'No provider is set up yet, so call configure_keys to let the user add API keys in their browser. ' +
            'To try the tools without keys, the simulated models demo:demo-concise, demo:demo-thorough and demo:demo-skeptic give canned replies (not real model output).',
        )
      }
      return text(out.join('\n\n'))
    },
  )

  server.registerTool(
    'ask_models',
    {
      title: 'Ask models',
      description:
        "Sends one prompt to several AI models at once and returns each model's answer, for second opinions, comparing models or cross-checking an answer. " +
        'The models see only this prompt (not your conversation), so include all the context they need. ' +
        'If some models are still answering when the call returns, the result says so and gives a job_id for get_results.',
      inputSchema: {
        prompt: z.string().min(1).describe('The full message to send to every model.'),
        models: z
          .array(z.string())
          .min(1)
          .max(8)
          .optional()
          .describe('provider:model ids from list_models, e.g. ["anthropic:claude-opus-5-5", "openai:gpt-5"]. Optional when the user set default models.'),
        system: z.string().optional().describe('A system prompt for every model.'),
        max_output_tokens: z.number().int().min(16).max(128_000).optional().describe('Output limit per model, including any thinking (default 8000).'),
        temperature: z.number().min(0).max(2).optional().describe('Sampling temperature, for models that accept one.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ prompt, models, system, max_output_tokens, temperature }, extra) => {
      await registry.refresh()
      const refs = [...new Set((models?.length ? models : defaultModels).map((m) => m.trim()).filter(Boolean))]
      if (!refs.length) return text(`Say which models to ask, as provider:model ids. ${readySummary(registry)}`, true)
      const resolved = await resolveAll(refs)
      const targets = resolved.flatMap(({ result }) => ('error' in result ? [] : [result]))
      const problems = resolved.flatMap(({ ref, result }) => ('error' in result ? [{ ref, error: result.error }] : []))
      if (!targets.length) return text(`${problems.map((p) => p.error).join('\n')}\n\n${readySummary(registry)}`, true)
      const job = jobs.add(
        new AskJob({
          prompt,
          system,
          models: targets,
          problems,
          maxOutputTokens: max_output_tokens ?? 8000,
          temperature: temperature ?? null,
        }),
      )
      return respond(job, extra)
    },
  )

  server.registerTool(
    'group_discussion',
    {
      title: 'Group discussion',
      description:
        'Puts several AI models in one conversation: they take turns, each seeing what the others said, for a set number of rounds. ' +
        'Good for debates, critiquing a plan from several angles, or brainstorming. Returns the transcript; long discussions return a job_id for get_results.',
      inputSchema: {
        topic: z.string().min(1).describe('What to discuss: a question, a claim to debate, a draft to critique. Include all the context the models need.'),
        participants: z
          .array(
            z.object({
              model: z.string().describe('provider:model id from list_models.'),
              name: z.string().optional().describe('Display name in the transcript (default: the model name).'),
              persona: z.string().optional().describe('Extra instructions for this participant, e.g. "Argue against the proposal."'),
            }),
          )
          .min(2)
          .max(6),
        rounds: z.number().int().min(1).max(4).optional().describe('How many times each participant speaks (default 2).'),
        order: z.enum(['sequential', 'random']).optional().describe('Speaking order within a round (default sequential).'),
        system: z.string().optional().describe('Instructions shared by every participant.'),
        max_output_tokens_per_turn: z.number().int().min(16).max(32_000).optional().describe('Output limit for each turn (default 1500).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ topic, participants, rounds, order, system, max_output_tokens_per_turn }, extra) => {
      await registry.refresh()
      const resolved = (await resolveAll(participants.map((p) => p.model))).map(({ result }, i) => ({ p: participants[i], result }))
      const problems = resolved.flatMap(({ result }) => ('error' in result ? [result.error] : []))
      if (problems.length) return text(`${problems.join('\n')}\n\n${readySummary(registry)}`, true)
      const taken = new Set<string>()
      const members: GroupMember[] = resolved.map(({ p, result }) => {
        const target = result as ResolvedModel
        const base = p.name?.trim() || target.label
        // "User" and "System" label other speakers in the transcript.
        let name = /^(user|system)$/i.test(base) ? `${base} (AI)` : base
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`
        taken.add(name.toLowerCase())
        return { target, name, persona: p.persona?.trim() || undefined }
      })
      const job = jobs.add(
        new GroupJob({
          topic,
          system,
          members,
          rounds: rounds ?? 2,
          order: order ?? 'sequential',
          maxOutputTokens: max_output_tokens_per_turn ?? 1500,
        }),
      )
      return respond(job, extra)
    },
  )

  server.registerTool(
    'get_results',
    {
      title: 'Get results',
      description:
        'Collects answers from an ask_models or group_discussion job that was still running, waiting a while for more. ' +
        'Without job_id it uses the most recent job, which also helps when a call timed out before returning its job_id.',
      inputSchema: {
        job_id: z.string().optional().describe('The job_id from ask_models or group_discussion.'),
        stop: z.boolean().optional().describe('Stop the job now and return what it has.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ job_id, stop }, extra) => {
      const job = job_id ? jobs.get(job_id) : jobs.latest()
      if (!job) {
        return text(job_id ? `No job "${job_id}". Jobs are kept for 30 minutes after they finish.` : 'There are no Parallax jobs yet.', true)
      }
      if (stop) {
        job.stop()
        await job.wait(5000)
      }
      return respond(job, extra)
    },
  )

  server.registerTool(
    'configure_keys',
    {
      title: 'Set up API keys',
      description:
        "Opens a Parallax page in the user's browser where they can add, test or remove API keys for model providers (Anthropic, OpenAI, Google Gemini, OpenRouter and others). " +
        'Use it when list_models shows no ready provider or the user wants to add one. Keys go from the browser to this computer, never through the chat.',
      inputSchema: {
        provider: z.string().optional().describe('Provider to scroll to, e.g. "gemini".'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ provider }) => {
      await registry.refresh()
      keyPage ??= await startKeyPage({
        registry,
        dataDir,
        onClose: () => {
          keyPage = undefined
        },
      })
      const focus = provider ? registry.get(provider.trim().toLowerCase())?.id : undefined
      const url = focus ? `${keyPage.url}#provider=${focus}` : keyPage.url
      await openUrl(url)
      return text(
        `Opened the Parallax key page in the browser. If it didn't open, the user can visit ${url}\n\n` +
          `Keys are saved on this computer in ${dataDir} and shared with the Parallax web version. ` +
          'When the user says they are done, call list_models to see what is ready.',
      )
    },
  )

  return {
    server,
    registry,
    async close() {
      jobs.stopAll()
      await keyPage?.close()
      await server.close()
    },
  }
}
