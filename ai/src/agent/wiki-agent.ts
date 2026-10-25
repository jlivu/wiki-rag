/**
 * The agent that answers from the wiki.
 *
 * One run is a short loop: ask the model, run whatever tools it asked for,
 * ask again with the results, until it answers or the tool budget runs out.
 * Text and component cards are streamed to the panel as AG-UI events as they
 * arrive; the wiki tools run quietly on the server.
 */
import { randomUUID } from 'node:crypto'

import {
  EventType,
  PROTOCOL_VERSION,
  contentToText,
  type BaseEvent,
  type Message,
  type RunAgentInput
} from '@ag-ui/core'

import {
  PANEL_TOOL_NAMES,
  PANEL_TOOL_SCHEMAS,
  isPanelToolName,
  parsePanelComponent,
  type PageContext
} from '../../shared/index.js'
import type { ChatMessage, ChatProvider, ProviderToolCall, ToolSpec } from '../providers/types.js'
import { isWikiTool, runWikiTool, wikiToolSpecs, type ToolContext } from '../wiki/tools.js'

import { buildSystemPrompt } from './system-prompt.js'

export interface AgentLogger {
  info: (payload: Record<string, unknown>, message: string) => void
  warn: (payload: Record<string, unknown>, message: string) => void
}

export interface WikiAgentOptions {
  input: RunAgentInput
  page?: PageContext
  provider: ChatProvider
  tools: ToolContext
  emit: (event: BaseEvent) => void
  isAborted: () => boolean
  signal: AbortSignal
  maxToolSteps: number
  maxOutputTokens: number
}

export interface RunStats {
  steps: number
  toolCalls: Array<Record<string, unknown>>
  inputTokens: number
  outputTokens: number
  /** Prompt caching: written on a miss, read on a hit. */
  cacheWriteTokens: number
  cacheReadTokens: number
  /** Why the model stopped last; 'length' means the reply was cut short. */
  stopReason: string
}

