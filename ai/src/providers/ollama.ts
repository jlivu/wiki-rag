import OpenAI from 'openai'

import type { LlmConfig } from '../config.js'
import {
  ProviderError,
  type ChatMessage,
  type ChatProvider,
  type ChatRequest,
  type ProviderEvent,
  type ProviderToolCall
} from './types.js'

/**
 * A model running locally under Ollama, through its OpenAI-compatible API.
 * Ollama runs natively on the Mac, so from a container it is reached at
 * host.docker.internal.
 */
export function createOllamaProvider (llm: LlmConfig): ChatProvider {
  const client = new OpenAI({
    baseURL: `${llm.ollamaUrl}/v1`,
    // Ollama ignores the key but the client insists on one.
    apiKey: 'ollama',
    timeout: llm.timeoutMs,
    maxRetries: 1
  })

  return {
    id: 'ollama',
    model: llm.model,
    label: `${llm.model} · Local`,
    async * stream (request: ChatRequest): AsyncIterable<ProviderEvent> {
      let stream
      try {
        stream = await client.chat.completions.create({
          model: llm.model,
          max_tokens: request.maxOutputTokens,
          messages: toOpenAiMessages(request.system, request.messages),
          tools: request.tools.map(tool => ({
            type: 'function' as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema
            }
          })),
          stream: true,
          stream_options: { include_usage: true }
        }, { signal: request.signal })
      } catch (err) {
        throw toProviderError(err)
      }

      // Tool calls arrive as deltas keyed by position in the array.
      const partials = new Map<number, { id: string, name: string, args: string }>()
      let usage: ProviderEvent | undefined
      let finish: string | null = null

      try {
        for await (const chunk of stream) {
          if (chunk.usage) {
            usage = {
              type: 'usage',
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0
            }
          }

          finish = chunk.choices[0]?.finish_reason ?? finish
          const delta = chunk.choices[0]?.delta
          if (!delta) { continue }

          if (typeof delta.content === 'string' && delta.content.length > 0) {
            yield { type: 'text', delta: delta.content }
          }

          for (const call of delta.tool_calls ?? []) {
            const partial = partials.get(call.index) ?? { id: '', name: '', args: '' }
            if (call.id) { partial.id = call.id }
            if (call.function?.name) { partial.name = call.function.name }
            if (call.function?.arguments) { partial.args += call.function.arguments }
            partials.set(call.index, partial)
          }
        }
      } catch (err) {
        throw toProviderError(err)
      }

      for (const [index, partial] of [...partials.entries()].sort((a, b) => a[0] - b[0])) {
        const call: ProviderToolCall = {
          id: partial.id || `call_${index}`,
          name: partial.name,
          args: parseArgs(partial.args)
        }
        if (call.name.length > 0) {
          yield { type: 'tool_call', call }
        }
      }

      yield usage ?? { type: 'usage', inputTokens: 0, outputTokens: 0 }
      // OpenAI-compatible streams put every tool call after the text, so
      // this provider cannot interleave the two the way Anthropic's can.
      yield { type: 'stop', reason: finish === 'length' ? 'length' : finish === 'tool_calls' ? 'tool_use' : 'end' }
    }
  }
}

function toOpenAiMessages (
  system: string,
  messages: ChatMessage[]
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: system }
  ]

  for (const message of messages) {
    switch (message.role) {
      case 'user':
        out.push({ role: 'user', content: message.content })
        break
      case 'assistant':
        out.push({
          role: 'assistant',
          content: message.content,
          ...(message.toolCalls.length > 0
            ? {
                tool_calls: message.toolCalls.map(call => ({
                  id: call.id,
                  type: 'function' as const,
                  function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) }
                }))
              }
            : {})
        })
        break
      case 'tool':
        out.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content })
        break
    }
  }

  return out
}

/** A small model can produce invalid JSON; the agent reports that back to it. */
function parseArgs (raw: string): unknown {
  if (raw.trim().length === 0) { return {} }
  try {
    return JSON.parse(raw)
  } catch {
    return { __invalidJson: raw.slice(0, 500) }
  }
}

function toProviderError (err: unknown): ProviderError {
  if (err instanceof ProviderError) { return err }
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new ProviderError('TIMEOUT', 'The local model took too long to answer.', { cause: err })
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new ProviderError('UNREACHABLE', 'The assistant could not reach Ollama. Is it running?', { cause: err })
  }
  if (err instanceof OpenAI.NotFoundError) {
    return new ProviderError('NO_MODEL', 'Ollama does not have that model. Pull it first.', { cause: err })
  }
  if (err instanceof OpenAI.APIError) {
    return new ProviderError('API_ERROR', 'The local model returned an error.', { cause: err })
  }
  return new ProviderError('UNKNOWN', 'The assistant could not finish this answer.', { cause: err })
}
