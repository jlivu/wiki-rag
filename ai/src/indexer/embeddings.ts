/**
 * Embeddings from Ollama, running natively on the Mac.
 *
 * The width of a vector is a property of the model, so it is asked for once
 * at startup and recorded; see ensureEmbeddingColumn in index-db/migrate.ts.
 */
export class EmbeddingError extends Error {
  constructor (message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EmbeddingError'
  }
}

export class Embedder {
  readonly model: string
  readonly #url: string
  readonly #timeoutMs: number

  constructor (ollamaUrl: string, model: string, timeoutMs = 120000) {
    this.#url = ollamaUrl.replace(/\/+$/, '')
    this.model = model
    this.#timeoutMs = timeoutMs
  }

  /** One vector per input, in the same order. */
  async embed (inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) { return [] }

    let response: Response
    try {
      response = await fetch(`${this.#url}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: inputs }),
        signal: AbortSignal.timeout(this.#timeoutMs)
      })
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'is unreachable'
      throw new EmbeddingError(`Ollama ${reason} at ${this.#url}`, { cause: err })
    }

    if (!response.ok) {
      const detail = response.status === 404
        ? `Ollama does not have the model "${this.model}". Run: ollama pull ${this.model}`
        : `Ollama returned ${response.status}`
      throw new EmbeddingError(detail)
    }

    const body = await response.json() as { embeddings?: number[][] }
    const embeddings = body.embeddings
    if (!Array.isArray(embeddings) || embeddings.length !== inputs.length) {
      throw new EmbeddingError('Ollama returned an unexpected number of embeddings')
    }
    return embeddings
  }

  /** How wide this model's vectors are. */
  async dimensions (): Promise<number> {
    const [vector] = await this.embed(['dimension probe'])
    if (!vector || vector.length === 0) {
      throw new EmbeddingError(`"${this.model}" returned an empty embedding`)
    }
    return vector.length
  }
}

/** pgvector's text form, which the driver sends as a vector literal. */
export function toVectorLiteral (values: number[]): string {
  return `[${values.join(',')}]`
}