export async function runWikiAgent (opts: WikiAgentOptions): Promise<RunStats> {
  const { input, provider, tools: toolContext, emit, isAborted } = opts
  const locale = opts.page?.locale ?? 'en'
  const stats: RunStats = {
    steps: 0, toolCalls: [], inputTokens: 0, outputTokens: 0,
    cacheWriteTokens: 0, cacheReadTokens: 0, stopReason: 'end'
  }

  emit({
    type: EventType.RUN_STARTED,
    threadId: input.threadId,
    runId: input.runId,
    protocolVersion: PROTOCOL_VERSION
  })

  const system = buildSystemPrompt(opts.page, !toolContext.client.isAuthenticated)
  const messages = toChatMessages(input.messages)
  const panelTools = panelToolSpecs()
  const allTools = [...wikiToolSpecs(locale), ...panelTools]

  const pendingToolCallIds: string[] = []
  let openTextId: string | null = null
  let lastTextId: string | null = null

  const openText = (): string => {
    if (openTextId === null) {
      openTextId = randomUUID()
      emit({ type: EventType.TEXT_MESSAGE_START, messageId: openTextId, role: 'assistant' })
    }
    return openTextId
  }
  const closeText = () => {
    if (openTextId !== null) {
      emit({ type: EventType.TEXT_MESSAGE_END, messageId: openTextId })
      lastTextId = openTextId
      openTextId = null
    }
  }

  for (let step = 0; step <= opts.maxToolSteps; step++) {
    if (isAborted()) { return stats }

    stats.steps = step + 1
    // The last pass offers no wiki tools, so the model has to answer with
    // what it has rather than searching for ever.
    const tools = step < opts.maxToolSteps ? allTools : panelTools

    let text = ''
    const calls: ProviderToolCall[] = []
    // Panel cards are validated and sent as they arrive, so a card lands
    // between the text before it and the text after it; wiki tools produce
    // nothing for the reader and run once the model's turn is over.
    const cardResults = new Map<string, string>()
    let stopReason: string = 'end'

    for await (const event of provider.stream({
      system,
      messages,
      tools,
      maxOutputTokens: opts.maxOutputTokens,
      signal: opts.signal
    })) {
      if (isAborted()) { return stats }
      switch (event.type) {
        case 'text':
          if (event.delta.length > 0) {
            const messageId = openText()
            text += event.delta
            emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: event.delta })
          }
          break
        case 'tool_call': {
          calls.push(event.call)
          if (!isPanelToolName(event.call.name)) { break }
          const parsed = parsePanelComponent(event.call.name, event.call.args)
          if (parsed.ok) {
            // A tool call may not interrupt an open text message.
            closeText()
            emitComponent(emit, event.call, lastTextId)
            pendingToolCallIds.push(event.call.id)
            cardResults.set(event.call.id, JSON.stringify({ status: 'rendered' }))
            stats.toolCalls.push({ name: event.call.name, ok: true })
          } else {
            cardResults.set(event.call.id, JSON.stringify({ error: parsed.error }))
            stats.toolCalls.push({ name: event.call.name, ok: false, error: parsed.error })
          }
          break
        }
        case 'usage':
          stats.inputTokens += event.inputTokens
          stats.outputTokens += event.outputTokens
          stats.cacheWriteTokens += event.cacheWriteTokens ?? 0
          stats.cacheReadTokens += event.cacheReadTokens ?? 0
          break
        case 'stop':
          stopReason = event.reason
          break
      }
    }

    stats.stopReason = stopReason

    if (stopReason === 'length') {
      // The reply ran into MAX_OUTPUT_TOKENS, so it stops mid-sentence.
      // Say so rather than leaving the reader with half an answer.
      const messageId = openText()
      emit({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: '\n\n*(This answer was cut short — it reached the reply length limit. Ask for a smaller part of it, or raise MAX_OUTPUT_TOKENS.)*'
      })
      closeText()
      break
    }

    closeText()

    if (calls.length === 0) { break }

    messages.push({ role: 'assistant', content: text, toolCalls: calls })

    for (const call of calls) {
      if (isAborted()) { return stats }

      const card = cardResults.get(call.id)
      if (card !== undefined) {
        messages.push(toolResult(call, card))
        continue
      }

      const startedAt = Date.now()
      if (isWikiTool(call.name)) {
        const outcome = await runWikiTool(toolContext, call.name, call.args)
        messages.push(toolResult(call, outcome.result))
        stats.toolCalls.push({ name: call.name, ms: Date.now() - startedAt, ...outcome.summary })
        continue
      }

      const error = `There is no tool called "${call.name}".`
      messages.push(toolResult(call, JSON.stringify({ error })))
      stats.toolCalls.push({ name: call.name, ms: Date.now() - startedAt, ok: false, error })
    }
  }

  emit({
    type: EventType.RUN_FINISHED,
    threadId: input.threadId,
    runId: input.runId,
    outcome: { type: 'success', pendingToolCallIds }
  })

  return stats
}

function emitComponent (
  emit: (event: BaseEvent) => void,
  call: ProviderToolCall,
  parentMessageId: string | null
): void {
  emit({
    type: EventType.TOOL_CALL_START,
    toolCallId: call.id,
    toolCallName: call.name,
    ...(parentMessageId ? { parentMessageId } : {})
  })
  emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: call.id, delta: JSON.stringify(call.args ?? {}) })
  emit({ type: EventType.TOOL_CALL_END, toolCallId: call.id })
}

function toolResult (call: ProviderToolCall, content: string): ChatMessage {
  return { role: 'tool', toolCallId: call.id, toolName: call.name, content }
}

function panelToolSpecs (): ToolSpec[] {
  return PANEL_TOOL_NAMES.map(name => {
    const schema = PANEL_TOOL_SCHEMAS[name]
    return {
      name,
      description: String(schema.description ?? `Render the ${name} card.`),
      inputSchema: schema
    }
  })
}

/**
 * The conversation so far, as the panel sent it. Leading assistant turns are
 * dropped: the panel opens with a greeting, and a conversation has to start
 * with the reader.
 */
function toChatMessages (messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const content = contentToText(message.content).trim()
      if (content.length > 0) { out.push({ role: 'user', content }) }
      continue
    }
    if (message.role === 'assistant' && out.length > 0) {
      const content = (message.content ?? '').trim()
      if (content.length > 0) { out.push({ role: 'assistant', content, toolCalls: [] }) }
    }
  }
  return out
}
