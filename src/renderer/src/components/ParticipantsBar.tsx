import { useState } from 'react'
import { Plus, SlidersHorizontal, Trash2, VolumeX, Volume2, Replace } from 'lucide-react'
import { handleFor } from '../lib/prompt'
import type { Participant, Session, SpeakingOrder } from '../lib/types'
import { modelLabel, useStore } from '../store'
import { ModelPicker } from './ModelPicker'
import { Avatar, Button, IconButton, Popover, Segmented, cn, inputClass } from './ui'

function ParticipantEditor({
  session,
  participant,
  anchor,
  onClose,
}: {
  session: Session
  participant: Participant
  anchor: HTMLElement | null
  onClose: () => void
}) {
  const update = useStore((s) => s.updateParticipant)
  const remove = useStore((s) => s.removeParticipant)
  const provider = useStore((s) => s.providers.find((p) => p.id === participant.providerId))
  const [picker, setPicker] = useState<HTMLElement | null>(null)

  return (
    <Popover anchor={anchor} open onClose={onClose} className="w-80 p-3">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Avatar color={participant.color} name={participant.name} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{participant.name}</div>
            <div className="truncate text-xs text-muted">
              {provider?.name ?? 'Removed provider'} · {modelLabel(provider, participant.modelId)}
            </div>
          </div>
          <IconButton label="Change model" onClick={(e) => setPicker(e.currentTarget)}>
            <Replace className="size-4" />
          </IconButton>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">
            Name <span className="font-normal text-subtle">(mention with @{handleFor(participant.name) || 'name'})</span>
          </span>
          <input
            className={inputClass}
            value={participant.name}
            onChange={(e) => update(session.id, participant.id, { name: e.target.value })}
            onBlur={(e) => {
              if (!e.target.value.trim()) update(session.id, participant.id, { name: modelLabel(provider, participant.modelId) })
            }}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Persona or extra instructions</span>
          <textarea
            className={cn(inputClass, 'min-h-20 resize-y')}
            placeholder="e.g. You are a careful reviewer who looks for flaws in other answers."
            value={participant.systemPrompt ?? ''}
            onChange={(e) => update(session.id, participant.id, { systemPrompt: e.target.value })}
          />
        </label>
        <div className="flex justify-between gap-2">
          <Button size="sm" onClick={() => update(session.id, participant.id, { muted: !participant.muted })}>
            {participant.muted ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
            {participant.muted ? 'Let it speak' : 'Sit out'}
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              remove(session.id, participant.id)
              onClose()
            }}
          >
            <Trash2 className="size-3.5" /> Remove
          </Button>
        </div>
      </div>
      <ModelPicker
        anchor={picker}
        open={!!picker}
        onClose={() => setPicker(null)}
        selected={{ providerId: participant.providerId, modelId: participant.modelId }}
        onSelect={(ref) => {
          update(session.id, participant.id, { ...ref })
          setPicker(null)
        }}
      />
    </Popover>
  )
}

function GroupOptions({ session, anchor, onClose }: { session: Session; anchor: HTMLElement | null; onClose: () => void }) {
  const global = useStore((s) => s.settings.group)
  const updateSession = useStore((s) => s.updateSession)
  const rounds = session.rounds ?? global.rounds
  const order = session.order ?? global.order
  return (
    <Popover anchor={anchor} open onClose={onClose} align="end" className="w-72 p-3">
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted">Rounds after each message</div>
          <div className="flex items-center gap-2">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => updateSession(session.id, { rounds: n })}
                className={cn(
                  'size-8 rounded-lg border text-sm',
                  rounds === n ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-hover',
                )}
              >
                {n}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-subtle">Each model speaks once per round, so they can reply to each other.</p>
        </div>
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted">Speaking order</div>
          <Segmented<SpeakingOrder>
            value={order}
            onChange={(value) => updateSession(session.id, { order: value })}
            options={[
              { value: 'sequential', label: 'In order' },
              { value: 'random', label: 'Shuffled' },
            ]}
          />
        </div>
        <p className="text-xs leading-relaxed text-subtle">
          Start a message with <span className="font-mono">@name</span> to hear from specific models only.
        </p>
      </div>
    </Popover>
  )
}

export function ParticipantsBar({ session }: { session: Session }) {
  const addParticipant = useStore((s) => s.addParticipant)
  const [adding, setAdding] = useState<HTMLElement | null>(null)
  const [editing, setEditing] = useState<{ id: string; anchor: HTMLElement } | null>(null)
  const [options, setOptions] = useState<HTMLElement | null>(null)
  const editingParticipant = editing ? session.participants.find((p) => p.id === editing.id) : undefined

  return (
    <div className="flex min-w-0 items-center gap-1">
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {session.participants.map((p) => (
          <button
            key={p.id}
            type="button"
            title={`${p.name}${p.muted ? ' (sitting out)' : ''}`}
            onClick={(e) => setEditing({ id: p.id, anchor: e.currentTarget })}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-full border border-line py-0.5 pl-0.5 pr-2.5 text-xs hover:bg-hover',
              p.muted && 'opacity-45',
            )}
          >
            <Avatar color={p.color} name={p.name} size="sm" />
            <span className="max-w-28 truncate">{p.name}</span>
          </button>
        ))}
      </div>
      <IconButton label="Add a model to this chat" onClick={(e) => setAdding(e.currentTarget)}>
        <Plus className="size-4" />
      </IconButton>
      <IconButton label="Group chat options" onClick={(e) => setOptions(e.currentTarget)}>
        <SlidersHorizontal className="size-4" />
      </IconButton>
      <ModelPicker
        anchor={adding}
        open={!!adding}
        onClose={() => setAdding(null)}
        onSelect={(ref) => addParticipant(session.id, ref)}
      />
      {editing && editingParticipant && (
        <ParticipantEditor
          session={session}
          participant={editingParticipant}
          anchor={editing.anchor}
          onClose={() => setEditing(null)}
        />
      )}
      {options && <GroupOptions session={session} anchor={options} onClose={() => setOptions(null)} />}
    </div>
  )
}
