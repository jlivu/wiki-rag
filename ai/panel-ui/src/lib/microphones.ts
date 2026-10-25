/**
 * Which microphone to record from.
 *
 * A browser hides device names until the reader has allowed microphone
 * access once, so an unlabelled list is the signal that permission has not
 * been given yet rather than an error. The chosen device is remembered
 * across visits; if it is gone when they come back, the system default is
 * used without complaint.
 */

const STORAGE_KEY = 'wiki-ai:microphone'

export interface Microphone {
  deviceId: string
  /** What to show: "Default - MacBook Pro Microphone". */
  label: string
  isDefault: boolean
}

export function microphonesSupported (): boolean {
  return typeof navigator !== 'undefined' &&
    navigator.mediaDevices !== undefined &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
}

/**
 * The input devices, system default first. Labels are empty until
 * permission has been given, which the caller uses to explain itself.
 */
export async function listMicrophones (): Promise<Microphone[]> {
  if (!microphonesSupported() || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
    return []
  }

  const devices = await navigator.mediaDevices.enumerateDevices()
  const inputs = devices.filter(device => device.kind === 'audioinput')

  const microphones = inputs.map((device, at) => {
    const isDefault = device.deviceId === 'default' || (inputs.length > 0 && at === 0 && device.deviceId === '')
    const label = device.label.trim()
    return {
      deviceId: device.deviceId,
      label: nameFor(label, isDefault, at),
      isDefault
    }
  })

  // The system default goes first, however the browser ordered them.
  return [...microphones].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
}

function nameFor (label: string, isDefault: boolean, at: number): string {
  if (label.length === 0) {
    return isDefault ? 'Default microphone' : `Microphone ${at + 1}`
  }
  // Chrome already writes "Default - Something"; others do not.
  if (isDefault && !/^default\b/i.test(label)) { return `Default - ${label}` }
  return label
}

/** True once the browser is willing to tell us what the devices are called. */
export function hasPermission (microphones: Microphone[]): boolean {
  return microphones.some(microphone => microphone.label !== 'Default microphone' &&
    !/^Microphone \d+$/.test(microphone.label))
}

export function rememberedMicrophone (): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function rememberMicrophone (deviceId: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, deviceId)
  } catch {
    // Private browsing, or storage turned off: the choice lasts this visit.
  }
}

/** What getUserMedia should be asked for. */
export function constraintsFor (deviceId: string | null): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
  // `exact` would fail outright if the device were unplugged; a plain
  // deviceId lets the browser fall back to the default, which is what
  // someone dictating actually wants.
  if (deviceId !== null && deviceId.length > 0) { audio.deviceId = deviceId }
  return { audio, video: false }
}

/** What went wrong with getUserMedia, in words a reader can act on. */
export function microphoneError (err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'The browser blocked the microphone. Allow it for this site, then try again.'
    case 'NotFoundError':
      return 'No microphone was found. Plug one in, then try again.'
    case 'NotReadableError':
      return 'The microphone could not be opened. Another app may be using it.'
    case 'OverconstrainedError':
      return 'That microphone is no longer available. Choose another one.'
    case 'AbortError':
      return 'The microphone stopped unexpectedly. Try again.'
    default:
      return 'The microphone could not be started.'
  }
}
