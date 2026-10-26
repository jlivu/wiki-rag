import { useCallback, useEffect, useRef, useState } from 'react'

import { Dictation } from './Dictation'
import { useDictation } from '../lib/dictation'

const MAX_HEIGHT = 140

export function Composer ({ busy, focusToken, onSend, speech, picker }: {
  busy: boolean
  /** Changes when something outside wants the cursor back in the box. */
  focusToken: number
  onSend: (text: string) => void
  /** Dictation, when the service has a speech model to offer. */
  speech?: { enabled: boolean, maxSeconds: number }
  /** The model and effort picker, beside the note. None until it loads. */
  picker?: React.ReactNode
}) {
  const [value, setValue] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)

  /**
   * Dictated text lands where the cursor is and goes no further: it is a
   * draft the reader reads, corrects and sends themselves. Nothing here
   * ever submits the form.
   */
  const insert = useCallback((text: string) => {
    const element = box.current
    setValue(current => {
      const at = element?.selectionStart ?? current.length
      const to = element?.selectionEnd ?? at
      const before = current.slice(0, at)
      const after = current.slice(to)
      const spaced = before.length > 0 && !/\s$/.test(before) ? ` ${text}` : text
      const next = `${before}${spaced}${after}`
      // Put the cursor after what was just inserted, once React has drawn it.
      window.requestAnimationFrame(() => {
        const cursor = before.length + spaced.length
        element?.focus()
        element?.setSelectionRange(cursor, cursor)
      })
      return next
    })
  }, [])

  const dictation = useDictation({ maxSeconds: speech?.maxSeconds ?? 120, onText: insert })

  // Grow with the text, up to a few lines.
  useEffect(() => {
    const element = box.current
    if (!element) { return }
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`
  }, [value])

  useEffect(() => {
    box.current?.focus()
  }, [focusToken])

  const submit = () => {
    const text = value.trim()
    if (text.length === 0 || busy) { return }
    setValue('')
    onSend(text)
  }

  const recording = dictation.state === 'recording'
  const transcribing = dictation.state === 'transcribing'
  const announcement = recording
    ? 'Recording. Press the microphone button again to stop, or Escape to cancel.'
    : transcribing ? 'Transcribing your recording.' : ''

  return (
    <div className="composer-area">
      <form
        className="composer"
        onSubmit={event => {
          event.preventDefault()
          submit()
        }}
      >
        <textarea
          ref={box}
          className="composer-box"
          value={value}
          rows={1}
          placeholder={recording ? 'Listening…' : transcribing ? 'Transcribing…' : 'Ask about this wiki…'}
          aria-label="Message"
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => {
            // Enter sends, Shift+Enter starts a new line.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
        />

        {speech?.enabled
          ? (
            <Dictation
              dictation={dictation}
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              maxSeconds={speech.maxSeconds}
            />
            )
          : null}

        <button className="composer-send" type="submit" disabled={busy || value.trim().length === 0}>
          Send
        </button>
      </form>

      {recording || transcribing
        ? (
          <p className="composer-status">
            {recording
              ? <>Recording… {dictation.elapsed.toFixed(0)}s. Press the microphone again to stop, Escape to cancel.</>
              : <>Transcribing…</>}
          </p>
          )
        : null}

      {dictation.error
        ? (
          <p className="composer-error" role="alert">
            {dictation.error}
            <button type="button" className="composer-error-close" onClick={dictation.clearError} aria-label="Dismiss">
              ×
            </button>
          </p>
          )
        : null}

      <div className="composer-foot">
        <p className="composer-note">
          Answers are written by AI and can be wrong. Check them against the sources listed with each reply.
        </p>
        {picker}
      </div>

      {/* Said once, politely, so a screen reader is not read the level. */}
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </div>
  )
}
