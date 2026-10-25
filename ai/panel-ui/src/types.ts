import type { PanelComponent } from '@shared'

/**
 * A reply is a sequence of parts, not text plus a pile of cards: the model
 * can write, draw a card, then write again, and the panel has to show that
 * in the order it arrived.
 */
export type MessagePart =
  | { type: 'text', text: string }
  | { type: 'component', component: PanelComponent }

/** One bubble in the feed. */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  parts: MessagePart[]
  /** Milliseconds since the epoch. */
  at: number
  /** Set while a reply is streaming, or if the run failed. */
  status?: 'streaming' | 'error'
}

export interface StoredThread {
  threadId: string
  messages: ChatMessage[]
}

export function textMessage (text: string): MessagePart[] {
  return [{ type: 'text', text }]
}

/** Everything the message says, for the agent's history and for a reader. */
export function messageText (message: ChatMessage): string {
  return message.parts
    .filter((part): part is { type: 'text', text: string } => part.type === 'text')
    .map(part => part.text)
    .join('\n\n')
    .trim()
}
