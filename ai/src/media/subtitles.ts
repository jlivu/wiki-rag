/**
 * Reading subtitles.
 *
 * A video that already has subtitles has already been transcribed, by
 * someone who could hear it: they are better than anything whisper would
 * produce, they are free, and they carry the timings. So they are used in
 * preference to transcribing, whether they are a file beside the video or
 * a track inside it.
 *
 * SRT and WebVTT are the same shape with different punctuation, so one
 * parser reads both.
 */

export interface Cue {
  /** Seconds from the start of the video. */
  start: number
  end: number
  text: string
}

/** `00:01:28,000` (SRT) or `00:01:28.000` / `01:28.000` (VTT). */
const TIME = /(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/
const ARROW = /-->/

export function parseSubtitles (body: string): Cue[] {
  const text = body.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const cues: Cue[] = []

  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').map(line => line.trim()).filter(line => line.length > 0)
    if (lines.length === 0) { continue }

    const timingAt = lines.findIndex(line => ARROW.test(line))
    if (timingAt < 0) { continue }

    const [from, to] = (lines[timingAt] as string).split(ARROW)
    const start = parseTime(from ?? '')
    const end = parseTime(to ?? '')
    if (start === null) { continue }

    const spoken = lines
      .slice(timingAt + 1)
      .map(cleanLine)
      .filter(line => line.length > 0)
      .join(' ')
    if (spoken.length === 0) { continue }

    cues.push({ start, end: end !== null && end > start ? end : start + 2, text: spoken })
  }

  return mergeOverlaps(cues)
}

/**
 * WebVTT can carry styling and positioning on the timing line and inline
 * tags in the text; SRT can carry a subset of HTML. None of it is wanted
 * in an index, and `<i>` left in would be searched for.
 */
function cleanLine (line: string): string {
  return line
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseTime (value: string): number | null {
  const match = TIME.exec(value.trim())
  if (!match) { return null }
  const [, hours, minutes, seconds, fraction] = match
  const millis = Number((fraction ?? '0').padEnd(3, '0'))
  return Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0) + millis / 1000
}

/**
 * Rolling captions repeat the previous line as the next one appears, so
 * the same sentence can arrive three times. A cue whose text the one
 * before it already ended with is folded into it.
 */
function mergeOverlaps (cues: Cue[]): Cue[] {
  const out: Cue[] = []
  for (const cue of cues.sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1]
    if (last && last.text === cue.text) {
      last.end = Math.max(last.end, cue.end)
      continue
    }
    out.push({ ...cue })
  }
  return out
}
