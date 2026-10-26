/**
 * Indexing one video.
 *
 * Three things are read, in this order:
 *
 *   subtitles   a .srt or .vtt beside the file, or a track inside it
 *   speech      whisper.cpp, when there are no subtitles to use
 *   the screen  frames at every scene change, read by Tesseract
 *
 * Subtitles win over transcribing because they were written by someone
 * who could hear the recording, they already carry the times, and they
 * cost nothing. Everything here runs on this Mac; only a frame
 * description leaves it, and that is off by default.
 *
 * The chunks are cut by the clock, so every one of them knows the moment
 * it starts and a citation can open the video there.
 */
import { readFile, stat } from 'node:fs/promises'

import type { Pool } from 'pg'

import type { MediaConfig } from '../config.js'
import type { ImageDescriber } from '../images/describe.js'
import type { QueuedJob } from '../index-db/queue.js'
import {
  existingVideoEmbeddings, readVideo, removeVideo, replaceVideo, type IndexedVideo
} from '../index-db/store.js'
import { chunkVideo } from '../media/chunk.js'
import { extractSubtitleTrack, MediaError, probeVideo } from '../media/ffmpeg.js'
import { readScreenText, type ScreenFrame } from '../media/frames.js'
import {
  sourceHashOf, titleFrom, type MediaFile, type MediaLibrary
} from '../media/library.js'
import { transcribeVideo } from '../media/speech.js'
import { parseSubtitles, type Cue } from '../media/subtitles.js'

import { toVectorLiteral, type Embedder } from './embeddings.js'
import type { JobOutcome } from './job.js'

/** Where a job has got to, for the index status while it runs. */
export interface VideoProgress {
  path: string
  stage: 'reading' | 'subtitles' | 'listening' | 'watching' | 'embedding'
  /** 0–100, or null when the stage has no measure. */
  percent: number | null
  startedAt: number
}

export interface VideoJobOptions {
  media: MediaConfig
  library: MediaLibrary
  /** whisper.cpp's base URL, and the language it is told to expect. */
  speech: { url: string, language: string, enabled: boolean }
  describer: ImageDescriber
  excludeFolders: readonly string[]
  describeDailyLimit: number
  /** Called as the job moves on, so the status can show it. */
  onProgress?: (progress: Omit<VideoProgress, 'startedAt'>) => void
  signal?: AbortSignal
}

