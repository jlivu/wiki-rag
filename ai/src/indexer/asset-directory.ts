/**
 * What Wiki.js currently holds, by asset id.
 *
 * Listing assets costs one GraphQL request per folder — there is no query
 * that returns them all — so a burst of uploads shares one walk. The list
 * is only ever a few seconds old, and a job that cannot find its asset
 * forces a fresh walk before concluding the file is gone.
 */
import type { WikiAdminClient, WikiAsset } from '../wiki/admin-client.js'

const TTL_MS = 20_000

export class AssetDirectory {
  readonly #wiki: WikiAdminClient
  readonly #ttlMs: number
  #assets: WikiAsset[] = []
  #fetchedAt = 0
  #inFlight: Promise<WikiAsset[]> | null = null

  constructor (wiki: WikiAdminClient, ttlMs = TTL_MS) {
    this.#wiki = wiki
    this.#ttlMs = ttlMs
  }

  async list (force = false): Promise<WikiAsset[]> {
    if (!force && Date.now() - this.#fetchedAt < this.#ttlMs) { return this.#assets }
    // Several jobs asking at once share one walk.
    this.#inFlight ??= this.#wiki.listAssets()
      .then(assets => {
        this.#assets = assets
        this.#fetchedAt = Date.now()
        return assets
      })
      .finally(() => { this.#inFlight = null })
    return this.#inFlight
  }

  /** The asset, or null once a fresh walk also fails to find it. */
  async find (id: number): Promise<WikiAsset | null> {
    const cached = (await this.list()).find(asset => asset.id === id)
    if (cached) { return cached }
    return (await this.list(true)).find(asset => asset.id === id) ?? null
  }
}
