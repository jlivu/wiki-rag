import { useEffect, useRef } from 'react'

import type { Dictation } from '../lib/dictation'
import { CheckIcon, ChevronIcon, MicrophoneIcon, StopIcon } from './Icons'

/**
 * The microphone button, the chevron beside it, and the popover the
 * chevron opens.
 *
 * The button says what it will do and what it is doing — "Start
 * dictation", "Stop dictation" — and the recording state is visible as
 * well as audible: the button turns, the level moves with the voice, and
 * the seconds count up. Escape cancels without transcribing.
 */
export function Dictation ({ dictation, open, onOpenChange, maxSeconds }: {
  dictation: Dictation
  open: boolean
  onOpenChange: (open: boolean) => void
  maxSeconds: number
}) {
  const recording = dictation.state === 'recording'
  const transcribing = dictation.state === 'transcribing'
  const popover = useRef<HTMLDivElement>(null)
  const chevron = useRef<HTMLButtonElement>(null)

  // Escape cancels a recording outright; nothing is sent to be transcribed.
  useEffect(() => {
    if (!recording) { return }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        dictation.cancel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [dictation, recording])

  // The popover closes on Escape or on a click outside it.
  useEffect(() => {
    if (!open) { return }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onOpenChange(false)
        chevron.current?.focus()
      }
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!popover.current?.contains(target) && !chevron.current?.contains(target)) {
        onOpenChange(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('mousedown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mousedown', onPointerDown)
    }
  }, [onOpenChange, open])

  // The meter only runs while the popover is open.
  useEffect(() => {
    if (open) {
      void dictation.openMeter()
    } else if (dictation.state === 'idle') {
      dictation.closeMeter()
    }
    // dictation is rebuilt on every render; only `open` should drive this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const remaining = Math.max(0, maxSeconds - dictation.elapsed)

  return (
    <div className="mic-group">
      <button
        type="button"
        className={`mic-button${recording ? ' mic-recording' : ''}`}
        onClick={() => {
          onOpenChange(false)
          if (recording) { dictation.stop() } else { void dictation.start() }
        }}
        disabled={transcribing}
        aria-label={recording ? 'Stop dictation' : transcribing ? 'Transcribing your recording' : 'Start dictation'}
        aria-pressed={recording}
        aria-busy={transcribing}
        title={recording
          ? `Stop dictation (${remaining.toFixed(0)}s left)`
          : transcribing ? 'Transcribing…' : 'Start dictation'}
      >
        {recording
          ? (
            <>
              {/* The ring grows with the voice, so it is plainly live. */}
              <span className="mic-level-ring" style={{ transform: `scale(${1 + dictation.level * 0.7})` }} />
              <StopIcon />
            </>
            )
          : <MicrophoneIcon />}
      </button>

      <button
        ref={chevron}
        type="button"
        className="mic-chevron"
        onClick={() => { onOpenChange(!open) }}
        aria-label="Choose microphone"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <ChevronIcon />
      </button>

      {open
        ? (
          <div className="mic-popover" ref={popover} role="menu" aria-label="Microphone">
            <div className="mic-meter">
              <MicrophoneIcon />
              <span className="mic-meter-track">
                <span className="mic-meter-fill" style={{ width: `${Math.round(dictation.level * 100)}%` }} />
              </span>
            </div>

            {dictation.permissionGiven
              ? (
                <ul className="mic-list">
                  {dictation.microphones.map(microphone => {
                    const chosen = microphone.deviceId === dictation.deviceId ||
                      (dictation.deviceId === null && microphone.isDefault)
                    return (
                      <li key={microphone.deviceId}>
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={chosen}
                          className="mic-option"
                          onClick={() => {
                            dictation.chooseMicrophone(microphone.deviceId)
                            onOpenChange(false)
                          }}
                        >
                          <span className="mic-option-check">{chosen ? <CheckIcon /> : null}</span>
                          <span className="mic-option-name">{microphone.label}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
                )
              : (
                <div className="mic-ask">
                  <p>Microphone names appear once you have allowed this site to use the microphone.</p>
                  <button type="button" className="mic-ask-button" onClick={() => { void dictation.requestPermission() }}>
                    Allow the microphone
                  </button>
                </div>
                )}
          </div>
          )
        : null}
    </div>
  )
}
