/**
 * How the chat app and the AI service talk to each other, and how the chat
 * app talks to the wiki page around it.
 */
import { readPageContext, type PageContext } from './components.js'
import { isEffortLevel, type EffortLevel } from './models.js'

/** Served by the Fastify service, behind the reverse proxy. */
export const HEALTH_PATH = '/ai/health'
export const AGENT_PATH = '/ai/api/agent'
/** The chat app. Trailing slash: it is a directory of static files. */
export const PANEL_PATH = '/ai/panel/'
/** MCP over Streamable HTTP, for agents outside the wiki. */
export const MCP_PATH = '/ai/mcp'
/**
 * Videos, served from the media folder on this Mac.
 *
 * Under /ai/ rather than at /media/ for two reasons: the reverse proxy
 * forwards /ai/* to this service and nothing else, so no proxy rule has
 * to be added or kept in step; and Wiki.js serves uploaded files from
 * the site root, so /media/ would shadow an asset folder of that name.
 */
export const MEDIA_PATH = '/ai/media/'

/** The URL of one video, at a moment in it. */
export function mediaUrl (path: string, seconds?: number): string {
  const encoded = path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')
  const at = seconds !== undefined && seconds > 0 ? `#t=${Math.floor(seconds)}` : ''
  return `${MEDIA_PATH}${encoded}${at}`
}

/**
 * Extra fields on an AG-UI run. `page` is the wiki page the reader is on, so
 * the agent can answer "this page" questions and rank nearby pages first.
 */
export interface ForwardedProps {
  page?: PageContext
  /**
   * Which model the reader picked, as an id from GET /ai/api/models. The
   * server looks it up in its own list and refuses anything else, so this
   * is a choice among the allowed, never a model name from the browser.
   */
  model?: string
  /** How hard it should work, as a level that model says it supports. */
  effort?: string
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

/** The reader's model choice, or undefined to use the server's default. */
export function readForwardedModel (value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) { return undefined }
  const id = (value as { model?: unknown }).model
  if (typeof id !== 'string') { return undefined }
  const trimmed = id.trim()
  return trimmed.length > 0 && trimmed.length <= 120 ? trimmed : undefined
}

/**
 * What the browser asked for: nothing, a level, or something else.
 *
 * "Nothing" and "something else" have to be told apart. Reading an
 * unrecognised value as "nothing" would quietly run at the default
 * instead of what was asked for, and the run would look to the reader
 * as if their choice had been honoured.
 */
export type ForwardedEffort =
  | { kind: 'absent' }
  | { kind: 'level', level: EffortLevel }
  | { kind: 'unknown' }

export function readForwardedEffort (value: unknown): ForwardedEffort {
  if (typeof value !== 'object' || value === null) { return { kind: 'absent' } }
  const effort = (value as { effort?: unknown }).effort
  if (effort === undefined || effort === null) { return { kind: 'absent' } }
  return isEffortLevel(effort) ? { kind: 'level', level: effort } : { kind: 'unknown' }
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
  /** True when the browser sent a Wiki.js login cookie. */
  signedIn: boolean
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
