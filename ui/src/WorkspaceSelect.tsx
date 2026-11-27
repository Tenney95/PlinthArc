import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'

type SelectOption<T extends string> = { value: T; label: string; disabled?: boolean }
type WorkspaceSelectProps<T extends string> = {
  id?: string
  label: string
  value: T
  options: readonly SelectOption<T>[]
  onChange?(value: T): void
  compact?: boolean
  disabled?: boolean
  placement?: 'bottom' | 'top'
}

const enabledOptions = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLButtonElement>('[role="option"]:enabled')]

export function WorkspaceSelect<T extends string>({
  id, label, value, options, onChange, compact = false, disabled = false, placement = 'bottom',
}: WorkspaceSelectProps<T>) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const expanded = open && !disabled

  useLayoutEffect(() => {
    const button = trigger.current
    const popup = menu.current
    if (!expanded || !button || !popup) return
    let frame = 0

    function positionMenu() {
      if (!button || !popup) return
      const anchor = button.getBoundingClientRect()
      const above = anchor.top - 12
      const below = window.innerHeight - anchor.bottom - 12
      const desiredHeight = Math.min(320, popup.scrollHeight + 2)
      const preferred = placement === 'top' ? above : below
      const opposite = placement === 'top' ? below : above
      const usePreferred = preferred >= desiredHeight || preferred >= opposite
      const opensAbove = usePreferred === (placement === 'top')
      popup.style.maxHeight = `${Math.max(0, Math.min(320, opensAbove ? above : below))}px`
      popup.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - popup.offsetWidth - 8))}px`
      popup.style.top = `${opensAbove ? anchor.top - popup.offsetHeight - 4 : anchor.bottom + 4}px`
    }

    function queuePosition() {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(positionMenu)
    }

    function dismissOutside(event: PointerEvent) {
      if (event.target instanceof Node && !button?.contains(event.target) && !popup?.contains(event.target)) setOpen(false)
    }

    positionMenu()
    const choices = enabledOptions(popup)
    const first = choices.find((option) => option.getAttribute('aria-selected') === 'true') ?? choices[0] ?? popup
    first.focus({ preventScroll: true })
    popup.scrollTop = Math.max(0, first.offsetTop - (popup.clientHeight - first.offsetHeight) / 2)
    document.addEventListener('pointerdown', dismissOutside, true)
    window.addEventListener('resize', queuePosition)
    window.addEventListener('scroll', queuePosition, true)
    window.addEventListener('wheel', queuePosition, { capture: true, passive: true })
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', dismissOutside, true)
      window.removeEventListener('resize', queuePosition)
      window.removeEventListener('scroll', queuePosition, true)
      window.removeEventListener('wheel', queuePosition, true)
    }
  }, [expanded, placement])

  function closeAndFocus() {
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
  }

  function handleMenuKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.stopPropagation()
      if (event.key === 'Escape') event.preventDefault()
      closeAndFocus()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const choices = enabledOptions(event.currentTarget)
    if (choices.length === 0) return
    const current = choices.findIndex((option) => option === document.activeElement)
    let index = 0
    if (event.key === 'End') index = choices.length - 1
    if (event.key === 'ArrowDown') index = (current + 1) % choices.length
    if (event.key === 'ArrowUp') index = current <= 0 ? choices.length - 1 : current - 1
    choices[index]?.focus()
  }

  return <div className={`ui-select${compact ? ' ui-select--sm' : ''}`}>
    <button ref={trigger} id={id} type="button" className="ui-select__trigger" disabled={disabled}
      aria-label={label} aria-haspopup="listbox" aria-expanded={expanded} aria-controls={expanded ? menuId : undefined}
      onClick={() => setOpen((current) => !current)} onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        event.stopPropagation()
        setOpen(true)
      }}>
      <span>{options.find((option) => option.value === value)?.label ?? value}</span>
      <ChevronDown size={compact ? 12 : 14} className="ui-select__chevron" aria-hidden="true" />
    </button>
    {expanded && createPortal(<div ref={menu} id={menuId} role="listbox" tabIndex={-1} aria-label={label}
      className="ui-menu ui-select__menu" onKeyDown={handleMenuKeys}
      onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)
          && !trigger.current?.contains(event.relatedTarget)) setOpen(false)
      }}>
      {options.map((option) => <button key={option.value} type="button" role="option" tabIndex={-1}
        className="ui-menu__item" aria-selected={value === option.value} disabled={option.disabled}
        onClick={() => { closeAndFocus(); onChange?.(option.value) }}>
        {option.label}
      </button>)}
    </div>, document.body)}
  </div>
}
