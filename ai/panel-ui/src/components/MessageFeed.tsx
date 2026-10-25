import { useEffect, useRef } from 'react'

import type { ChatMessage } from '../types'
import { MessageBubble } from './MessageBubble'

export function MessageFeed ({ messages, locale }: {
  messages: ChatMessage[]
  locale: string
}) {
  const feed = useRef<HTMLDivElement>(null)
  // Follow the newest message, unless the reader has scrolled up to read.
  const stickToBottom = useRef(true)

  useEffect(() => {
    const element = feed.current
    if (element && stickToBottom.current) {
      element.scrollTop = element.scrollHeight
    }
  })

  return (
    <div
      className="chat-feed"
      ref={feed}
      onScroll={() => {
        const element = feed.current
        if (element) {
          stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40
        }
      }}
    >
      {messages.map(message => (
        <MessageBubble key={message.id} message={message} locale={locale} />
      ))}
    </div>
  )
}
