/**
 * Transcribing a recording, with the times kept.
 *
 * whisper.cpp runs natively on this Mac so it can use the GPU, the same
 * arrangement as Ollama and the same server the panel's dictation uses.
 * Nothing is sent anywhere else.
 *
 * The audio is sent a window at a time rather than in one piece, for
 * three reasons: a twenty-minute recording would otherwise be a 38 MB
 * upload held in memory at both ends; a reader dictating into the panel
 * would wait behind it; and the window's own start time is what gives
 * each line of the transcript a place in the video.
 *
 * Where the windows are cut matters, so they are cut in a silence
 * wherever there is one near the target length, rather than through the
 * middle of a word.
 *
 * If whisper is running with timestamps enabled it reports where each
 * sentence starts and those are used instead, to the exact second. This
 * Mac's launch agent passes `--no-timestamps` (it was set up for
 * dictation, which has no use for them), so the window times are what we
 * normally get; within a window, lines are placed by how long they are,
 * which puts a sentence within a few seconds of where it was said.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withoutFiller } from './filler.js'
import { detectSilence, extractAudioSlice, type SilenceWindow } from './ffmpeg.js'
import type { Cue } from './subtitles.js'

export interface TranscribeOptions {
  /** whisper.cpp's base URL. */
  url: string
  language: string
  /** Target length of one window, in seconds. */
  windowSeconds: number
  /** How far either side of the target a silence may be, to cut there. */
  driftSeconds?: number
  /** Called after each window, for the progress line in the status. */
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

export interface Transcript {
  cues: Cue[]
  windows: number
  /** 'whisper' when the server reported its own times, 'window' when not. */
  timing: 'whisper' | 'window'
  ms: number
}

export async function transcribeVideo (
  file: string,
  durationSeconds: number,
  options: TranscribeOptions
): Promise<Transcript> {
  const startedAt = Date.now()
  const silences = await detectSilence(file)
  const windows = planWindows(durationSeconds, options.windowSeconds, silences, options.driftSeconds ?? 8)

  const directory = await mkdtemp(join(tmpdir(), 'wiki-speech-'))
  const cues: Cue[] = []
  let timing: 'whisper' | 'window' = 'whisper'

  try {
    for (const [at, window] of windows.entries()) {
      options.signal?.throwIfAborted()
      const wav = join(directory, `window-${at}.wav`)
      await extractAudioSlice(file, window.start, window.end - window.start, wav)
      const audio = await readFile(wav)
      await rm(wav, { force: true })

      const segments = await askWhisper(options.url, options.language, audio, options.signal)
      if (segments.length > 0 && !segments.some(segment => segment.start !== null)) {
        timing = 'window'
      }
      cues.push(...place(segments, window))
      options.onProgress?.(at + 1, windows.length)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }

  return { cues, windows: windows.length, timing, ms: Date.now() - startedAt }
}

interface Window { start: number, end: number }

/**
 * Where to cut the audio.
 *
 * Each window runs to about `target` seconds, then to the middle of the
 * nearest silence within `drift` of that — so a pause between sentences
 * becomes the join, and a word is not sliced in half.
 */
export function planWindows (
  duration: number,
  target: number,
  silences: SilenceWindow[],
  drift: number
): Window[] {
  if (!(duration > 0)) { return [] }
  const windows: Window[] = []
  let at = 0

  while (at < duration - 0.5) {
    const wanted = at + target
    if (wanted >= duration - drift) {
      windows.push({ start: at, end: duration })
      break
    }
    const cut = nearestSilence(silences, wanted, drift) ?? wanted
    // Never go backwards, and never produce a window of nothing.
    const end = Math.min(duration, Math.max(cut, at + 1))
    windows.push({ start: at, end })
    at = end
  }

  return windows
}

function nearestSilence (silences: SilenceWindow[], wanted: number, drift: number): number | null {
  let best: number | null = null
  let bestGap = drift
  for (const silence of silences) {
    const middle = (silence.start + Math.max(silence.start, silence.end)) / 2
    const gap = Math.abs(middle - wanted)
    if (gap <= bestGap) {
      best = middle
      bestGap = gap
    }
  }
  return best
}

interface WhisperSegment {
  text: string
  /** Null when the server is running with timestamps turned off. */
  start: number | null
  end: number | null
}

/**
 * Put each line of a window somewhere sensible.
 *
 * With whisper's own times, exactly where it said. Without them, the
 * window is shared out by how long each line is, which is a good proxy
 * for how long it took to say.
 */
function place (segments: WhisperSegment[], window: Window): Cue[] {
  // A pause between two slides comes back as "you" or "Thank you."; a
  // line that is nothing but that is silence, not speech.
  const spoken = segments.filter(segment => withoutFiller(segment.text.trim()).length > 0)
  if (spoken.length === 0) { return [] }

  if (spoken.every(segment => segment.start !== null)) {
    return spoken.map(segment => ({
      start: window.start + (segment.start ?? 0),
      end: window.start + (segment.end ?? segment.start ?? 0),
      text: segment.text.trim()
    }))
  }

  const length = spoken.reduce((sum, segment) => sum + segment.text.trim().length, 0) || 1
  const span = Math.max(0.5, window.end - window.start)
  let at = window.start
  return spoken.map(segment => {
    const text = segment.text.trim()
    const share = (text.length / length) * span
    const cue = { start: at, end: Math.min(window.end, at + share), text }
    at = cue.end
    return cue
  })
}

/** whisper.cpp's own endpoint, the same one dictation posts to. */
async function askWhisper (
  baseUrl: string,
  language: string,
  audio: Buffer,
  signal?: AbortSignal
): Promise<WhisperSegment[]> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'window.wav')
  form.append('response_format', 'verbose_json')
  form.append('language', language)
  // One speaker, read aloud: the fallback temperatures invent more than
  // they rescue.
  form.append('temperature', '0')

  let response: Response
  try {
    response = await fetch(`${baseUrl}/inference`, {
      method: 'POST',
      body: form,
      signal: signal ?? AbortSignal.timeout(10 * 60_000)
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') { throw err }
    throw new Error('whisper.cpp is unreachable; is the launch agent running?')
  }
  if (!response.ok) {
    throw new Error(`whisper.cpp returned ${response.status}`)
  }

  const body = await response.json() as {
    text?: unknown
    segments?: Array<{ text?: unknown, start?: unknown, end?: unknown }>
  }

  const segments = Array.isArray(body.segments) ? body.segments : []
  if (segments.length > 0) {
    return segments.map(segment => ({
      text: typeof segment.text === 'string' ? segment.text : '',
      start: typeof segment.start === 'number' ? segment.start : null,
      end: typeof segment.end === 'number' ? segment.end : null
    })).filter(segment => segment.text.trim().length > 0)
  }

  const whole = typeof body.text === 'string' ? body.text.trim() : ''
  return whole.length > 0 ? [{ text: whole, start: null, end: null }] : []
}
