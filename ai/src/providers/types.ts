/**
 * One interface for streaming chat with tool calls, so the agent never knows
 * which model is answering. Two implementations: Anthropic (cloud) and
 * Ollama (local).
 */
import type { ProviderId } from '../config.js'

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
  | { type: 'usage', inputTokens: number, outputTokens: number }
  /** Why the model stopped. 'length' means the reply was cut short. */
  | { type: 'stop', reason: 'end' | 'tool_use' | 'length' | 'other' }

export interface ChatRequest {
  system: string
  messages: ChatMessage[]
  tools: ToolSpec[]
  maxOutputTokens: number
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

/** "claude-sonnet-5-5" -> "Claude Sonnet 5.5"; unknown shapes pass through. */
export function formatAnthropicModel (model: string): string {
  const parts = model.split('-')
  if (parts[0] !== 'claude' || parts.length < 2) { return model }
  const rest = parts.slice(1).filter(part => !/^\d{8}$/.test(part))
  const name = rest[0]
  if (!name) { return model }
  const version = rest.slice(1).join('.')
  const title = name.charAt(0).toUpperCase() + name.slice(1)
  return version ? `Claude ${title} ${version}` : `Claude ${title}`
}
