import { HttpAgent } from '@ag-ui/client'
import type { Message } from '@ag-ui/core'

import { AGENT_PATH } from '@shared'

import type { ChatMessage } from '../types'
import { messageText } from '../types'

/**
 * One agent per thread. It holds the conversation that is sent with every
 * run, so the agent in step 3 can see what was already said.
 */
export function createAgent (threadId: string, history: ChatMessage[]): HttpAgent {
  return new HttpAgent({
    url: AGENT_PATH,
    threadId,
    initialMessages: toAgentMessages(history)
  })
}

/** Cards are drawn from tool calls and are not part of the history. */
export function toAgentMessages (messages: ChatMessage[]): Message[] {
  return messages
    .map(message => ({ message, text: messageText(message) }))
    .filter(({ message, text }) => message.status !== 'error' && text.length > 0)
    .map(({ message, text }): Message => (
      message.role === 'user'
        ? { id: message.id, role: 'user', content: text }
        : { id: message.id, role: 'assistant', content: text }
    ))
}
