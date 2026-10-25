/**
 * How the chat app and the AI service talk to each other, and how the chat
 * app talks to the wiki page around it.
 */
import { readPageContext, type PageContext } from './components.js'

/** Served by the Fastify service, behind the reverse proxy. */
export const HEALTH_PATH = '/ai/health'
export const AGENT_PATH = '/ai/api/agent'
/** The chat app. Trailing slash: it is a directory of static files. */
export const PANEL_PATH = '/ai/panel/'
/** MCP over Streamable HTTP, for agents outside the wiki. */
export const MCP_PATH = '/ai/mcp'

/**
 * Extra fields on an AG-UI run. `page` is the wiki page the reader is on, so
 * the agent can answer "this page" questions and rank nearby pages first.
 */
export interface ForwardedProps {
  page?: PageContext
}

/** Never throws: a malformed page context just means the agent has none. */
export function readForwardedPage (value: unknown): PageContext | undefined {
  if (typeof value !== 'object' || value === null) { return undefined }
  const page = (value as { page?: unknown }).page
  if (page === undefined || page === null) { return undefined }
  try {
    return readPageContext(page)
  } catch {
    return undefined
  }
}

/** What GET /ai/health answers. */
export interface HealthResponse {
  ok: boolean
  provider: {
    /** anthropic, ollama or mock. */
    id: string
    model: string
    /** Status chip text, e.g. "Claude Sonnet 5.5 · Cloud". */
    label: string
  }
  /** Dictation. With `enabled: false` the panel shows no microphone. */
  speech: {
    enabled: boolean
    /** Longest recording the service will accept, in seconds. */
    maxSeconds: number
    /** What the browser should record and send: 16 kHz mono WAV. */
    sampleRate: number
  }
}

/** Where the panel sends a recording. */
export const TRANSCRIBE_PATH = '/ai/api/transcribe'

/** The one audio shape the service takes, so it never has to transcode. */
export const SPEECH_SAMPLE_RATE = 16000

/** Status chip text in the panel header, when the service has not said. */
export const STATUS_ONLINE_LABEL = 'Connected'
export const STATUS_OFFLINE_LABEL = 'Offline'

/**
 * Messages the chat app posts to the wiki page that frames it. The panel
 * (client/components/ai/chat-drawer.vue) checks the origin and the source
 * window before acting on one.
 */
export type ParentMessage =
  | { type: 'wiki-ai:status', label: string, online: boolean }
  | { type: 'wiki-ai:unread', count: number }
  | { type: 'wiki-ai:close' }

/**
 * Messages the wiki page posts into the chat app's iframe. The chat app
 * takes one only from its own parent window, on its own origin.
 */
export type PanelMessage =
  | { type: 'wiki-ai:new-chat' }
