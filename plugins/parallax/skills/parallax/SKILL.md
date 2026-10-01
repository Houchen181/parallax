---
name: parallax
description: Ask other AI models (Claude, GPT, Gemini, OpenRouter, local models) the same question in parallel, or run a group discussion between them, with the Parallax tools. Use when the user wants a second opinion, wants to compare models, cross-check an answer, or have models debate or critique something.
---

# Parallax: ask several models at once

Parallax sends prompts to other AI models with the user's own API keys and returns their replies. It has five tools:

| Tool | Use it to |
| --- | --- |
| `list_models` | See which providers are set up and their `provider:model` ids. Pass `search` to find a model. |
| `ask_models` | Send one prompt to several models in parallel and get every answer. |
| `group_discussion` | Let models take turns replying to each other over a few rounds. |
| `get_results` | Collect replies from a job that was still running when the call returned. |
| `configure_keys` | Open a page in the user's browser to add, test or remove API keys. |

## Workflow

1. **Pick the models.** Use the ones the user names. Map names to ids with `list_models` (e.g. `search: "gemini"`) when you are unsure of the exact id. If the user names none, leave `models` out (the user's default models are used, if set) or pick one strong model from each of two or three ready providers. For Claude models without an Anthropic API key, see [Claude models on the user's Claude plan](#claude-models-on-the-users-claude-plan-claude-code).
2. **Write a self-contained prompt.** The other models don't see this conversation. Include the question, the relevant code or text, any constraints, and the kind of answer you want. Don't include secrets or private data the user hasn't agreed to share with those providers.
3. **Choose the tool.**
   - Independent answers to compare: `ask_models`.
   - Models reacting to each other: `group_discussion`. Two rounds are usually enough. Use `persona` to assign roles, for example one participant argues for a plan and another against it.
4. **Collect everything.** If the result says models are still answering, call `get_results` with the `job_id` (keep calling until it reports they finished). If a call timed out before you got a `job_id`, call `get_results` without one.
5. **Report faithfully.**
   - Attribute each reply to its model.
   - Summarize where the models agree and where they differ. Quote short key passages when the exact wording matters.
   - Say plainly when a model failed or declined, and why. Never invent or fill in a reply.
   - Add your own view separately, labeled as yours.

## Claude models on the user's Claude plan (Claude Code)

Parallax's tools need an Anthropic API key to call Claude. In Claude Code, Claude models can instead run as subagents, which use the user's Claude plan (the usage limits of Pro, Max, Team or Enterprise) rather than API credits. Do this when the user wants Claude models on their plan, or when `list_models` shows Anthropic isn't set up.

- **Side by side:** start one `parallax:panelist` subagent per Claude model, all in the same message so they run in parallel. Set each one's `model` (for example `opus`, `sonnet` or `haiku`) and give every one the same self-contained prompt. Ask models from other providers with `ask_models` at the same time.
- **Discussion:** run the turns yourself, one at a time. For each turn, start a `parallax:panelist` subagent with that participant's model and a prompt holding the topic, the transcript so far as `[Name]: text` lines, and the name it speaks as. For a participant from another provider, send the same kind of prompt to that one model with `ask_models`. Two rounds are usually enough.
- Label each reply with the model that wrote it, e.g. "Claude Opus (subagent)", and report the replies as described above.
- Only Claude Code's own subagents can use the plan. Anthropic doesn't allow other tools, Parallax included, to send requests through plan usage.

## Keys and setup

- If `list_models` shows no ready provider, or the user wants another one, call `configure_keys`. It opens a local page where the user pastes keys. Wait until they say they're done, then call `list_models`.
- Never ask the user to paste an API key into the chat. If they do anyway, tell them to use the key page instead, and suggest they revoke that key because it is now in the chat history.
- In Claude Code and Claude Desktop, keys can also be entered in the plugin or extension settings.
- Parallax calls use the user's API credits, and subagents use their Claude plan's limits. Don't ask many models or run long discussions without a reason.
