import type { Config, LlmConfig, ProviderId } from '../config.js'
import type { ModelChoice } from '../../shared/index.js'

import { createAnthropicProvider } from './anthropic.js'
import { createOllamaProvider } from './ollama.js'
import { modelChipLabel } from '../../shared/index.js'
import { type ChatProvider } from './types.js'

export * from './types.js'

/**
 * The mock provider has no model behind it; the route runs the canned agent
 * from step 2 instead. Its label is here so the panel's status chip is right.
 */
export const MOCK_LABEL = 'Mock · Dev'

/** One provider for one allowlisted model. Null only for the mock entry. */
export function createProviderFor (llm: LlmConfig, choice: ModelChoice): ChatProvider | null {
  // The provider is built for this model, not for the configured default:
  // every setting but the model name is shared.
  const forModel: LlmConfig = { ...llm, provider: choice.provider as ProviderId, model: choice.model }
  switch (choice.provider) {
    case 'anthropic':
      return createAnthropicProvider(forModel)
    case 'ollama':
      return createOllamaProvider(forModel)
    default:
      return null
  }
}

/**
 * Providers, built once each and kept.
 *
 * A provider holds an HTTP client and no per-run state, so one per model
 * is reused across readers and across runs. A model that cannot be built
 * — Anthropic with no key — fails here and is reported for that run
 * rather than stopping the service from starting.
 */
export class ProviderPool {
  readonly #llm: LlmConfig
  readonly #built = new Map<string, ChatProvider | null>()

  constructor (llm: LlmConfig) {
    this.#llm = llm
  }

  /** The allowlist, in the order the panel lists it. */
  get choices (): ModelChoice[] {
    return this.#llm.models
  }

  get defaultChoice (): ModelChoice {
    return this.#llm.models[0] as ModelChoice
  }

  /** The entry with this id, or undefined — which is how a forged id dies. */
  find (id: string | undefined): ModelChoice | undefined {
    if (id === undefined) { return undefined }
    return this.#llm.models.find(choice => choice.id === id)
  }

  /** Throws a ProviderError if this model cannot be built. */
  get (choice: ModelChoice): ChatProvider | null {
    if (!this.#built.has(choice.id)) {
      this.#built.set(choice.id, createProviderFor(this.#llm, choice))
    }
    return this.#built.get(choice.id) ?? null
  }
}

/** What the panel's header chip shows, without starting a provider. */
export function providerLabel (config: Config): string {
  if (config.llm.provider === 'mock') { return MOCK_LABEL }
  return modelChipLabel(config.llm.models[0] as ModelChoice)
}
