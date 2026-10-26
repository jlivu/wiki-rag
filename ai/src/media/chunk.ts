/**
 * Cutting a video into chunks of time.
 *
 * A page is cut at its headings and a PDF at its pages; a recording has
 * neither, so it is cut by the clock — a minute or two at a time, which
 * is about as much as someone wants to be sent back to watch.
 *
 * What was said and what was on the screen go into the same chunk,
 * because that is how they were experienced and because a question is
 * usually answered by one or the other without knowing which. Each chunk
 * carries the moment it starts, so a citation can open the video there.
 *
 * A cut never falls in the middle of a sentence: a window that would end
 * mid-cue is extended to the end of that cue.
 */
import { CHUNK_MAX_CHARS, estimateTokens, hash } from '../indexer/chunker.js'

import type { Cue } from './subtitles.js'
import type { ScreenFrame } from './frames.js'

export interface VideoChunk {
  ordinal: number
  startsAt: number
  endsAt: number
  /** What a citation shows: "12:34–14:02". */
  location: string
  /** Opens the video there: "#t=754". */
  anchor: string
  text: string
  contentHash: string
  tokens: number
}

export interface ChunkOptions {
  /** Target length of one chunk, in seconds. */
  seconds: number
  /** Shown at the top of every chunk, so one read alone still says what it is. */
  title: string
}

export function chunkVideo (
  durationSeconds: number,
  cues: Cue[],
  frames: ScreenFrame[],
  options: ChunkOptions
): VideoChunk[] {
  const duration = durationSeconds > 0
    ? durationSeconds
    : Math.max(lastMoment(cues), lastFrame(frames))
  if (!(duration > 0)) { return [] }

  const chunks: VideoChunk[] = []
  for (const window of plan(duration, cues, Math.max(15, options.seconds))) {
    const body = compose(window, cues, frames)
    if (body.length === 0) { continue }

    // A very busy minute can outgrow a chunk; halving it by time keeps
    // every chunk pointing at a place in the recording.
    for (const piece of split(window, body, cues, frames)) {
      chunks.push({
        ordinal: chunks.length,
        startsAt: round(piece.start),
        endsAt: round(piece.end),
        location: `${timecode(piece.start)}–${timecode(piece.end)}`,
        anchor: `#t=${Math.max(0, Math.floor(piece.start))}`,
        text: prefix(options.title, `${timecode(piece.start)}–${timecode(piece.end)}`, piece.body),
        contentHash: hash(prefix(options.title, `${timecode(piece.start)}–${timecode(piece.end)}`, piece.body)),
        tokens: estimateTokens(piece.body)
      })
    }
  }
  return chunks
}

interface Window { start: number, end: number }

/**
 * Windows of about `seconds`, never cutting through a spoken sentence.
 *
 * A sentence that straddles the boundary starts the *next* window rather
 * than ending this one. Both keep the sentence whole; this way round a
 * fact said just before the boundary is at the top of the chunk that
 * holds it, so the citation sends the reader to within a few seconds of
 * it rather than a minute and a half before it.
 */
function plan (duration: number, cues: Cue[], seconds: number): Window[] {
  const windows: Window[] = []
  let at = 0
  while (at < duration - 0.5) {
    let end = Math.min(duration, at + seconds)
    const straddling = cues.find(cue => cue.start < end - 0.01 && cue.end > end)
    if (straddling) {
      // Unless that would leave a stub: a cue that began near the start
      // of this window is better swallowed than split off.
      end = straddling.start - at >= seconds * 0.5
        ? straddling.start
        : Math.min(duration, straddling.end)
    }
    if (end <= at + 0.5) { end = Math.min(duration, at + seconds) }
    windows.push({ start: at, end })
    at = end
  }

  // The tail can come out as a couple of seconds, which is not a place
  // worth sending a reader; it belongs to the window before it.
  const last = windows[windows.length - 1]
  const previous = windows[windows.length - 2]
  if (last && previous && last.end - last.start < seconds * 0.3) {
    previous.end = last.end
    windows.pop()
  }

  return windows
}

/** What was said and what was on screen, in that window. */
function compose (window: Window, cues: Cue[], frames: ScreenFrame[]): string {
  const spoken = cues
    .filter(cue => cue.end > window.start && cue.start < window.end)
    .map(cue => cue.text.trim())
    .filter(text => text.length > 0)

  const inWindow = frames.filter(frame => frame.at >= window.start && frame.at < window.end)
  const fresh = unique(inWindow.flatMap(frame => lines(frame.text)))
  // Nothing new appeared during this window, so say what was still up:
  // the chunk has to stand on its own when it is the one that matches.
  const standing = fresh.length > 0
    ? []
    : unique(lines(stillOnScreen(frames, window.start)))

  const described = inWindow
    .map(frame => (frame.description ?? '').trim())
    .filter(text => text.length > 0)

  const parts: string[] = []
  if (spoken.length > 0) { parts.push(`Said: ${spoken.join(' ')}`) }
  const screen = fresh.length > 0 ? fresh : standing
  if (screen.length > 0) { parts.push(`On screen: ${screen.join(' · ')}`) }
  for (const description of described) {
    // Labelled in the text itself, as an image description is, so the
    // model answering knows it is reading a machine's guess.
    parts.push(`Generated description of the picture: ${description}`)
  }
  return parts.join('\n')
}

/** The text that was last seen before this moment, if any. */
function stillOnScreen (frames: ScreenFrame[], at: number): string {
  let text = ''
  for (const frame of frames) {
    if (frame.at > at) { break }
    if (frame.fullText.trim().length > 0) { text = frame.fullText }
  }
  return text
}

interface Piece { start: number, end: number, body: string }

/** Halve a window that came out too long, by time, until it fits. */
function split (window: Window, body: string, cues: Cue[], frames: ScreenFrame[]): Piece[] {
  if (body.length <= CHUNK_MAX_CHARS || window.end - window.start < 20) {
    return [{ start: window.start, end: window.end, body }]
  }
  const middle = (window.start + window.end) / 2
  const halves: Window[] = [
    { start: window.start, end: middle },
    { start: middle, end: window.end }
  ]
  return halves.flatMap(half => {
    const text = compose(half, cues, frames)
    return text.length === 0 ? [] : split(half, text, cues, frames)
  })
}

function prefix (title: string, location: string, body: string): string {
  const header = [title.trim(), location].filter(part => part.length > 0).join(' › ')
  return header.length > 0 ? `${header}\n\n${body.trim()}` : body.trim()
}

/** `9:05`, and `1:09:05` once there is an hour to show. */
export function timecode (seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = whole % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`
}

function lines (text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
}

function unique (values: string[]): string[] {
  return [...new Set(values)]
}

function lastMoment (cues: Cue[]): number {
  return cues.reduce((latest, cue) => Math.max(latest, cue.end), 0)
}

function lastFrame (frames: ScreenFrame[]): number {
  return frames.reduce((latest, frame) => Math.max(latest, frame.at), 0)
}

function round (seconds: number): number {
  return Math.round(seconds * 100) / 100
}
