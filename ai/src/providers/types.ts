/**
 * One interface for streaming chat with tool calls, so the agent never knows
 * which model is answering. Two implementations: Anthropic (cloud) and
 * Ollama (local).
 */
import type { ProviderId } from '../config.js'
import type { EffortLevel } from '../../shared/index.js'

export { formatAnthropicModel } from './format.js'

/** A tool offered to the model. `inputSchema` is a JSON Schema object. */
export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ProviderToolCall {
  id: string
  name: string
  /** Already parsed from the model's JSON. */
  args: unknown
}

export type ChatMessage =
  | { role: 'user', content: string }
  | { role: 'assistant', content: string, toolCalls: ProviderToolCall[] }
  | { role: 'tool', toolCallId: string, toolName: string, content: string }

/**
 * Yielded in the order the model produced them, so text written after a tool
 * call stays after it.
 */
export type ProviderEvent =
  | { type: 'text', delta: string }
  | { type: 'tool_call', call: ProviderToolCall }
  | {
      type: 'usage'
      inputTokens: number
      outputTokens: number
      /** Prompt caching, when the provider reports it. */
      cacheWriteTokens?: number
      cacheReadTokens?: number
    }
  /** Why the model stopped. 'length' means the reply was cut short. */
  | { type: 'stop', reason: 'end' | 'tool_use' | 'length' | 'other' }

export interface ChatRequest {
  system: string
  messages: ChatMessage[]
  tools: ToolSpec[]
  maxOutputTokens: number
  /**
   * How hard to work on this answer. Per request, not per provider: the
   * reader picks it under the message box and can change it between one
   * question and the next.
   */
  effort: EffortLevel
  signal: AbortSignal
}

export interface ChatProvider {
  readonly id: ProviderId
  readonly model: string
  /** Shown in the panel's header chip, e.g. "Claude Sonnet 5.5 · Cloud". */
  readonly label: string
  stream: (request: ChatRequest) => AsyncIterable<ProviderEvent>
}

/** A failure the reader should see, with the detail kept in the server log. */
export class ProviderError extends Error {
  readonly code: string
  constructor (code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ProviderError'
    this.code = code
  }
}
