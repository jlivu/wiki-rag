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
  /** Anthropic prompt caching. On by default; off to measure its effect. */
  cachePrompt: boolean
}

/** The index database, the embedding model and the indexer's timings. */
export interface IndexConfig {
  databaseUrl: string
  embedModel: string
  /** Rapid saves of one page collapse into a single job after this long. */
  debounceSeconds: number
  reconcileMinutes: number
  /** Reads page source as an admin. Without it the indexer stays off. */
  wikiApiKey: string
  /** The wiki's own locale, used when a caller does not say. */
  defaultLocale: string
  /** Uploaded files larger than this are listed as skipped, not indexed. */
  maxDocumentBytes: number
  /**
   * Wiki.js's own `pageExtensions` setting. A file ending in one of these
   * is served as a page, not as a file, so it can be neither downloaded nor
   * permission-checked and is left out of the index.
   */
  pageExtensions: string[]
}

/** Reading pictures: OCR is local and free, a description is neither. */
export interface ImageConfig {
  /** Which vision model describes an image, or 'off' for none. */
  describer: 'anthropic' | 'ollama' | 'off'
  describerModel: string
  /** Asset folders whose images are never sent to a model, by path prefix. */
  describeExclude: string[]
  /** Descriptions a day, counted across the service. */
  describeDailyLimit: number
}

/** The MCP server for outside agents. */
export interface McpConfig {
  /** Tool calls per key per minute. */
  rateLimitPerMinute: number
  /** Host header values accepted, against DNS rebinding. */
  allowedHosts: string[]
  /** Origin header values accepted when one is sent. */
  allowedOrigins: string[]
}

export interface Config {
  host: string
  port: number
  logLevel: string
  wikiUrl: string
  /** Where a person opens the wiki, for URLs an agent can cite. */
  wikiPublicUrl: string
  mcp: McpConfig
  llm: LlmConfig
  index: IndexConfig
  images: ImageConfig
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
    wikiPublicUrl: trimSlash(env.WIKI_PUBLIC_URL ?? 'http://127.0.0.1:3080'),
    mcp: {
      rateLimitPerMinute: readInt(env.MCP_RATE_LIMIT_PER_MINUTE, 60),
      allowedHosts: readList(env.MCP_ALLOWED_HOSTS) ?? [
        '127.0.0.1:3080', 'localhost:3080', '[::1]:3080', 'ai:4000', '127.0.0.1:4000', 'localhost:4000'
      ],
      allowedOrigins: readList(env.MCP_ALLOWED_ORIGINS) ?? [
        'http://127.0.0.1:3080', 'http://localhost:3080'
      ]
    },
    llm: {
      provider,
      model: nonEmpty(env.LLM_MODEL) ?? DEFAULT_MODELS[provider],
      apiKey: env.ANTHROPIC_API_KEY ?? '',
      ollamaUrl: trimSlash(env.OLLAMA_URL ?? 'http://host.docker.internal:11434'),
      maxToolSteps: readInt(env.MAX_TOOL_STEPS, 6),
      maxOutputTokens: readInt(env.MAX_OUTPUT_TOKENS, 8192),
      effort: readEffort(env.LLM_EFFORT),
      timeoutMs: readInt(env.LLM_TIMEOUT_MS, 120000),
      cachePrompt: readBool(env.LLM_PROMPT_CACHE, true)
    },
    index: {
      // Matches the ai-db service in dev/containers/docker-compose.ai.yml.
      databaseUrl: env.INDEX_DB_URL ?? 'postgres://wiki_ai:wiki_ai@ai-db:5432/wiki_ai',
      embedModel: nonEmpty(env.EMBED_MODEL) ?? 'nomic-embed-text',
      debounceSeconds: readInt(env.INDEX_DEBOUNCE_SECONDS, 10),
      reconcileMinutes: readInt(env.RECONCILE_MINUTES, 30),
      wikiApiKey: env.WIKI_API_KEY ?? '',
      defaultLocale: nonEmpty(env.WIKI_LOCALE) ?? 'en',
      maxDocumentBytes: readInt(env.MAX_DOCUMENT_MB, 25) * 1024 * 1024,
      pageExtensions: (readList(env.WIKI_PAGE_EXTENSIONS) ?? ['md', 'html', 'txt'])
        .map(ext => ext.replace(/^\./, '').toLowerCase())
    },
    images: {
      describer: readDescriber(env.IMAGE_DESCRIBER, provider),
      describerModel: nonEmpty(env.IMAGE_DESCRIBER_MODEL) ??
        (readDescriber(env.IMAGE_DESCRIBER, provider) === 'ollama' ? 'qwen3.5' : 'claude-haiku-5-5'),
      describeExclude: (readList(env.IMAGE_DESCRIBE_EXCLUDE) ?? [])
        .map(folder => folder.replace(/^\/+|\/+$/g, '').toLowerCase())
        .filter(folder => folder.length > 0),
      describeDailyLimit: readInt(env.IMAGE_DESCRIBE_DAILY_LIMIT, 200)
    }
  }
}

/**
 * Which model describes images. Anthropic by default, but only when there
 * is a key for it: with none, descriptions are simply off and the rest of
 * image indexing — the text in the picture, the alt text — carries on.
 */
function readDescriber (
  value: string | undefined,
  provider: ProviderId
): 'anthropic' | 'ollama' | 'off' {
  const name = (value ?? 'anthropic').trim().toLowerCase()
  if (name !== 'anthropic' && name !== 'ollama' && name !== 'off') {
    throw new Error(`IMAGE_DESCRIBER must be anthropic, ollama or off (got "${value}")`)
  }
  // A mock run must not reach for a cloud model it has no key for.
  if (name === 'anthropic' && provider === 'mock' && (process.env.ANTHROPIC_API_KEY ?? '').length === 0) {
    return 'off'
  }
  return name
}

/** Safe to log: it names the settings without revealing any of them. */
export function describeConfig (config: Config): Record<string, unknown> {
  return {
    provider: config.llm.provider,
    model: config.llm.model,
    maxToolSteps: config.llm.maxToolSteps,
    maxOutputTokens: config.llm.maxOutputTokens,
    effort: config.llm.effort,
    promptCache: config.llm.cachePrompt,
    wikiUrl: config.wikiUrl,
    hasApiKey: config.llm.apiKey.length > 0,
    embedModel: config.index.embedModel,
    debounceSeconds: config.index.debounceSeconds,
    reconcileMinutes: config.index.reconcileMinutes,
    hasWikiApiKey: config.index.wikiApiKey.length > 0,
    maxDocumentMb: Math.round(config.index.maxDocumentBytes / (1024 * 1024)),
    imageDescriber: config.images.describer,
    imageDescriberModel: config.images.describer === 'off' ? null : config.images.describerModel,
    imageDescribeExclude: config.images.describeExclude,
    imageDescribeDailyLimit: config.images.describeDailyLimit,
    pageExtensions: config.index.pageExtensions,
    wikiPublicUrl: config.wikiPublicUrl,
    mcpRateLimitPerMinute: config.mcp.rateLimitPerMinute
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

function readList (value: string | undefined): string[] | undefined {
  const items = (value ?? '').split(',').map(item => item.trim()).filter(item => item.length > 0)
  return items.length > 0 ? items : undefined
}

function readBool (value: string | undefined, fallback: boolean): boolean {
  const text = value?.trim().toLowerCase()
  if (text === undefined || text.length === 0) { return fallback }
  return !['0', 'false', 'no', 'off'].includes(text)
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
