import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentSubscriber, HttpAgent } from '@ag-ui/client'

import { HEALTH_PATH, parsePanelComponent, type PageContext } from '@shared'

import { Composer } from './components/Composer'
import { MessageFeed } from './components/MessageFeed'
import { createAgent } from './lib/agent'
import type { PanelParams } from './lib/params'
import { postStatus } from './lib/parent'
import { loadThread, saveThread } from './lib/storage'
import type { ChatMessage } from './types'

const SAVE_DEBOUNCE_MS = 250
const UNREACHABLE = 'The assistant is unreachable. Check that the AI service is running, then ask again.'

export default function App ({ params }: { params: PanelParams }) {
  const [thread] = useState(loadThread)
  const [messages, setMessages] = useState<ChatMessage[]>(
    () => (thread.messages.length > 0 ? thread.messages : [greeting(params.page)])
  )
  const [busy, setBusy] = useState(false)
  const [online, setOnline] = useState<boolean | null>(null)
  const [announcement, setAnnouncement] = useState('')

  // One agent for the life of the thread. It carries the conversation that
  // is sent with every run.
  const agentRef = useRef<HttpAgent | null>(null)
  if (agentRef.current === null) {
    agentRef.current = createAgent(thread.threadId, messages)
  }

  // Keep the conversation for the rest of the browser tab's session.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveThread({ threadId: thread.threadId, messages })
    }, SAVE_DEBOUNCE_MS)
    return () => { window.clearTimeout(timer) }
  }, [messages, thread.threadId])

  // Say hello to the service, so the panel's header chip is right before the
  // first question rather than after it.
  useEffect(() => {
    let cancelled = false
    void fetch(HEALTH_PATH, { headers: { accept: 'application/json' } })
      .then(async response => {
        if (!response.ok) { throw new Error(`health check returned ${response.status}`) }
        return response.json() as Promise<{ ok?: boolean }>
      })
      .then(body => { if (!cancelled) { setOnline(body.ok === true) } })
      .catch(() => { if (!cancelled) { setOnline(false) } })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (online !== null) { postStatus(online) }
  }, [online])

  const send = useCallback(async (text: string) => {
    const agent = agentRef.current
    if (!agent || busy) { return }

    const question: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text,
      components: [],
      at: Date.now()
    }
    const replyId = crypto.randomUUID()
    const reply: ChatMessage = {
      id: replyId,
      role: 'assistant',
      text: '',
      components: [],
      at: Date.now(),
      status: 'streaming'
    }
    setMessages(current => [...current, question, reply])
    setBusy(true)

    const updateReply = (change: (message: ChatMessage) => ChatMessage) => {
      setMessages(current => current.map(message => (message.id === replyId ? change(message) : message)))
    }

    let failed = false
    let spoken = ''

    const subscriber: AgentSubscriber = {
      onTextMessageContentEvent: ({ textMessageBuffer }) => {
        spoken = textMessageBuffer
        updateReply(message => ({ ...message, text: textMessageBuffer }))
      },
      onToolCallEndEvent: ({ toolCallName, toolCallArgs }) => {
        const result = parsePanelComponent(toolCallName, toolCallArgs)
        if (!result.ok) {
          console.warn('[assistant] ignored a tool call:', result.error)
          return
        }
        updateReply(message => ({ ...message, components: [...message.components, result.component] }))
      },
      onRunErrorEvent: ({ event }) => {
        failed = true
        spoken = event.message
        updateReply(message => ({ ...message, status: 'error', text: message.text || event.message }))
      }
    }

    agent.addMessage({ id: question.id, role: 'user', content: text })

    try {
      await agent.runAgent({ forwardedProps: { page: params.page } }, subscriber)
      if (!failed) {
        setOnline(true)
        updateReply(message => ({ ...message, status: undefined }))
      }
    } catch (error) {
      if (!failed) {
        // The run never reached the service, or the connection dropped.
        console.warn('[assistant] the run failed:', error)
        failed = true
        spoken = UNREACHABLE
        setOnline(false)
        updateReply(message => ({ ...message, status: 'error', text: message.text || UNREACHABLE }))
      }
    } finally {
      setBusy(false)
      setAnnouncement(`${failed ? 'Assistant error' : 'Assistant'}: ${spoken}`)
    }
  }, [busy, params.page])

  return (
    <div className="panel">
      <MessageFeed messages={messages} locale={params.page.locale} />
      <Composer busy={busy} onSend={text => { void send(text) }} />
      {/* Finished replies are announced; the tokens on the way are not. */}
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </div>
  )
}

function greeting (page: PageContext): ChatMessage {
  const here = page.title.trim().length > 0 ? ` You are reading **${page.title}**.` : ''
  return {
    id: 'greeting',
    role: 'assistant',
    text: [
      `Ask me about this wiki.${here}`,
      '',
      'There is no knowledge base behind me yet, so answers come from mock data. Try **restore**, **error 3201**, **compare**, **sources** or **draft**.'
    ].join('\n'),
    components: [],
    at: Date.now()
  }
}
