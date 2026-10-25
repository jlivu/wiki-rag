/**
 * The dictation state machine.
 *
 * Recording, metering and transcribing in one place, so the components
 * only have to draw what it reports. Nothing is ever sent for the reader:
 * the text lands in the message box and they press Send themselves.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { TRANSCRIBE_PATH } from '@shared'

import { createLevelMeter, preferredMimeType, toWav } from './audio'
import {
  constraintsFor, hasPermission, listMicrophones, microphoneError,
  microphonesSupported, rememberMicrophone, rememberedMicrophone, type Microphone
} from './microphones'

export type DictationState = 'idle' | 'recording' | 'transcribing'

/** How often the level is read while a meter is open. */
const LEVEL_INTERVAL_MS = 70

export interface Dictation {
  state: DictationState
  /** 0 to 1, while recording or while the popover's meter is open. */
  level: number
  /** Seconds recorded so far. */
  elapsed: number
  error: string | null
  clearError: () => void
  microphones: Microphone[]
  deviceId: string | null
  chooseMicrophone: (deviceId: string) => void
  /** False until the browser will tell us what the devices are called. */
  permissionGiven: boolean
  /** Ask for permission, so the device names can be shown. */
  requestPermission: () => Promise<void>
  /** The popover's meter, which needs the microphone open to read it. */
  openMeter: () => Promise<void>
  closeMeter: () => void
  start: () => Promise<void>
  stop: () => void
  cancel: () => void
}

