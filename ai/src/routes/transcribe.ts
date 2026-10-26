/**
 * Dictation: turning a recording into text.
 *
 * The recording goes to whisper.cpp, which runs natively on this Mac so it
 * can use the GPU — the same arrangement as Ollama, reached from the
 * container through host.docker.internal. Nothing is sent to a cloud
 * service, and nothing is kept: the audio exists only for the length of
 * the request, and the log records how long it was and how long it took,
 * never what was said.
 *
 * The browser sends 16 kHz mono WAV and nothing else, so the service never
 * has to transcode. That is checked here rather than trusted.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'

import type { Config } from '../config.js'
import { RateLimiter } from '../mcp/rate-limit.js'
import { withoutFiller } from '../media/filler.js'
import { readWikiToken } from '../wiki/client.js'
import { SPEECH_SAMPLE_RATE, TRANSCRIBE_PATH } from '../../shared/index.js'

export { withoutFiller }

const WAV_CONTENT_TYPES = ['audio/wav', 'audio/wave', 'audio/x-wav']
/** 16-bit mono at 16 kHz is 32 kB a second; the header and some slack on top. */
const BYTES_PER_SECOND = SPEECH_SAMPLE_RATE * 2
const SIZE_SLACK_BYTES = 64 * 1024

export function transcribeRoutes (config: Config): FastifyPluginAsync {
  const speech = config.speech
  const maxBytes = speech.maxSeconds * BYTES_PER_SECOND + SIZE_SLACK_BYTES
  const limiter = new RateLimiter(speech.rateLimitPerMinute)

  return async (app) => {
    if (speech.provider === 'off') {
      // Say so plainly rather than 404ing: the panel hides the microphone
      // from the health check, so only a stale tab can get here.
      app.post(TRANSCRIBE_PATH, async (_request, reply) =>
        reply.code(503).send({ error: 'Dictation is switched off on this wiki.' }))
      return
    }

    // The body is audio, not JSON. Fastify needs telling, with the ceiling
    // applied before the bytes are read into memory.
    for (const type of WAV_CONTENT_TYPES) {
      app.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: maxBytes }, (_request, body, done) => {
        done(null, body)
      })
    }

    // A body over the ceiling is rejected by Fastify before the handler
    // runs, and its own message is no use to a reader. Say what the limit
    // actually is, in the shape the panel reads.
    app.setErrorHandler(async (error: unknown, _request, reply) => {
      const fastifyError = error as { code?: string, statusCode?: number }
      if (fastifyError.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        return reply.code(413).send({
          error: `That recording is too long. The limit is ${speech.maxSeconds} seconds.`
        })
      }
      return reply.code(fastifyError.statusCode ?? 500).send({
        error: 'The recording could not be transcribed.'
      })
    })

    app.post(TRANSCRIBE_PATH, async (request, reply) => {
      const startedAt = Date.now()
      const who = readerKey(request)

      const allowed = limiter.take(who)
      if (!allowed.allowed) {
        return reply
          .code(429)
          .header('retry-after', String(allowed.retryAfterSeconds))
          .send({ error: 'That is a lot of dictation. Wait a moment and try again.' })
      }

      const audio = request.body
      if (!Buffer.isBuffer(audio) || audio.length === 0) {
        return reply.code(400).send({ error: 'Send the recording as 16 kHz mono WAV.' })
      }
      if (audio.length > maxBytes) {
        return reply.code(413).send({ error: `That recording is too long. The limit is ${speech.maxSeconds} seconds.` })
      }

      const wav = readWavHeader(audio)
      if (!wav.ok) {
        return reply.code(400).send({ error: wav.error })
      }
      if (wav.seconds > speech.maxSeconds + 1) {
        return reply.code(413).send({ error: `That recording is too long. The limit is ${speech.maxSeconds} seconds.` })
      }

      try {
        const text = await transcribe(speech.url, speech.language, audio, speech.maxSeconds)
        const ms = Date.now() - startedAt
        // Duration and timing only: never the audio, never the words.
        request.log.info({
          seconds: Number(wav.seconds.toFixed(1)),
          bytes: audio.length,
          chars: text.length,
          ms
        }, 'transcribed a recording')
        return reply.send({ text, seconds: Number(wav.seconds.toFixed(1)), ms })
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown error'
        request.log.warn({ err, seconds: Number(wav.seconds.toFixed(1)) }, 'transcription failed')
        return reply.code(503).send({
          error: 'The speech service did not answer. Type your message instead.',
          detail: reason
        })
      }
    })
  }
}

