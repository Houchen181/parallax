import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:opacity-90 disabled:opacity-40',
  secondary: 'border border-line bg-surface text-fg hover:bg-hover disabled:opacity-50',
  ghost: 'text-fg hover:bg-hover disabled:opacity-40',
  danger: 'border border-danger/40 text-danger hover:bg-danger-soft disabled:opacity-50',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:pointer-events-none',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  )
}

export function IconButton({
  label,
  className,
  active,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40',
        active && 'bg-hover text-fg',
        className,
      )}
      {...props}
    />
  )
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40',
        checked ? 'bg-accent' : 'bg-line',
      )}
    >
      <span
        className={cn(
          'inline-block size-4 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-sidebar p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-md px-3 py-1 text-sm transition-colors',
            value === option.value ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export const inputClass =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-subtle outline-none focus:border-accent'

export function SettingRow({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-line py-4 last:border-b-0">
      <div className="min-w-0">
        <div className="text-sm font-medium text-fg">{title}</div>
        {description && <div className="mt-0.5 text-[13px] leading-relaxed text-muted">{description}</div>}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  )
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  className,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  className?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[1px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn('fade-in flex max-h-full w-full flex-col overflow-hidden rounded-2xl border border-line bg-app shadow-2xl', className)}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}

// Open popovers, innermost last. Only the innermost reacts to outside clicks and
// Escape, so a picker opened from inside another popover doesn't close its parent.
const popoverStack: number[] = []
let nextPopoverId = 1

/** A floating panel attached to an anchor element; closes on outside click or Escape. */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  align = 'start',
  className,
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  children: ReactNode
  align?: 'start' | 'end'
  className?: string
}) {
  const panel = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' })

  useLayoutEffect(() => {
    if (!open || !anchor) return
    const place = () => {
      const rect = anchor.getBoundingClientRect()
      const el = panel.current
      const width = el?.offsetWidth ?? 280
      const height = el?.offsetHeight ?? 300
      const margin = 8
      let left = align === 'end' ? rect.right - width : rect.left
      left = Math.max(margin, Math.min(left, window.innerWidth - width - margin))
      const below = window.innerHeight - rect.bottom
      const top =
        below >= height + margin || below >= rect.top ? rect.bottom + 6 : Math.max(margin, rect.top - height - 6)
      setStyle({ left, top, visibility: 'visible' })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchor, align])

  const onCloseRef = useRef(onClose)
  const anchorRef = useRef(anchor)
  useLayoutEffect(() => {
    onCloseRef.current = onClose
    anchorRef.current = anchor
  })

  useEffect(() => {
    if (!open) return
    const id = nextPopoverId++
    popoverStack.push(id)
    const isTop = () => popoverStack[popoverStack.length - 1] === id
    const onDown = (event: MouseEvent) => {
      if (!isTop()) return
      const target = event.target as Node
      if (panel.current?.contains(target) || anchorRef.current?.contains(target)) return
      onCloseRef.current()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isTop()) {
        event.stopPropagation()
        onCloseRef.current()
      }
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      const index = popoverStack.indexOf(id)
      if (index >= 0) popoverStack.splice(index, 1)
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  if (!open) return null
  return createPortal(
    <div
      ref={panel}
      style={style}
      className={cn('fade-in fixed z-50 rounded-xl border border-line bg-raised p-1 shadow-xl', className)}
    >
      {children}
    </div>,
    document.body,
  )
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
  disabled,
}: {
  icon?: ReactNode
  children: ReactNode
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-hover disabled:opacity-40',
        danger ? 'text-danger' : 'text-fg',
      )}
    >
      {icon && <span className="flex size-4 items-center justify-center text-muted">{icon}</span>}
      {children}
    </button>
  )
}

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="12" cy="13" r="7.5" fill="#7c5cff" opacity="0.9" />
      <circle cx="20" cy="13" r="7.5" fill="#14b8a6" opacity="0.8" />
      <circle cx="16" cy="20" r="7.5" fill="#f97362" opacity="0.8" />
    </svg>
  )
}

export function Avatar({ color, name, size = 'md' }: { color: string; name: string; size?: 'sm' | 'md' }) {
  const initial = name.trim().charAt(0).toUpperCase() || '?'
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white',
        size === 'sm' ? 'size-5 text-[10px]' : 'size-7 text-xs',
      )}
      style={{ backgroundColor: color }}
      aria-hidden="true"
    >
      {initial}
    </span>
  )
}

export function Dot({ color }: { color: string }) {
  return <span className="inline-block size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
}