export function useDictation (options: {
  maxSeconds: number
  /** Called with the transcribed text, to put in the message box. */
  onText: (text: string) => void
}): Dictation {
  const { maxSeconds, onText } = options

  const [state, setState] = useState<DictationState>('idle')
  const [level, setLevel] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [microphones, setMicrophones] = useState<Microphone[]>([])
  const [deviceId, setDeviceId] = useState<string | null>(() => rememberedMicrophone())
  const [permissionGiven, setPermissionGiven] = useState(false)

  const stream = useRef<MediaStream | null>(null)
  const meter = useRef<{ read: () => number, close: () => void } | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const levelTimer = useRef<number | null>(null)
  const stopTimer = useRef<number | null>(null)
  const startedAt = useRef(0)
  /** Set when the reader cancels, so the recorder's data is thrown away. */
  const cancelled = useRef(false)

  const refresh = useCallback(async () => {
    if (!microphonesSupported()) { return }
    try {
      const found = await listMicrophones()
      setMicrophones(found)
      setPermissionGiven(hasPermission(found))
    } catch {
      // An enumeration that fails is the same as having no list yet.
    }
  }, [])

  useEffect(() => {
    void refresh()
    if (!microphonesSupported() || typeof navigator.mediaDevices.addEventListener !== 'function') { return }
    const onChange = () => { void refresh() }
    navigator.mediaDevices.addEventListener('devicechange', onChange)
    return () => { navigator.mediaDevices.removeEventListener('devicechange', onChange) }
  }, [refresh])

  /** Everything that holds the microphone open, let go of together. */
  const release = useCallback(() => {
    if (levelTimer.current !== null) { window.clearInterval(levelTimer.current); levelTimer.current = null }
    if (stopTimer.current !== null) { window.clearTimeout(stopTimer.current); stopTimer.current = null }
    meter.current?.close()
    meter.current = null
    stream.current?.getTracks().forEach(track => { track.stop() })
    stream.current = null
    recorder.current = null
    setLevel(0)
  }, [])

  useEffect(() => release, [release])

  /** Open the microphone and start reading its level. */
  const openStream = useCallback(async (): Promise<MediaStream> => {
    const open = await navigator.mediaDevices.getUserMedia(constraintsFor(deviceId))
    stream.current = open
    meter.current = createLevelMeter(open)
    levelTimer.current = window.setInterval(() => {
      setLevel(meter.current?.read() ?? 0)
      if (startedAt.current > 0) { setElapsed((Date.now() - startedAt.current) / 1000) }
    }, LEVEL_INTERVAL_MS)

    // Unplugging the device ends its track rather than raising an error.
    for (const track of open.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (recorder.current?.state === 'recording') {
          cancelled.current = true
          recorder.current.stop()
          setError('The microphone was disconnected. Nothing was recorded.')
          setState('idle')
        }
        release()
      })
    }

    // The names arrive with permission, so the list is worth another look.
    void refresh()
    return open
  }, [deviceId, refresh, release])

  const openMeter = useCallback(async () => {
    if (stream.current !== null) { return }
    try {
      await openStream()
    } catch (err) {
      setError(microphoneError(err))
    }
  }, [openStream])

  const closeMeter = useCallback(() => {
    if (state === 'recording') { return }
    release()
  }, [release, state])

  const requestPermission = useCallback(async () => {
    try {
      const open = await navigator.mediaDevices.getUserMedia(constraintsFor(null))
      open.getTracks().forEach(track => { track.stop() })
      setError(null)
      await refresh()
    } catch (err) {
      setError(microphoneError(err))
    }
  }, [refresh])

  const chooseMicrophone = useCallback((id: string) => {
    setDeviceId(id)
    rememberMicrophone(id)
    // The meter, if it is open, has to move to the new device.
    if (state !== 'recording') { release() }
  }, [release, state])

  const transcribe = useCallback(async (recorded: Blob) => {
    setState('transcribing')
    try {
      const { wav } = await toWav(recorded)
      const response = await fetch(TRANSCRIBE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: wav
      })

      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string }
        setError(body.error ?? 'The recording could not be transcribed.')
        return
      }

      const body = await response.json() as { text?: string }
      const text = (body.text ?? '').trim()
      if (text.length === 0) {
        setError('Nothing was heard in that recording.')
        return
      }
      onText(text)
    } catch {
      setError('The recording could not be sent. Type your message instead.')
    } finally {
      setState('idle')
      setElapsed(0)
    }
  }, [onText])

  const start = useCallback(async () => {
    if (state !== 'idle') { return }
    setError(null)
    cancelled.current = false
    chunks.current = []

    let open: MediaStream
    try {
      open = stream.current ?? await openStream()
    } catch (err) {
      setError(microphoneError(err))
      return
    }

    let made: MediaRecorder
    try {
      const mimeType = preferredMimeType()
      made = new MediaRecorder(open, mimeType ? { mimeType } : undefined)
    } catch {
      setError('This browser cannot record audio.')
      release()
      return
    }

    made.addEventListener('dataavailable', event => {
      if (event.data.size > 0) { chunks.current.push(event.data) }
    })
    made.addEventListener('stop', () => {
      const recorded = new Blob(chunks.current, { type: made.mimeType })
      chunks.current = []
      release()
      startedAt.current = 0
      if (cancelled.current || recorded.size === 0) {
        setState('idle')
        setElapsed(0)
        return
      }
      void transcribe(recorded)
    })

    recorder.current = made
    startedAt.current = Date.now()
    setElapsed(0)
    made.start()
    setState('recording')

    // The service refuses anything longer, so stop before it has to.
    stopTimer.current = window.setTimeout(() => {
      if (recorder.current?.state === 'recording') { recorder.current.stop() }
    }, maxSeconds * 1000)
  }, [maxSeconds, openStream, release, state, transcribe])

  const stop = useCallback(() => {
    if (recorder.current?.state === 'recording') { recorder.current.stop() }
  }, [])

  const cancel = useCallback(() => {
    if (recorder.current?.state === 'recording') {
      cancelled.current = true
      recorder.current.stop()
    }
    setState('idle')
    setElapsed(0)
  }, [])

  return {
    state,
    level,
    elapsed,
    error,
    clearError: () => { setError(null) },
    microphones,
    deviceId,
    chooseMicrophone,
    permissionGiven,
    requestPermission,
    openMeter,
    closeMeter,
    start,
    stop,
    cancel
  }
}
