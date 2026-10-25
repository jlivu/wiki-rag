import type { PanelComponent } from '@shared'

/** One bubble in the feed. */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  /** Markdown for assistant messages, plain text for the reader's. */
  text: string
  /** Cards the agent asked for, in the order they arrived. */
  components: PanelComponent[]
  /** Milliseconds since the epoch. */
  at: number
  /** Set while a reply is streaming, or if the run failed. */
  status?: 'streaming' | 'error'
}

export interface StoredThread {
  threadId: string
  messages: ChatMessage[]
}