export async function runVideoJob (
  db: Pool,
  embedder: Embedder,
  job: QueuedJob,
  options: VideoJobOptions
): Promise<JobOutcome> {
  const indexed = await readVideo(db, job.entityId)

  if (job.event === 'deleted') {
    await removeVideo(db, job.entityId)
    return { action: 'removed', reason: 'deleted' }
  }

  const path = indexed?.path ?? job.path ?? ''
  if (path.length === 0) {
    await removeVideo(db, job.entityId)
    return { action: 'removed', reason: 'no path' }
  }

  const file = options.library.resolveFile(path)
  if (!file) {
    await removeVideo(db, job.entityId)
    return { action: 'removed', reason: 'outside the media folder' }
  }

  // The scan may be a few seconds old; the file is the truth.
  let size = 0
  let modifiedAt = ''
  try {
    const info = await stat(file)
    size = info.size
    modifiedAt = info.mtime.toISOString()
  } catch {
    await removeVideo(db, job.entityId)
    return { action: 'removed', reason: 'gone' }
  }

  const subtitleFile = await findSubtitleFile(options.library, path)
  const media: MediaFile = {
    path,
    fileName: path.split('/').pop() ?? path,
    ext: extensionOf(path),
    fileSize: size,
    modifiedAt,
    subtitlePath: subtitleFile?.path ?? null,
    subtitleStamp: subtitleFile?.stamp ?? ''
  }
  const sourceHash = sourceHashOf(media)

  const base: IndexedVideo = {
    id: job.entityId,
    path,
    fileName: media.fileName,
    ext: media.ext,
    title: indexed?.title && indexed.title.length > 0 ? indexed.title : titleFrom(media.fileName),
    fileSize: size,
    modifiedAt,
    durationSeconds: indexed?.durationSeconds ?? 0,
    width: indexed?.width ?? 0,
    height: indexed?.height ?? 0,
    sourceHash,
    speechSource: indexed?.speechSource ?? '',
    frames: indexed?.frames ?? 0,
    status: 'indexed',
    reason: ''
  }

  // Nothing about the file or its subtitles has changed since it was read.
  if (indexed && indexed.status === 'indexed' && indexed.sourceHash === sourceHash) {
    return { action: 'skipped', reason: 'unchanged' }
  }

  options.onProgress?.({ path, stage: 'reading', percent: null })

  let probe
  try {
    probe = await probeVideo(file)
  } catch (err) {
    const reason = err instanceof MediaError ? err.message : 'the file could not be read'
    await replaceVideo(db, { ...base, status: 'failed', reason }, [], embedder.model)
    return { action: 'skipped', reason }
  }

  const minutes = probe.durationSeconds / 60
  if (options.media.maxMinutes > 0 && minutes > options.media.maxMinutes) {
    const reason = `longer than the ${options.media.maxMinutes} minute limit (${minutes.toFixed(0)} minutes)`
    await replaceVideo(db, {
      ...base,
      durationSeconds: probe.durationSeconds,
      width: probe.width,
      height: probe.height,
      status: 'skipped',
      reason
    }, [], embedder.model)
    return { action: 'skipped', reason }
  }

  // ── the words ──────────────────────────────────────────────────────
  let cues: Cue[] = []
  let speechSource = 'none'
  let speechMs = 0
  let timing: 'subtitles' | 'whisper' | 'window' = 'subtitles'

  const sidecar = subtitleFile ? await readSubtitleFile(options.library, subtitleFile.path) : null
  if (sidecar && sidecar.length > 0) {
    options.onProgress?.({ path, stage: 'subtitles', percent: null })
    cues = sidecar
    speechSource = 'subtitles-file'
  } else if (probe.subtitleStreams.length > 0) {
    options.onProgress?.({ path, stage: 'subtitles', percent: null })
    const track = await extractSubtitleTrack(file, probe.subtitleStreams[0] as number)
    const parsed = parseSubtitles(track)
    if (parsed.length > 0) {
      cues = parsed
      speechSource = 'subtitles-embedded'
    }
  }

  if (cues.length === 0 && probe.hasAudio && options.speech.enabled) {
    options.onProgress?.({ path, stage: 'listening', percent: 0 })
    const spoken = await transcribeVideo(file, probe.durationSeconds, {
      url: options.speech.url,
      language: options.speech.language,
      windowSeconds: options.media.speechWindowSeconds,
      onProgress: (done, total) => {
        options.onProgress?.({ path, stage: 'listening', percent: Math.round((done / total) * 100) })
      },
      ...(options.signal ? { signal: options.signal } : {})
    })
    cues = spoken.cues
    speechMs = spoken.ms
    timing = spoken.timing
    speechSource = cues.length > 0 ? 'speech' : 'none'
  }

  // ── the screen ─────────────────────────────────────────────────────
  options.onProgress?.({ path, stage: 'watching', percent: 0 })
  let frames: ScreenFrame[] = []
  let screen = {
    taken: 0, ocrChars: 0, described: 0, fresh: 0, inputTokens: 0, outputTokens: 0, ms: 0
  }
  let describedFrames: string[] = []

  if (options.media.ocr || options.media.describe) {
    const read = await readScreenText(file, {
      mediaPath: path,
      sceneThreshold: options.media.sceneThreshold,
      everySeconds: options.media.frameSeconds,
      maxFrames: options.media.maxFrames,
      maxWidth: 1600,
      ocr: options.media.ocr,
      describe: options.media.describe,
      describer: options.describer,
      excludeFolders: options.excludeFolders,
      dailyLimit: options.describeDailyLimit,
      describeCap: options.media.describeFrameCap,
      onProgress: (done, total) => {
        options.onProgress?.({ path, stage: 'watching', percent: Math.round((done / total) * 100) })
      },
      ...(options.signal ? { signal: options.signal } : {})
    }, db)
    frames = read.frames
    describedFrames = read.describedHashes
    screen = {
      taken: read.taken,
      ocrChars: read.ocrChars,
      described: read.described,
      fresh: read.describedFresh,
      inputTokens: read.describeInputTokens,
      outputTokens: read.describeOutputTokens,
      ms: read.ms
    }
  }

  // ── chunks ─────────────────────────────────────────────────────────
  const chunks = chunkVideo(probe.durationSeconds, cues, frames, {
    seconds: options.media.chunkSeconds,
    title: base.title
  })

  const video: IndexedVideo = {
    ...base,
    durationSeconds: probe.durationSeconds,
    width: probe.width,
    height: probe.height,
    speechSource,
    frames: screen.taken
  }

  if (chunks.length === 0) {
    const reason = probe.hasAudio
      ? 'nothing was said and nothing could be read on screen'
      : 'no soundtrack, and nothing could be read on screen'
    await replaceVideo(db, { ...video, status: 'failed', reason }, [], embedder.model, describedFrames)
    return { action: 'skipped', reason }
  }

  options.onProgress?.({ path, stage: 'embedding', percent: null })

  // A chunk whose text is unchanged keeps the vector it already has.
  const reusable = await existingVideoEmbeddings(db, video.id)
  const fresh = chunks.filter(chunk => !reusable.has(chunk.contentHash))
  const vectors = await embedder.embed(fresh.map(chunk => chunk.text))

  const byHash = new Map(reusable)
  fresh.forEach((chunk, at) => {
    const vector = vectors[at]
    if (vector) { byHash.set(chunk.contentHash, toVectorLiteral(vector)) }
  })

  const rows = chunks.flatMap(chunk => {
    const embeddingLiteral = byHash.get(chunk.contentHash)
    return embeddingLiteral
      ? [{
          ordinal: chunk.ordinal,
          headingPath: chunk.location,
          anchor: chunk.anchor,
          location: chunk.location,
          origin: '',
          startsAt: chunk.startsAt,
          endsAt: chunk.endsAt,
          text: chunk.text,
          contentHash: chunk.contentHash,
          tokens: chunk.tokens,
          embedding: null,
          embeddingLiteral
        }]
      : []
  })

  await replaceVideo(db, video, rows, embedder.model, describedFrames)

  return {
    action: 'indexed',
    chunks: rows.length,
    embedded: fresh.length,
    seconds: Math.round(probe.durationSeconds),
    speech: speechSource,
    ...(speechSource === 'speech' ? { speechMs, timing } : {}),
    cues: cues.length,
    frames: screen.taken,
    ocrChars: screen.ocrChars,
    framesMs: screen.ms,
    ...(screen.described > 0
      ? {
          described: screen.described,
          describedFresh: screen.fresh,
          describeInputTokens: screen.inputTokens,
          describeOutputTokens: screen.outputTokens
        }
      : {})
  }
}

/** The .srt or .vtt beside a video, if there is one. */
async function findSubtitleFile (
  library: MediaLibrary,
  videoPath: string
): Promise<{ path: string, stamp: string } | null> {
  const stem = videoPath.replace(/\.[^.]+$/, '')
  // .vtt first: when both exist it is the richer format.
  for (const ext of ['.vtt', '.srt']) {
    const candidate = `${stem}${ext}`
    const file = library.resolveFile(candidate)
    if (!file) { continue }
    try {
      const info = await stat(file)
      return { path: candidate, stamp: `${info.size}:${info.mtime.toISOString()}` }
    } catch {
      // Not there; try the other extension.
    }
  }
  return null
}

async function readSubtitleFile (library: MediaLibrary, path: string): Promise<Cue[] | null> {
  const file = library.resolveFile(path)
  if (!file) { return null }
  try {
    return parseSubtitles(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

function extensionOf (path: string): string {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}
