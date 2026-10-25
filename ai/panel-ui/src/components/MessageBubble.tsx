import type { ChatMessage } from '../types'
import { messageText } from '../types'
import { AnswerComponent } from './cards'
import { Markdown } from './Markdown'
import { TypingDots } from './TypingDots'

export function MessageBubble ({ message, locale }: {
  message: ChatMessage
  locale: string
}) {
  const isUser = message.role === 'user'
  const bubbleClass = ['bub', message.status === 'error' ? 'bub-error' : null]
    .filter(Boolean)
    .join(' ')

  return (
    <article className={isUser ? 'msg msg-usr' : 'msg msg-bot'}>
      <div className="msg-inner">
        <div className={bubbleClass}>
          {isUser
            ? <p className="plain">{messageText(message)}</p>
            // Parts in the order the model produced them.
            : message.parts.map((part, index) => (
                part.type === 'text'
                  ? (part.text.length > 0 ? <Markdown key={index} text={part.text} /> : null)
                  : <AnswerComponent key={index} component={part.component} locale={locale} />
              ))}
          {message.status === 'streaming' ? <TypingDots /> : null}
        </div>
        <div className="msg-time">{formatTime(message.at)}</div>
      </div>
    </article>
  )
}

function formatTime (at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
