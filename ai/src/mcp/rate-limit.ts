/**
 * A fixed window per key, so one agent in a loop cannot flood the wiki.
 */
interface Window {
  count: number
  resetAt: number
}

export class RateLimiter {
  readonly #windows = new Map<string, Window>()
  readonly #limit: number
  readonly #windowMs: number

  constructor (limit: number, windowMs = 60_000) {
    this.#limit = limit
    this.#windowMs = windowMs
  }

  /** Counts the call. Returns how long to wait when the limit is reached. */
  take (key: string): { allowed: boolean, retryAfterSeconds: number, remaining: number } {
    const now = Date.now()
    const window = this.#windows.get(key)

    if (!window || window.resetAt <= now) {
      this.#windows.set(key, { count: 1, resetAt: now + this.#windowMs })
      this.#sweep(now)
      return { allowed: true, retryAfterSeconds: 0, remaining: this.#limit - 1 }
    }

    if (window.count >= this.#limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
        remaining: 0
      }
    }

    window.count += 1
    return { allowed: true, retryAfterSeconds: 0, remaining: this.#limit - window.count }
  }

  #sweep (now: number): void {
    if (this.#windows.size < 500) { return }
    for (const [key, window] of this.#windows) {
      if (window.resetAt <= now) { this.#windows.delete(key) }
    }
  }
}
