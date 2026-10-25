import { parsePanelComponent } from '@shared'

import type { ChatMessage, MessagePart, StoredThread } from '../types'

/**
 * The conversation lives for as long as the browser tab does. sessionStorage
 * is shared between the wiki page and this iframe (same origin, same tab),
 * so the chat survives moving from one wiki page to the next; the panel's own
 * open/closed flag uses a different key.
 */
const STORAGE_KEY = 'wiki-ai-chat'

export function newThreadId (): string {
  return crypto.randomUUID()
}

export function loadThread (): StoredThread {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = readThread(JSON.parse(raw))
      if (parsed) { return parsed }
    }
  } catch {
    // Unreadable or unavailable storage just means starting fresh.
  }
  return { threadId: newThreadId(), messages: [] }
}

export function saveThread (thread: StoredThread): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(thread))
  } catch {
    // Private mode and quota errors are not worth interrupting the chat for.
  }
}

export function clearThread (): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // As above.
  }
}

function readThread (value: unknown): StoredThread | null {
  if (!isRecord(value)) { return null }
  const threadId = typeof value.threadId === 'string' ? value.threadId : null
  if (!threadId || !Array.isArray(value.messages)) { return null }

  const messages: ChatMessage[] = []
  for (const raw of value.messages) {
    const message = readMessage(raw)
    if (message) { messages.push(message) }
  }
  return { threadId, messages }
}

function readMessage (value: unknown): ChatMessage | null {
  if (!isRecord(value)) { return null }
  const { id, role, at } = value
  if (typeof id !== 'string') { return null }
  if (role !== 'user' && role !== 'assistant') { return null }
  if (typeof at !== 'number') { return null }

  const parts = Array.isArray(value.parts)
    ? readParts(value.parts)
    // A thread stored before replies became ordered parts.
    : readLegacyParts(value)
  if (parts.length === 0) { return null }

  // A reply that was still streaming when the page was left is kept as it
  // was, not as unfinished business.
  const status = value.status === 'error' ? 'error' : undefined
  return { id, role, parts, at, ...(status ? { status } : {}) }
}

/**
 * Cards are re-checked against the shared schemas on the way in, so one
 * whose shape has since changed is dropped instead of breaking the panel.
 */
function readParts (value: unknown[]): MessagePart[] {
  const parts: MessagePart[] = []
  for (const entry of value) {
    if (!isRecord(entry)) { continue }
    if (entry.type === 'text' && typeof entry.text === 'string') {
      parts.push({ type: 'text', text: entry.text })
      continue
    }
    if (entry.type === 'component' && isRecord(entry.component) && typeof entry.component.name === 'string') {
      const result = parsePanelComponent(entry.component.name, entry.component.args)
      if (result.ok) { parts.push({ type: 'component', component: result.component }) }
    }
  }
  return parts
}

function readLegacyParts (value: Record<string, unknown>): MessagePart[] {
  const parts: MessagePart[] = []
  if (typeof value.text === 'string' && value.text.length > 0) {
    parts.push({ type: 'text', text: value.text })
  }
  if (Array.isArray(value.components)) {
    for (const entry of value.components) {
      if (!isRecord(entry) || typeof entry.name !== 'string') { continue }
      const result = parsePanelComponent(entry.name, entry.args)
      if (result.ok) { parts.push({ type: 'component', component: result.component }) }
    }
  }
  return parts
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
