/** Shown while a reply is still arriving. */
export function TypingDots () {
  return (
    <span className="typing" aria-label="The assistant is replying">
      <span className="typing-dot" />
      <span className="typing-dot" />
      <span className="typing-dot" />
    </span>
  )
}
