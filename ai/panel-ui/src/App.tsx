import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentSubscriber, HttpAgent } from '@ag-ui/client'

import { HEALTH_PATH, parsePanelComponent, type HealthResponse, type PageContext } from '@shared'

import { Composer } from './components/Composer'
import { MessageFeed } from './components/MessageFeed'
import { createAgent } from './lib/agent'
import type { PanelParams } from './lib/params'
import { postStatus } from './lib/parent'
import { clearThread, loadThread, newThreadId, saveThread } from './lib/storage'
import { textMessage, type ChatMessage, type MessagePart } from './types'

const SAVE_DEBOUNCE_MS = 250
const UNREACHABLE = 'The assistant is unreachable. Check that the AI service is running, then ask again.'

export default function App ({ params }: { params: PanelParams }) {
  const [initial] = useState(loadThread)
  const [threadId, setThreadId] = useState(initial.threadId)
  const [messages, setMessages] = useState<ChatMessage[]>(
    () => (initial.messages.length > 0 ? initial.messages : [greeting(params.page)])
  )
  const [busy, setBusy] = useState(false)
  const [online, setOnline] = useState<boolean | null>(null)
  const [statusLabel, setStatusLabel] = useState<string | undefined>(undefined)
  const [speech, setSpeech] = useState<HealthResponse['speech'] | undefined>(undefined)
  const [announcement, setAnnouncement] = useState('')
  const [focusToken, setFocusToken] = useState(0)

  // One agent per thread. It carries the conversation that is sent with
  // every run, and starting a new chat replaces it.
  const agentRef = useRef<HttpAgent | null>(null)
  if (agentRef.current === null) {
    agentRef.current = createAgent(initial.threadId, messages)
  }

  // Bumped when the thread is thrown away, so a run that was in flight
  // cannot write into the new conversation.
  const generationRef = useRef(0)

  // Keep the conversation for the rest of the browser tab's session.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveThread({ threadId, messages })
    }, SAVE_DEBOUNCE_MS)
    return () => { window.clearTimeout(timer) }
  }, [messages, threadId])

  // Say hello to the service, so the panel's header chip is right before the
  // first question rather than after it.
  useEffect(() => {
    let cancelled = false
    void fetch(HEALTH_PATH, { headers: { accept: 'application/json' } })
      .then(async response => {
        if (!response.ok) { throw new Error(`health check returned ${response.status}`) }
        return response.json() as Promise<Partial<HealthResponse>>
      })
      .then(body => {
        if (cancelled) { return }
        setStatusLabel(body.provider?.label)
        // No speech service, no microphone button.
        setSpeech(body.speech)
        setOnline(body.ok === true)
      })
      .catch(() => { if (!cancelled) { setOnline(false) } })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (online !== null) { postStatus(online, statusLabel) }
  }, [online, statusLabel])

  const startNewChat = useCallback(() => {
    generationRef.current += 1
    agentRef.current?.abortRun()

    const nextId = newThreadId()
    const fresh = [greeting(params.page)]
    clearThread()
    setThreadId(nextId)
    setMessages(fresh)
    agentRef.current = createAgent(nextId, fresh)
    setBusy(false)
    setAnnouncement('New chat started.')
    setFocusToken(token => token + 1)
  }, [params.page])

  // The wiki page around the panel asks for a new chat from its header
  // button. Only that window, on this origin, is listened to.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== window.location.origin) { return }
      const data: unknown = event.data
      if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'wiki-ai:new-chat') {
        startNewChat()
      }
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [startNewChat])

  const send = useCallback(async (text: string) => {
    const agent = agentRef.current
    if (!agent || busy) { return }

    const generation = generationRef.current
    const stale = () => generationRef.current !== generation

    const question: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      parts: textMessage(text),
      at: Date.now()
    }
    const replyId = crypto.randomUUID()
    const reply: ChatMessage = {
      id: replyId,
      role: 'assistant',
      parts: [],
      at: Date.now(),
      status: 'streaming'
    }
    setMessages(current => [...current, question, reply])
    setBusy(true)

    const updateReply = (change: (message: ChatMessage) => ChatMessage) => {
      if (stale()) { return }
      setMessages(current => current.map(message => (message.id === replyId ? change(message) : message)))
    }
    const appendPart = (part: MessagePart) => {
      updateReply(message => ({ ...message, parts: [...message.parts, part] }))
    }
    // The open text part is rewritten in place as its buffer grows.
    const setOpenText = (value: string) => {
      updateReply(message => {
        const parts = [...message.parts]
        const last = parts[parts.length - 1]
        if (last?.type === 'text') {
          parts[parts.length - 1] = { type: 'text', text: value }
        } else {
          parts.push({ type: 'text', text: value })
        }
        return { ...message, parts }
      })
    }

    let failed = false
    // A run holds several text messages, one per round of tool calls, with
    // cards between them. Each becomes its own part, in arrival order.
    let committed = ''
    let open = ''
    const spoken = () => [committed, open].filter(Boolean).join('\n\n')

    const subscriber: AgentSubscriber = {
      onTextMessageStartEvent: () => {
        open = ''
        appendPart({ type: 'text', text: '' })
      },
      onTextMessageContentEvent: ({ textMessageBuffer }) => {
        open = textMessageBuffer
        setOpenText(textMessageBuffer)
      },
      onTextMessageEndEvent: ({ textMessageBuffer }) => {
        committed = [committed, textMessageBuffer].filter(Boolean).join('\n\n')
        open = ''
      },
      onToolCallEndEvent: ({ toolCallName, toolCallArgs }) => {
        const result = parsePanelComponent(toolCallName, toolCallArgs)
        if (!result.ok) {
          console.warn('[assistant] ignored a tool call:', result.error)
          return
        }
        appendPart({ type: 'component', component: result.component })
      },
      onRunErrorEvent: ({ event }) => {
        failed = true
        committed = event.message
        updateReply(message => ({
          ...message,
          status: 'error',
          parts: message.parts.some(part => part.type === 'text' && part.text.length > 0)
            ? message.parts
            : textMessage(event.message)
        }))
      }
    }

    agent.addMessage({ id: question.id, role: 'user', content: text })

    try {
      await agent.runAgent({ forwardedProps: { page: params.page } }, subscriber)
      if (stale()) { return }
      if (!failed) {
        setOnline(true)
        updateReply(message => ({ ...message, status: undefined }))
      }
    } catch (error) {
      // A new chat aborts the run on purpose; that is not a failure.
      if (stale()) { return }
      if (!failed) {
        console.warn('[assistant] the run failed:', error)
        failed = true
        committed = UNREACHABLE
        setOnline(false)
        updateReply(message => ({
          ...message,
          status: 'error',
          parts: message.parts.some(part => part.type === 'text' && part.text.length > 0)
            ? message.parts
            : textMessage(UNREACHABLE)
        }))
      }
    } finally {
      if (!stale()) {
        setBusy(false)
        setAnnouncement(`${failed ? 'Assistant error' : 'Assistant'}: ${spoken()}`)
      }
    }
  }, [busy, params.page])

  return (
    <div className="panel">
      <MessageFeed messages={messages} locale={params.page.locale} />
      <Composer
        busy={busy}
        focusToken={focusToken}
        onSend={text => { void send(text) }}
        {...(speech ? { speech } : {})}
      />
      {/* Finished replies are announced; the tokens on the way are not. */}
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </div>
  )
}

function greeting (page: PageContext): ChatMessage {
  const here = page.title.trim().length > 0 ? ` You are reading **${page.title}**.` : ''
  return {
    id: `greeting-${Date.now()}`,
    role: 'assistant',
    parts: textMessage([
      `Ask me about this wiki.${here}`,
      '',
      'I answer from the pages in it, and show you the pages I used.'
    ].join('\n')),
    at: Date.now()
  }
}
