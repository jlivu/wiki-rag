import type { ChatMessage } from '../types'
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
            ? <p className="plain">{message.text}</p>
            : message.text.length > 0 ? <Markdown text={message.text} /> : null}
          {message.status === 'streaming' ? <TypingDots /> : null}
          {message.components.map((component, index) => (
            <AnswerComponent key={`${component.name}-${index}`} component={component} locale={locale} />
          ))}
        </div>
        <div className="msg-time">{formatTime(message.at)}</div>
      </div>
    </article>
  )
}

function formatTime (at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
