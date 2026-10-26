/**
 * Everything that reads a video file: ffprobe for what is in it, ffmpeg
 * for the audio, the frames and any embedded subtitle track. Both are
 * installed in the service's image (see ai/Dockerfile).
 *
 * Nothing here reads the container's metadata beyond the few fields
 * listed below. A phone records where it was standing in the QuickTime
 * tags, so the allow-list is the privacy rule: duration, size, and which
 * streams exist, and nothing else is even looked at. Everything written
 * out carries `-map_metadata -1`, so nothing can be carried along either.
 */
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Probing is instant; decoding a long recording is not. */
const PROBE_TIMEOUT_MS = 30_000
const DECODE_TIMEOUT_MS = 20 * 60_000
/** ffmpeg writes a lot to stderr; showinfo on a long video writes more. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024

export class MediaError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'MediaError'
  }
}

export interface VideoProbe {
  durationSeconds: number
  width: number
  height: number
  hasAudio: boolean
  /** Indexes within the subtitle streams, for -map 0:s:N. */
  subtitleStreams: number[]
}

/**
 * What the file is, in the few terms we are willing to read.
 *
 * `-show_entries` names the fields explicitly, so a location tag is never
 * even parsed, let alone indexed.
 */
export async function probeVideo (file: string): Promise<VideoProbe> {
  let stdout: string
  try {
    ({ stdout } = await run('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=index,codec_type,width,height,duration',
      '-of', 'json',
      file
    ], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }))
  } catch (err) {
    throw new MediaError(`ffprobe could not read the file: ${reasonOf(err)}`)
  }

  let parsed: {
    format?: { duration?: string }
    streams?: Array<{ codec_type?: string, width?: number, height?: number, duration?: string }>
  }
  try {
    parsed = JSON.parse(stdout) as typeof parsed
  } catch {
    throw new MediaError('ffprobe returned something that is not JSON')
  }

  const streams = parsed.streams ?? []
  const video = streams.find(stream => stream.codec_type === 'video')
  if (!video) { throw new MediaError('there is no video stream in this file') }

  const subtitleStreams: number[] = []
  let subtitleAt = 0
  for (const stream of streams) {
    if (stream.codec_type === 'subtitle') { subtitleStreams.push(subtitleAt++) }
  }

  const duration = Number(parsed.format?.duration ?? video.duration ?? 0)
  return {
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : 0,
    width: Number(video.width ?? 0),
    height: Number(video.height ?? 0),
    hasAudio: streams.some(stream => stream.codec_type === 'audio'),
    subtitleStreams
  }
}

/**
 * One slice of the audio as 16 kHz mono WAV: exactly what whisper.cpp
 * takes, so nothing has to transcode on the way.
 *
 * `-ss` before `-i` seeks the input, which is near-instant on a long
 * recording; ffmpeg still decodes to the exact moment from the preceding
 * keyframe, so the slice starts where it says it does.
 */
export async function extractAudioSlice (
  file: string,
  startSeconds: number,
  seconds: number,
  output: string
): Promise<void> {
  try {
    await run('ffmpeg', [
      '-nostdin', '-loglevel', 'error', '-y',
      '-ss', startSeconds.toFixed(3),
      '-t', seconds.toFixed(3),
      '-i', file,
      '-vn', '-sn', '-dn',
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      '-map_metadata', '-1',
      output
    ], { timeout: DECODE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES })
  } catch (err) {
    throw new MediaError(`the audio could not be read: ${reasonOf(err)}`)
  }
}

/** An embedded subtitle track, converted to SRT. Empty when there is none. */
export async function extractSubtitleTrack (file: string, stream: number): Promise<string> {
  try {
    const { stdout } = await run('ffmpeg', [
      '-nostdin', '-loglevel', 'error',
      '-i', file,
      '-map', `0:s:${stream}`,
      '-map_metadata', '-1',
      '-f', 'srt', '-'
    ], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })
    return stdout
  } catch {
    // A track in a codec ffmpeg will not convert is not an error: the
    // video is transcribed instead.
    return ''
  }
}

export interface ExtractedFrame {
  /** Seconds from the start of the video. */
  at: number
  /** The file written, a JPEG. */
  file: string
}

