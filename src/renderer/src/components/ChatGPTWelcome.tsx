import { ExternalLink } from 'lucide-react'
import { openExternal } from '../lib/platform'
import { CHATGPT_USAGE_URL } from '../lib/providers/chatgpt'
import { useStore } from '../store'
import { Button, Dialog } from './ui'

/** Shown once, after the first sign-in that allows Parallax to use the user's ChatGPT plan. */
export function ChatGPTWelcome() {
  const open = useStore((s) => s.chatgptWelcomeOpen)
  const setOpen = useStore((s) => s.setChatGPTWelcomeOpen)
  const updateSettings = useStore((s) => s.updateSettings)
  const dismiss = () => {
    updateSettings({ chatgptWelcomeSeen: true })
    setOpen(false)
  }
  return (
    <Dialog open={open} onClose={dismiss} title="ChatGPT plan" className="max-w-md">
      <div className="space-y-4 p-6 text-center">
        <h3 className="text-xl font-semibold">You're using your ChatGPT plan</h3>
        <p className="text-sm leading-relaxed text-muted">
          Chats with the "ChatGPT plan" models in Parallax now use the usage included in your ChatGPT plan. You can review usage
          and set a limit for Parallax in ChatGPT settings.
        </p>
        <div className="flex justify-center gap-2">
          <Button onClick={() => openExternal(CHATGPT_USAGE_URL)}>
            Manage usage <ExternalLink className="size-3.5" />
          </Button>
          <Button variant="primary" onClick={dismiss}>
            Got it
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
