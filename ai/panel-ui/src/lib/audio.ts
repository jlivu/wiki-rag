/**
 * Turning what the browser recorded into what the service accepts.
 *
 * Browsers record what they like — Opus in WebM here, AAC in MP4 there —
 * so the conversion to 16 kHz mono WAV happens in the browser, where the
 * audio already is. The service then never needs ffmpeg, and whisper.cpp
 * gets exactly the shape it wants without transcoding.
 */
import { SPEECH_SAMPLE_RATE } from '@shared'

/** The recording formats worth asking for, best first. */
const PREFERRED_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4'
]

/** What MediaRecorder should capture here, or undefined for its default. */
export function preferredMimeType (): string | undefined {
  if (typeof MediaRecorder === 'undefined') { return undefined }
  return PREFERRED_TYPES.find(type => MediaRecorder.isTypeSupported(type))
}

export interface Recording {
  wav: Blob
  seconds: number
}

/** Decode whatever was recorded, mix it to mono at 16 kHz, write a WAV. */
export async function toWav (recorded: Blob): Promise<Recording> {
  const bytes = await recorded.arrayBuffer()

  const context = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await context.decodeAudioData(bytes)
  } finally {
    void context.close()
  }

  const frames = Math.max(1, Math.ceil(decoded.duration * SPEECH_SAMPLE_RATE))
  // Connecting any number of channels to a mono destination mixes them
  // down, and rendering at 16 kHz resamples on the way.
  const offline = new OfflineAudioContext(1, frames, SPEECH_SAMPLE_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()

  const samples = rendered.getChannelData(0)
  return {
    wav: new Blob([encodeWav(samples)], { type: 'audio/wav' }),
    seconds: samples.length / SPEECH_SAMPLE_RATE
  }
}

/** A 44-byte RIFF header and 16-bit PCM, which is all whisper.cpp needs. */
function encodeWav (samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) { view.setUint8(at + i, value.charCodeAt(i)) }
  }

  text(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)                        // PCM
  view.setUint16(22, 1, true)                        // mono
  view.setUint32(24, SPEECH_SAMPLE_RATE, true)
  view.setUint32(28, SPEECH_SAMPLE_RATE * 2, true)   // bytes a second
  view.setUint16(32, 2, true)                        // bytes a frame
  view.setUint16(34, 16, true)                       // bits a sample
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  let at = 44
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(at, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    at += 2
  }

  return buffer
}

/**
 * How loud the microphone is right now, 0 to 1.
 *
 * Root mean square over the waveform, scaled: speech sits around 0.05–0.2
 * RMS, which would barely move a bar drawn linearly.
 */
export function createLevelMeter (stream: MediaStream): {
  read: () => number
  close: () => void
} {
  const context = new AudioContext()
  const source = context.createMediaStreamSource(stream)
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.6
  source.connect(analyser)

  const samples = new Float32Array(analyser.fftSize)

  return {
    read () {
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (const sample of samples) { sum += sample * sample }
      const rms = Math.sqrt(sum / samples.length)
      return Math.max(0, Math.min(1, rms * 4))
    },
    close () {
      source.disconnect()
      analyser.disconnect()
      void context.close()
    }
  }
}
