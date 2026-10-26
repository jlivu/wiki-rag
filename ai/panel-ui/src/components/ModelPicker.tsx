import { useCallback, useEffect, useRef, useState } from 'react'

import {
  selectionLabel, type EffortLevel, type ModelAvailability, type ModelGroup
} from '@shared'

import { CaretIcon, CheckIcon } from './Icons'

/**
 * Which model answers, and how hard it works.
 *
 * The panel is 400px wide and this app cannot draw outside its frame,
 * so a submenu replaces the menu's contents instead of opening beside
 * it, with a back control at the top. The menu opens upwards, because
 * the button sits at the bottom of the panel.
 */
interface Props {
  models: ModelAvailability[]
  selectedId: string
  effort: EffortLevel | null
  onSelectModel: (id: string) => void
  onSelectEffort: (effort: EffortLevel) => void
}

type View = 'root' | 'effort' | 'models'

const GROUP_ORDER: ModelGroup[] = ['Cloud', 'On this Mac', 'Dev']

const EFFORT_INTRO =
  'Higher effort gives more thorough answers, but takes longer and costs more.'

export function ModelPicker ({ models, selectedId, effort, onSelectModel, onSelectEffort }: Props) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>('root')
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  // Set when a view opens, so focus lands on the first item rather than
  // staying on whatever was clicked.
  const wantsFocus = useRef(false)

  const current = models.find(model => model.id === selectedId)

  const close = useCallback((returnFocus = true) => {
    setOpen(false)
    setView('root')
    if (returnFocus) { button.current?.focus() }
  }, [])

  const go = useCallback((next: View) => {
    wantsFocus.current = true
    setView(next)
  }, [])

  // Opening, and every change of view, puts focus on the first item.
  useEffect(() => {
    if (!open || !wantsFocus.current) { return }
    wantsFocus.current = false
    items(menu.current)[0]?.focus()
  }, [open, view])

  useEffect(() => {
    if (!open) { return }
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (menu.current?.contains(target) || button.current?.contains(target)) { return }
      close(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [open, close])

  const onKeyDown = (event: React.KeyboardEvent) => {
    const all = items(menu.current)
    const at = all.indexOf(document.activeElement as HTMLElement)
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        all[(at + 1) % all.length]?.focus()
        break
      case 'ArrowUp':
        event.preventDefault()
        all[(at - 1 + all.length) % all.length]?.focus()
        break
      case 'Home':
        event.preventDefault()
        all[0]?.focus()
        break
      case 'End':
        event.preventDefault()
        all[all.length - 1]?.focus()
        break
      case 'ArrowLeft':
        // Out of a submenu, the way a menu usually works.
        if (view !== 'root') { event.preventDefault(); go('root') }
        break
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        // One press leaves a submenu; the next closes the menu.
        if (view === 'root') { close() } else { go('root') }
        break
      case 'Tab':
        close(false)
        break
    }
  }

  if (!current) { return null }

  const chooseModel = (model: ModelAvailability) => {
    if (!model.available) { return }
    onSelectModel(model.id)
    close()
  }

  const chooseEffort = (level: EffortLevel) => {
    onSelectEffort(level)
    close()
  }

  const currentEffort = current.efforts.find(level => level.id === effort)
  const others = models.filter(model => model.id !== current.id)

  return (
    <div className="picker">
      <button
        ref={button}
        type="button"
        className="picker-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Model: ${selectionLabel(current, effort)}. Choose the model and effort.`}
        onClick={() => {
          if (open) { close() } else { wantsFocus.current = true; setOpen(true) }
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault()
            wantsFocus.current = true
            setOpen(true)
          }
        }}
      >
        <span className="picker-button-text">{selectionLabel(current, effort)}</span>
        <span className="picker-button-caret" aria-hidden="true"><CaretIcon /></span>
      </button>

      {open
        ? (
          <div
            ref={menu}
            className="picker-menu"
            role="menu"
            aria-label={view === 'effort' ? 'Effort' : view === 'models' ? 'More models' : 'Model and effort'}
            onKeyDown={onKeyDown}
          >
            {view === 'root'
              ? (
                <>
                  <div className="picker-section">
                    <button
                      type="button"
                      className="picker-item is-current"
                      role="menuitemradio"
                      aria-checked="true"
                      onClick={() => { close() }}
                    >
                      <span className="picker-tick" aria-hidden="true"><CheckIcon /></span>
                      <span className="picker-text">
                        <span className="picker-name">{current.label}</span>
                        <span className="picker-note">{current.note}</span>
                      </span>
                    </button>
                  </div>
                  <div className="picker-section">
                    {current.efforts.length > 0
                      ? (
                        <button
                          type="button"
                          className="picker-item picker-row"
                          role="menuitem"
                          aria-haspopup="menu"
                          onClick={() => { go('effort') }}
                        >
                          <span className="picker-row-label">Effort</span>
                          <span className="picker-row-value">{currentEffort?.label ?? '—'}</span>
                          <span className="picker-caret" aria-hidden="true"><CaretIcon /></span>
                        </button>
                        )
                      : null}
                    <button
                      type="button"
                      className="picker-item picker-row"
                      role="menuitem"
                      aria-haspopup="menu"
                      onClick={() => { go('models') }}
                    >
                      <span className="picker-row-label">More models</span>
                      <span className="picker-caret" aria-hidden="true"><CaretIcon /></span>
                    </button>
                  </div>
                </>
                )
              : null}

            {view === 'effort'
              ? (
                <>
                  <Back label="Effort" onBack={() => { go('root') }} />
                  <p className="picker-intro">{EFFORT_INTRO}</p>
                  <div className="picker-section">
                    {current.efforts.map(level => (
                      <button
                        key={level.id}
                        type="button"
                        className="picker-item"
                        role="menuitemradio"
                        aria-checked={level.id === effort}
                        onClick={() => { chooseEffort(level.id) }}
                      >
                        <span className="picker-tick" aria-hidden="true">
                          {level.id === effort ? <CheckIcon /> : null}
                        </span>
                        <span className="picker-text">
                          <span className="picker-name">
                            {level.label}
                            {level.id === current.defaultEffort
                              ? <span className="picker-badge">Recommended</span>
                              : null}
                          </span>
                          <span className="picker-note">{level.note}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </>
                )
              : null}

            {view === 'models'
              ? (
                <>
                  <Back label="More models" onBack={() => { go('root') }} />
                  {GROUP_ORDER.map(group => {
                    const inGroup = others.filter(model => model.group === group)
                    if (inGroup.length === 0) { return null }
                    return (
                      <div className="picker-section" key={group} role="group" aria-label={group}>
                        {/* The group is already labelled; this is its seen half. */}
                        <p className="picker-group" aria-hidden="true">{group}</p>
                        {inGroup.map(model => (
                          <button
                            key={model.id}
                            type="button"
                            className={`picker-item${model.available ? '' : ' is-unavailable'}`}
                            role="menuitem"
                            aria-disabled={!model.available}
                            onClick={() => { chooseModel(model) }}
                          >
                            <span className="picker-tick" aria-hidden="true" />
                            <span className="picker-text">
                              <span className="picker-name">{model.label}</span>
                              <span className="picker-note">
                                {model.available ? model.note : model.reason}
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>
                    )
                  })}
                </>
                )
              : null}
          </div>
          )
        : null}
    </div>
  )
}

/**
 * The way out of a submenu.
 *
 * Its accessible name is just "Back": the heading beside it repeats the
 * row that opened the submenu, and the menu itself is already labelled
 * with it, so reading the word twice would say nothing new.
 */
function Back ({ label, onBack }: { label: string, onBack: () => void }) {
  return (
    <button type="button" className="picker-back" role="menuitem" aria-label="Back" onClick={onBack}>
      <span className="picker-caret" aria-hidden="true"><CaretIcon back /></span>
      <span aria-hidden="true">{label}</span>
    </button>
  )
}

/** Every focusable row in the open view, in the order they are drawn. */
function items (menu: HTMLDivElement | null): HTMLElement[] {
  return menu ? [...menu.querySelectorAll<HTMLElement>('button')] : []
}
