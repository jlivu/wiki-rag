import type { Config } from '../config.js'

import { createAnthropicProvider } from './anthropic.js'
import { createOllamaProvider } from './ollama.js'
import { formatAnthropicModel, type ChatProvider } from './types.js'

export * from './types.js'

/**
 * The mock provider has no model behind it; the route runs the canned agent
 * from step 2 instead. Its label is here so the panel's status chip is right.
 */
export const MOCK_LABEL = 'Mock · Dev'

export function createProvider (config: Config): ChatProvider | null {
  switch (config.llm.provider) {
    case 'anthropic':
      return createAnthropicProvider(config.llm)
    case 'ollama':
      return createOllamaProvider(config.llm)
    case 'mock':
      return null
  }
}

/** What the panel's header chip shows, without starting a provider. */
export function providerLabel (config: Config): string {
  switch (config.llm.provider) {
    case 'anthropic':
      return `${formatAnthropicModel(config.llm.model)} · Cloud`
    case 'ollama':
      return `${config.llm.model} · Local`
    case 'mock':
      return MOCK_LABEL
  }
}
