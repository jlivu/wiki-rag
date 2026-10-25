import type { Source } from '@shared'

import { cardKey } from '../lib/created-pages'
import type { ChatMessage } from '../types'
import { messageText } from '../types'
import { AnswerComponent } from './cards'
import { Markdown } from './Markdown'
import { TypingDots } from './TypingDots'

export function MessageBubble ({ message, locale, signedIn }: {
  message: ChatMessage
  locale: string
  /** Passed to the draft card, which can only create a page for a reader. */
  signedIn: boolean
}) {
  const isUser = message.role === 'user'
  const bubbleClass = ['bub', message.status === 'error' ? 'bub-error' : null]
    .filter(Boolean)
    .join(' ')
  // Inline markers resolve against this reply's own sources card, so a
  // citation can only ever point at a page this run really returned.
  const sources = citedSources(message)

  return (
    <article className={isUser ? 'msg msg-usr' : 'msg msg-bot'}>
      <div className="msg-inner">
        <div className={bubbleClass}>
          {isUser
            ? <p className="plain">{messageText(message)}</p>
            // Parts in the order the model produced them.
            : message.parts.map((part, index) => (
                part.type === 'text'
                  ? (part.text.length > 0
                      ? <Markdown key={index} text={part.text} sources={sources} locale={locale} />
                      : null)
                  : (
                    <AnswerComponent
                      key={index}
                      component={part.component}
                      locale={locale}
                      signedIn={signedIn}
                      cardKey={cardKey(message.id, index)}
                    />
                    )
              ))}
          {message.status === 'streaming' ? <TypingDots /> : null}
        </div>
        <div className="msg-time">{formatTime(message.at)}</div>
      </div>
    </article>
  )
}

/** The reply's sources card, which the server builds from what it cited. */
function citedSources (message: ChatMessage): Source[] {
  return message.parts.flatMap(part => (
    part.type === 'component' && part.component.name === 'sources'
      ? part.component.args.items
      : []
  ))
}

function formatTime (at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
