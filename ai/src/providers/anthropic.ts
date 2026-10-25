import Anthropic from '@anthropic-ai/sdk'

import type { LlmConfig } from '../config.js'
import {
  ProviderError,
  formatAnthropicModel,
  type ChatMessage,
  type ChatProvider,
  type ChatRequest,
  type ProviderEvent
} from './types.js'

/**
 * The Anthropic API, through the official SDK.
 *
 * Current Claude models think adaptively by default and reject the sampling
 * parameters, so neither is sent. Depth is set with `effort` instead, and
 * `max_tokens` has to leave room for the thinking as well as the answer.
 */
export function createAnthropicProvider (llm: LlmConfig): ChatProvider {
  if (llm.apiKey.length === 0) {
    throw new ProviderError('NO_API_KEY', 'ANTHROPIC_API_KEY is not set.')
  }

  const client = new Anthropic({
    apiKey: llm.apiKey,
    timeout: llm.timeoutMs,
    maxRetries: 2
  })

  return {
    id: 'anthropic',
    model: llm.model,
    label: `${formatAnthropicModel(llm.model)} · Cloud`,
    async * stream (request: ChatRequest): AsyncIterable<ProviderEvent> {
      const stream = client.messages.stream({
        model: llm.model,
        max_tokens: request.maxOutputTokens,
        system: request.system,
        messages: toAnthropicMessages(request.messages),
        tools: request.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Tool['input_schema']
        })),
        output_config: { effort: llm.effort }
      }, { signal: request.signal })

      try {
        // Blocks are read as they close rather than from the finished
        // message, so a tool call is yielded where the model put it and any
        // text after it stays after it.
        let pending: { index: number, id: string, name: string, json: string } | null = null

        for await (const event of stream) {
          switch (event.type) {
            case 'content_block_start':
              if (event.content_block.type === 'tool_use') {
                pending = { index: event.index, id: event.content_block.id, name: event.content_block.name, json: '' }
              }
              break
            case 'content_block_delta':
              if (event.delta.type === 'text_delta') {
                yield { type: 'text', delta: event.delta.text }
              } else if (event.delta.type === 'input_json_delta' && pending?.index === event.index) {
                pending.json += event.delta.partial_json
              }
              break
            case 'content_block_stop':
              if (pending?.index === event.index) {
                yield { type: 'tool_call', call: { id: pending.id, name: pending.name, args: parseArgs(pending.json) } }
                pending = null
              }
              break
          }
        }

        const message = await stream.finalMessage()

        if (message.stop_reason === 'refusal') {
          throw new ProviderError('REFUSAL', 'The model declined to answer that question.')
        }

        yield {
          type: 'usage',
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens
        }
        yield { type: 'stop', reason: toStopReason(message.stop_reason) }
      } catch (err) {
        throw toProviderError(err)
      }
    }
  }
}

/**
 * Tool results belong in one user message per assistant turn, so consecutive
 * tool messages are grouped.
 */
function toAnthropicMessages (messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  let pendingResults: Anthropic.ToolResultBlockParam[] = []

  const flushResults = () => {
    if (pendingResults.length > 0) {
      out.push({ role: 'user', content: pendingResults })
      pendingResults = []
    }
  }

  for (const message of messages) {
    if (message.role === 'tool') {
      pendingResults.push({
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content
      })
      continue
    }

    flushResults()

    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content })
      continue
    }

    const blocks: Anthropic.ContentBlockParam[] = []
    if (message.content.trim().length > 0) {
      blocks.push({ type: 'text', text: message.content })
    }
    for (const call of message.toolCalls) {
      blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args })
    }
    if (blocks.length > 0) {
      out.push({ role: 'assistant', content: blocks })
    }
  }

  flushResults()
  return out
}

function toStopReason (reason: string | null): 'end' | 'tool_use' | 'length' | 'other' {
  switch (reason) {
    case 'end_turn': return 'end'
    case 'tool_use': return 'tool_use'
    case 'max_tokens': return 'length'
    default: return 'other'
  }
}

/** A reply cut off at max_tokens can leave the arguments half-written. */
function parseArgs (json: string): unknown {
  if (json.trim().length === 0) { return {} }
  try {
    return JSON.parse(json)
  } catch {
    return { __invalidJson: json.slice(0, 500) }
  }
}

function toProviderError (err: unknown): ProviderError {
  if (err instanceof ProviderError) { return err }
  if (err instanceof Anthropic.AuthenticationError) {
    return new ProviderError('AUTH', 'The assistant\'s API key was not accepted.', { cause: err })
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ProviderError('RATE_LIMIT', 'The assistant is rate limited. Try again in a moment.', { cause: err })
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError('TIMEOUT', 'The model took too long to answer.', { cause: err })
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError('UNREACHABLE', 'The assistant could not reach the model.', { cause: err })
  }
  if (err instanceof Anthropic.APIError) {
    return new ProviderError('API_ERROR', 'The model returned an error.', { cause: err })
  }
  return new ProviderError('UNKNOWN', 'The assistant could not finish this answer.', { cause: err })
}
