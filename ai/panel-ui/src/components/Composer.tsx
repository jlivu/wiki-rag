import { useEffect, useRef, useState } from 'react'

const MAX_HEIGHT = 140

export function Composer ({ busy, onSend }: {
  busy: boolean
  onSend: (text: string) => void
}) {
  const [value, setValue] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)

  // Grow with the text, up to a few lines.
  useEffect(() => {
    const element = box.current
    if (!element) { return }
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`
  }, [value])

  useEffect(() => {
    box.current?.focus()
  }, [])

  const submit = () => {
    const text = value.trim()
    if (text.length === 0 || busy) { return }
    setValue('')
    onSend(text)
  }

  return (
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
        placeholder="Ask about this wiki…"
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
      <button className="composer-send" type="submit" disabled={busy || value.trim().length === 0}>
        Send
      </button>
    </form>
  )
}