/** One reader, for the rate limit. The token is never stored as it is. */
function readerKey (request: FastifyRequest): string {
  const token = readWikiToken(request)
  if (token) { return token }
  return request.ip || 'anonymous'
}

interface WavHeader {
  ok: true
  seconds: number
  sampleRate: number
  channels: number
}

type WavResult = WavHeader | { ok: false, error: string }

/**
 * Enough of the RIFF header to know this really is the audio we asked the
 * browser for. Anything else is refused rather than transcoded: the one
 * shape keeps whisper.cpp off ffmpeg and keeps this route predictable.
 */
export function readWavHeader (audio: Buffer): WavResult {
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, error: 'That does not look like a WAV recording.' }
  }

  let at = 12
  let format = 0
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataBytes = 0

  while (at + 8 <= audio.length) {
    const id = audio.toString('ascii', at, at + 4)
    const size = audio.readUInt32LE(at + 4)
    const body = at + 8

    if (id === 'fmt ' && body + 16 <= audio.length) {
      format = audio.readUInt16LE(body)
      channels = audio.readUInt16LE(body + 2)
      sampleRate = audio.readUInt32LE(body + 4)
      bitsPerSample = audio.readUInt16LE(body + 14)
    } else if (id === 'data') {
      // A stream written as it was recorded can declare a size of zero.
      dataBytes = size > 0 ? Math.min(size, audio.length - body) : audio.length - body
      break
    }
    // Chunks are padded to an even length.
    at = body + size + (size % 2)
  }

  if (format !== 1 || bitsPerSample !== 16) {
    return { ok: false, error: 'Send the recording as 16-bit PCM WAV.' }
  }
  if (channels !== 1 || sampleRate !== SPEECH_SAMPLE_RATE) {
    return { ok: false, error: `Send the recording as ${SPEECH_SAMPLE_RATE / 1000} kHz mono WAV.` }
  }
  if (dataBytes <= 0) {
    return { ok: false, error: 'That recording has no audio in it.' }
  }

  return { ok: true, seconds: dataBytes / (sampleRate * channels * 2), sampleRate, channels }
}

/** whisper.cpp's own endpoint: multipart, with the file under `file`. */
async function transcribe (
  baseUrl: string,
  language: string,
  audio: Buffer,
  maxSeconds: number
): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'speech.wav')
  form.append('response_format', 'json')
  form.append('language', language)
  // Dictation is one person talking; the default temperature invents less
  // when it is unsure if fallback is left on.
  form.append('temperature', '0')

  let response: Response
  try {
    response = await fetch(`${baseUrl}/inference`, {
      method: 'POST',
      body: form,
      // Transcribing is quicker than real time, with room for a cold model.
      signal: AbortSignal.timeout(Math.max(30_000, maxSeconds * 1000))
    })
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError'
    throw new Error(timedOut ? 'the speech service timed out' : 'the speech service is unreachable')
  }

  if (!response.ok) {
    throw new Error(`the speech service returned ${response.status}`)
  }

  const body = await response.json() as { text?: unknown, error?: unknown }
  if (typeof body.error === 'string' && body.error.length > 0) {
    throw new Error('the speech service refused the recording')
  }
  // whisper.cpp puts each segment on its own line, so a recording of two
  // sentences comes back as two lines — and with timestamps enabled it
  // finds more segments, so the same words arrive differently shaped. A
  // dictated message is one paragraph either way. The filler check runs
  // first, because it recognises silence by the lines it came back as.
  const spoken = withoutFiller(typeof body.text === 'string' ? body.text.trim() : '')
  return spoken.replace(/\s*\n\s*/g, ' ').trim()
}

/**
 * Whether whisper.cpp is actually there.
 *
 * The panel asks the health route, and the health route asks this, because
 * a microphone button that cannot work is worse than no button at all: the
 * setting says dictation is wanted, this says it is possible. The answer is
 * held for half a minute so starting the server shows up quickly without
 * every page load knocking on it.
 */
const PROBE_TTL_MS = 30_000
let probedAt = 0
let probeResult = false

export async function speechAvailable (config: Config): Promise<boolean> {
  if (config.speech.provider === 'off') { return false }
  if (Date.now() - probedAt < PROBE_TTL_MS) { return probeResult }

  try {
    const response = await fetch(`${config.speech.url}/`, {
      method: 'GET',
      signal: AbortSignal.timeout(1500)
    })
    probeResult = response.ok
  } catch {
    probeResult = false
  }
  probedAt = Date.now()
  return probeResult
}
