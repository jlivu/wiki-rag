/**
 * Every setting comes from the environment, which docker compose loads from
 * ai/.env. See ai/.env.example for the full list.
 *
 * The API key is read here and passed to the provider. It is never logged,
 * never returned by a route and never sent to the browser.
 */

export type ProviderId = 'anthropic' | 'ollama' | 'mock'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface LlmConfig {
  provider: ProviderId
  model: string
  apiKey: string
  ollamaUrl: string
  maxToolSteps: number
  maxOutputTokens: number
  effort: Effort
  timeoutMs: number
}

export interface Config {
  host: string
  port: number
  logLevel: string
  wikiUrl: string
  llm: LlmConfig
}

const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: 'claude-sonnet-5-5',
  ollama: 'qwen3.5',
  mock: 'mock'
}

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export function loadConfig (env: NodeJS.ProcessEnv = process.env): Config {
  const provider = readProvider(env.LLM_PROVIDER)
  return {
    host: env.HOST ?? '0.0.0.0',
    port: readInt(env.PORT, 4000),
    logLevel: env.LOG_LEVEL ?? 'info',
    wikiUrl: trimSlash(env.WIKI_URL ?? 'http://wiki-app:3000'),
    llm: {
      provider,
      model: nonEmpty(env.LLM_MODEL) ?? DEFAULT_MODELS[provider],
      apiKey: env.ANTHROPIC_API_KEY ?? '',
      ollamaUrl: trimSlash(env.OLLAMA_URL ?? 'http://host.docker.internal:11434'),
      maxToolSteps: readInt(env.MAX_TOOL_STEPS, 6),
      maxOutputTokens: readInt(env.MAX_OUTPUT_TOKENS, 8192),
      effort: readEffort(env.LLM_EFFORT),
      timeoutMs: readInt(env.LLM_TIMEOUT_MS, 120000)
    }
  }
}

/** Safe to log: it names the settings without revealing any of them. */
export function describeConfig (config: Config): Record<string, unknown> {
  return {
    provider: config.llm.provider,
    model: config.llm.model,
    maxToolSteps: config.llm.maxToolSteps,
    maxOutputTokens: config.llm.maxOutputTokens,
    effort: config.llm.effort,
    wikiUrl: config.wikiUrl,
    hasApiKey: config.llm.apiKey.length > 0
  }
}

function readProvider (value: string | undefined): ProviderId {
  const name = (value ?? 'mock').trim().toLowerCase()
  if (name === 'anthropic' || name === 'ollama' || name === 'mock') { return name }
  throw new Error(`LLM_PROVIDER must be anthropic, ollama or mock (got "${value}")`)
}

function readEffort (value: string | undefined): Effort {
  const name = (value ?? 'medium').trim().toLowerCase() as Effort
  if (EFFORTS.includes(name)) { return name }
  throw new Error(`LLM_EFFORT must be one of ${EFFORTS.join(', ')} (got "${value}")`)
}

function readInt (value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function nonEmpty (value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

function trimSlash (value: string): string {
  return value.replace(/\/+$/, '')
}
