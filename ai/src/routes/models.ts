/**
 * GET /ai/api/models — the models a reader may pick, and whether each one
 * can answer right now.
 *
 * The list is the server's; the browser only ever sends an id back. A
 * model that is configured but cannot answer — Ollama not running, the
 * model not pulled, no API key — is listed with the reason, because
 * "nothing here" and "not right now" are different answers for someone
 * wondering where their local model went.
 */
import type { FastifyPluginAsync } from 'fastify'

import type { Config } from '../config.js'
import { MODELS_PATH, type ModelAvailability, type ModelsResponse } from '../../shared/index.js'

/** Ollama is asked at most this often, however many readers open the menu. */
const PROBE_TTL_MS = 15_000
const PROBE_TIMEOUT_MS = 2000

interface Probe {
  /** Null when Ollama could not be reached at all. */
  installed: Set<string> | null
  at: number
}

let probe: Probe = { installed: null, at: 0 }

export function modelRoutes (config: Config): FastifyPluginAsync {
  return async (app) => {
    app.get(MODELS_PATH, async (): Promise<ModelsResponse> => {
      return {
        models: await listModels(config),
        defaultId: config.llm.models[0]?.id ?? ''
      }
    })
  }
}

export async function listModels (config: Config): Promise<ModelAvailability[]> {
  const needsOllama = config.llm.models.some(choice => choice.provider === 'ollama')
  const installed = needsOllama ? await installedOllamaModels(config) : null

  return config.llm.models.map(choice => {
    switch (choice.provider) {
      case 'anthropic':
        return config.llm.apiKey.length > 0
          ? { ...choice, available: true, reason: '' }
          : { ...choice, available: false, reason: 'No API key on the server' }
      case 'ollama':
        if (installed === null) {
          return { ...choice, available: false, reason: 'Ollama is not running on this Mac' }
        }
        return installed.has(normaliseTag(choice.model))
          ? { ...choice, available: true, reason: '' }
          : { ...choice, available: false, reason: `Not downloaded — run: ollama pull ${choice.model}` }
      default:
        return { ...choice, available: true, reason: '' }
    }
  })
}

/**
 * What Ollama has, by tag. Null means Ollama did not answer, which is a
 * different thing from having no models.
 */
async function installedOllamaModels (config: Config): Promise<Set<string> | null> {
  if (Date.now() - probe.at < PROBE_TTL_MS) { return probe.installed }

  let installed: Set<string> | null = null
  try {
    const response = await fetch(`${config.llm.ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    if (response.ok) {
      const body = await response.json() as { models?: Array<{ name?: unknown }> }
      installed = new Set(
        (body.models ?? [])
          .map(model => (typeof model.name === 'string' ? normaliseTag(model.name) : ''))
          .filter(name => name.length > 0)
      )
    }
  } catch {
    installed = null
  }

  probe = { installed, at: Date.now() }
  return installed
}

/** Ollama writes "qwen3.5:latest" where a setting usually says "qwen3.5". */
function normaliseTag (name: string): string {
  const trimmed = name.trim().toLowerCase()
  return trimmed.endsWith(':latest') ? trimmed.slice(0, -':latest'.length) : trimmed
}