export interface FrameOptions {
  /** 0–1. Higher means fewer frames; 0.3 catches a slide change. */
  sceneThreshold: number
  /** A frame at least this often, whatever the picture is doing. */
  everySeconds: number
  maxFrames: number
  /** Long edge, for OCR. Bigger reads better and costs more. */
  maxWidth: number
}

/**
 * The frames worth reading: every scene change, and one at least every
 * `everySeconds` whether anything changed or not.
 *
 * One decode pass for the whole video. `select` keeps a frame when the
 * scene score jumps *or* enough time has passed since the last one it
 * kept; `showinfo` then prints the timestamp of each frame that got
 * through, in order, which is how a file on disk is matched to a moment
 * in the recording.
 */
export async function extractFrames (
  file: string,
  directory: string,
  options: FrameOptions
): Promise<ExtractedFrame[]> {
  const select = [
    `gt(scene,${options.sceneThreshold})`,
    // The first frame has no predecessor, so prev_selected_t is NAN.
    'isnan(prev_selected_t)',
    `gte(t-prev_selected_t,${options.everySeconds})`
  ].join('+')

  let stderr = ''
  try {
    ({ stderr } = await run('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'info', '-y',
      '-i', file,
      '-map', '0:v:0', '-an', '-sn', '-dn',
      '-vf', `select='${select}',scale='min(${options.maxWidth},iw)':-2,showinfo`,
      '-fps_mode', 'vfr',
      '-frames:v', String(options.maxFrames),
      '-q:v', '3',
      '-map_metadata', '-1',
      join(directory, 'frame-%05d.jpg')
    ], { timeout: DECODE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES }))
  } catch (err) {
    throw new MediaError(`the frames could not be read: ${reasonOf(err)}`)
  }

  const times = [...stderr.matchAll(/pts_time:\s*([0-9]+(?:\.[0-9]+)?)/g)]
    .map(match => Number(match[1]))
    .filter(value => Number.isFinite(value))

  // The files are numbered in the order they were written, which is the
  // order showinfo printed; pair them up and ignore any mismatch at the
  // end, which can happen when ffmpeg stops at the frame limit.
  const written = (await readdir(directory))
    .filter(name => name.startsWith('frame-') && name.endsWith('.jpg'))
    .sort()

  return written.slice(0, times.length).map((name, at) => ({
    at: times[at] ?? 0,
    file: join(directory, name)
  }))
}

export interface SilenceWindow {
  start: number
  end: number
}

/**
 * Where the recording goes quiet, so the audio can be cut up without
 * slicing through the middle of a word.
 *
 * Returns the quiet stretches; the caller cuts in the middle of one.
 */
export async function detectSilence (
  file: string,
  noiseDb = -32,
  minSeconds = 0.3
): Promise<SilenceWindow[]> {
  let stderr = ''
  try {
    ({ stderr } = await run('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'info',
      '-i', file,
      '-vn', '-sn', '-dn',
      '-af', `silencedetect=noise=${noiseDb}dB:d=${minSeconds}`,
      '-f', 'null', '-'
    ], { timeout: DECODE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES }))
  } catch {
    // Without this the audio is cut at fixed times, which is worse but
    // not wrong, so a failure here never fails the video.
    return []
  }

  const windows: SilenceWindow[] = []
  let open: number | null = null
  for (const line of stderr.split('\n')) {
    const start = /silence_start:\s*(-?[0-9.]+)/.exec(line)
    if (start?.[1]) { open = Number(start[1]); continue }
    const end = /silence_end:\s*(-?[0-9.]+)/.exec(line)
    if (end?.[1] && open !== null) {
      windows.push({ start: Math.max(0, open), end: Number(end[1]) })
      open = null
    }
  }
  return windows
}

/** Whether ffmpeg is installed at all, so the service can say so plainly. */
export async function ffmpegAvailable (): Promise<boolean> {
  try {
    await run('ffprobe', ['-version'], { timeout: 5000 })
    await run('ffmpeg', ['-version'], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

function reasonOf (err: unknown): string {
  const stderr = (err as { stderr?: string }).stderr
  if (typeof stderr === 'string' && stderr.trim().length > 0) {
    return stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)
  }
  return err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300)
}
