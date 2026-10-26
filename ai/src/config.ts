/**
 * Every setting comes from the environment, which docker compose loads from
 * ai/.env. See ai/.env.example for the full list.
 *
 * The API key is read here and passed to the provider. It is never logged,
 * never returned by a route and never sent to the browser.
 */

import { formatAnthropicModel } from './providers/format.js'
import { EFFORT_LEVELS, type EffortChoice, type EffortLevel, type ModelChoice } from '../shared/index.js'

export type ProviderId = 'anthropic' | 'ollama' | 'mock'

export type Effort = EffortLevel

export interface LlmConfig {
  /** The default model's provider, and the mock switch. */
  provider: ProviderId
  /** The default model, which is the first entry in `models`. */
  model: string
  /**
   * Every model a reader may pick, in the order the panel lists them.
   * Never empty, and the first is the default.
   */
  models: ModelChoice[]
  apiKey: string
  ollamaUrl: string
  /**
   * Let a local model think before answering. On, because the models
   * that are any good at tool calling need it: see "Local models" in
   * ai/README.md for what turning it off does to each.
   */
  ollamaThinking: boolean
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

/** Dictation: speech to text, on this machine. */
export interface SpeechConfig {
  /** 'whispercpp' or 'off'. Off hides the microphone in the panel. */
  provider: 'whispercpp' | 'off'
  /** whisper.cpp's server. It runs natively on the Mac, for the GPU. */
  url: string
  language: string
  /** Longest recording accepted, in seconds. */
  maxSeconds: number
  /** Recordings per reader per minute. */
  rateLimitPerMinute: number
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

/**
 * Videos: where they live, how they are read, and what that may cost.
 *
 * Everything here is local except a frame description, which is off by
 * default — a recording is hundreds of frames, and that is a cloud bill
 * rather than a free one.
 */
export interface MediaConfig {
  /** The media folder inside the container. Unmounted means videos are off. */
  directory: string
  /** How often the folder is scanned, as well as watched for changes. */
  scanSeconds: number
  /** A file must stop changing for this long before it is read. */
  settleSeconds: number
  /** Longer than this is recorded as skipped rather than read. */
  maxMinutes: number
  /** Roughly how long one chunk of a video covers. */
  chunkSeconds: number
  /** The audio is transcribed a window at a time; this is the target length. */
  speechWindowSeconds: number
  /** Read the text on screen with Tesseract. */
  ocr: boolean
  /** A frame at least this often, as well as at every scene change. */
  frameSeconds: number
  /** 0–1: how much has to change before a frame counts as a new scene. */
  sceneThreshold: number
  /** Frames read from one video, at most. */
  maxFrames: number
  /** Ask a vision model what a frame shows. Off by default. */
  describe: boolean
  /** Frames of one video described, at most. */
  describeFrameCap: number
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
  speech: SpeechConfig
  media: MediaConfig
}

const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: 'claude-sonnet-5-5',
  ollama: 'qwen3.5',
  mock: 'mock'
}

/**
 * The one-line note under a model's name in the picker.
 *
 * Kept here rather than in MODELS so the setting stays a plain list of
 * model names: this is prose for a reader, not configuration, and it can
 * be reworded without anyone editing an environment file.
 */
const MODEL_NOTES: Record<string, string> = {
  'claude-sonnet-5-5': 'Balanced — the default',
  'claude-haiku-5-5': 'Fastest and cheapest',
  // Measured, not assumed: three times Sonnet's price and twice its
  // time, for the cards Sonnet already draws one level up. See "Is Opus
  // worth it here" in ai/README.md.
  'claude-opus-5-5': 'Three times Sonnet\u2019s price for the same answers here',
  'gemma4:e4b': 'Private, slower — and less reliable'
}

/**
 * How hard each model will work, and what that costs.
 *
 * Anthropic sets this with `output_config.effort`, and every current
 * Claude model takes all five levels (the API's own default is `high`
 * for Sonnet 5.5 and `medium` for Haiku 5.5 — we name ours either way,
 * so the panel and the bill agree).
 *
 * The notes are measured on this wiki's own three test questions, not
 * guessed from a multiplier: see "Effort" in ai/README.md. They say what
 * actually changed, which on a small wiki is mostly "nothing, slower".
 */
const ANTHROPIC_EFFORTS: EffortChoice[] = [
  { id: 'low', label: 'Low', note: 'Quickest; answered all three of our test questions' },
  { id: 'medium', label: 'Medium', note: 'A little fuller than Low, for about 1.2× the cost' },
  { id: 'high', label: 'High', note: 'Adds the troubleshooting table to a how-to answer' },
  { id: 'xhigh', label: 'Extra high', note: 'Fuller again; about 1.7× what Low costs' },
  { id: 'max', label: 'Maximum', note: 'About 4× slower and 5× the cost, no better answer here' }
]

/**
 * Ollama has no effort dial, only thinking on or off, so a local model
 * that can think is offered the two ends and nothing in between. One
 * that cannot gets no row at all.
 */
const OLLAMA_EFFORTS: EffortChoice[] = [
  { id: 'low', label: 'Low', note: 'Thinking off: quicker, but it stops drawing the cards' },
  { id: 'high', label: 'High', note: 'Thinking on, which is the only way it draws them' }
]

/** What the administrator allows, and what they would rather have. */
interface EffortLimits {
  /** EFFORTS, or null for "every level the model supports". */
  allowed: Set<EffortLevel> | null
  /** LLM_EFFORT: the level to start on, where the model has it. */
  preferred: EffortLevel
}

/**
 * EFFORTS narrows the menu; LLM_EFFORT picks the level inside it.
 *
 * Read per call rather than threaded through, because the model list is
 * built once at startup and this keeps `toChoice` to its own job.
 */
function readEffortLimits (env: NodeJS.ProcessEnv): EffortLimits {
  const listed = readList(env.EFFORTS)
  let allowed: Set<EffortLevel> | null = null
  if (listed) {
    for (const name of listed) {
      if (!EFFORT_LEVELS.includes(name.toLowerCase() as EffortLevel)) {
        throw new Error(`EFFORTS must name levels from ${EFFORT_LEVELS.join(', ')} (got "${name}")`)
      }
    }
    allowed = new Set(listed.map(name => name.toLowerCase() as EffortLevel))
  }

  const preferred = readEffort(env.LLM_EFFORT)
  if (allowed && !allowed.has(preferred)) {
    throw new Error(`LLM_EFFORT is "${preferred}", which EFFORTS does not allow`)
  }
  return { allowed, preferred }
}

/**
 * Which levels a model offers, and which it starts on.
 *
 * Three things decide it, in order: what the model can do, what EFFORTS
 * allows, and what LLM_EFFORT asks for. Narrowing to nothing is allowed
 * — the menu then has no Effort row — but the run still needs a level,
 * so the model's own default is kept for the server to use.
 */
function effortsFor (provider: ProviderId, model: string, limits: EffortLimits): {
  efforts: EffortChoice[]
  defaultEffort: EffortLevel | null
} {
  // Every current Claude model takes all five of Anthropic's levels.
  const supported: EffortChoice[] = provider === 'anthropic'
    ? ANTHROPIC_EFFORTS
    : provider === 'ollama' && !OLLAMA_MODELS_WITHOUT_THINKING.includes(model)
      ? OLLAMA_EFFORTS
      : []
  if (supported.length === 0) { return { efforts: [], defaultEffort: null } }

  const own: EffortLevel = provider === 'anthropic' ? 'medium' : 'high'
  const efforts = limits.allowed
    ? supported.filter(level => limits.allowed?.has(level.id) === true)
    : supported

  // The level a reader gets without choosing — and the one the menu
  // marks Recommended, so the badge always names what they would get.
  const settle = (from: EffortChoice[]): EffortLevel =>
    from.some(level => level.id === limits.preferred)
      ? limits.preferred
      : from.some(level => level.id === own)
        ? own
        : from[0]?.id ?? own

  return efforts.length === 0
    // EFFORTS left this model nothing: no choice to offer, and the run
    // falls back to what the model itself would have done.
    ? { efforts: [], defaultEffort: own }
    : { efforts, defaultEffort: settle(efforts) }
}

/**
 * Local models with no thinking control, by name. Ollama reports this
 * per model (`ollama show <model>`), but asking at startup would make
 * the configuration depend on a service that may not be running, so the
 * exceptions are listed instead and everything else is assumed to think.
 */
const OLLAMA_MODELS_WITHOUT_THINKING: readonly string[] = []

const GROUP_NOTES: Record<ProviderId, string> = {
  anthropic: 'Answers in the cloud',
  ollama: 'Private, slower — nothing leaves this Mac',
  mock: 'Canned replies, for working on the panel'
}

/**
 * The picker's list when MODELS is unset.
 *
 * Sonnet is the default and Haiku the cheap one; the local model is here
 * so the choice exists on a machine with Ollama, and shows as
 * unavailable on one without. It is listed knowing it is the weaker
 * option — "Local models" in ai/README.md has the measurements — because
 * a reader who wants nothing to leave the Mac can pick it and switch
 * back in one click. Drop it from MODELS to take it off the menu.
 */
const DEFAULT_MODEL_LIST = [
  'anthropic:claude-sonnet-5-5',
  'anthropic:claude-haiku-5-5',
  'ollama:gemma4:e4b'
]
// claude-opus-5-5 is supported and described in MODEL_NOTES, but is not
// in the list above: it is three times Sonnet's price for no better
// answer on this wiki (see "What effort is worth here" in ai/README.md),
// so an administrator has to ask for it by name in MODELS.

export function loadConfig (env: NodeJS.ProcessEnv = process.env): Config {
  const models = readModels(env)
  // The first entry is the default, and everything that used to read
  // LLM_PROVIDER/LLM_MODEL now follows it, so there is one answer to
  // "which model is this" whether or not MODELS is set.
  const fallback = models[0] as ModelChoice
  const provider = fallback.provider as ProviderId
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
      model: fallback.model,
      models,
      apiKey: env.ANTHROPIC_API_KEY ?? '',
      ollamaUrl: trimSlash(env.OLLAMA_URL ?? 'http://host.docker.internal:11434'),
      ollamaThinking: readBool(env.OLLAMA_THINKING, true),
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
    },
    media: {
      // The container path. docker-compose mounts the Mac's folder here,
      // read-only; see MEDIA_HOST_DIR in the compose files.
      directory: nonEmpty(env.MEDIA_DIR) ?? '/media',
      scanSeconds: readInt(env.MEDIA_SCAN_SECONDS, 30),
      settleSeconds: readInt(env.MEDIA_SETTLE_SECONDS, 20),
      maxMinutes: readInt(env.VIDEO_MAX_MINUTES, 240),
      chunkSeconds: readInt(env.VIDEO_CHUNK_SECONDS, 90),
      speechWindowSeconds: readInt(env.VIDEO_SPEECH_WINDOW_SECONDS, 30),
      ocr: readBool(env.VIDEO_OCR, true),
      frameSeconds: readInt(env.VIDEO_FRAME_SECONDS, 30),
      sceneThreshold: readRatio(env.VIDEO_SCENE_THRESHOLD, 0.3),
      maxFrames: readInt(env.VIDEO_MAX_FRAMES, 400),
      describe: readBool(env.VIDEO_DESCRIBE, false),
      describeFrameCap: readInt(env.VIDEO_DESCRIBE_FRAME_CAP, 6)
    },
    speech: {
      provider: readSpeechProvider(env.STT_PROVIDER),
      // Whisper runs natively on the Mac so it can use the GPU, the same
      // arrangement as Ollama; containers reach it through the host.
      url: trimSlash(env.STT_URL ?? 'http://host.docker.internal:8178'),
      language: nonEmpty(env.STT_LANGUAGE) ?? 'en',
      maxSeconds: readInt(env.STT_MAX_SECONDS, 120),
      rateLimitPerMinute: readInt(env.STT_RATE_LIMIT_PER_MINUTE, 20)
    }
  }
}

/**
 * MODELS: which models a reader may pick, in order, the default first.
 *
 *   MODELS=anthropic:claude-sonnet-5-5,anthropic:claude-haiku-5-5,ollama:qwen3.5
 *
 * Left unset it is the single model LLM_PROVIDER and LLM_MODEL name, so
 * an older ai/.env keeps working and the picker simply has one entry.
 * An explicit LLM_PROVIDER=mock wins over MODELS: that switch exists to
 * work on the panel without calling a model at all, and a list of real
 * models must not quietly undo it.
 */
function readModels (env: NodeJS.ProcessEnv): ModelChoice[] {
  // Only an *explicit* LLM_PROVIDER=mock turns the models off. The
  // setting's own default is mock, and treating that the same would mean
  // a MODELS line was silently ignored whenever LLM_PROVIDER was absent
  // — canned replies in place of the models the administrator listed.
  if ((env.LLM_PROVIDER ?? '').trim().toLowerCase() === 'mock') {
    return [toChoice('mock', 'mock', env)]
  }

  const listed = readList(env.MODELS)
  const chosen = nonEmpty(env.LLM_MODEL)

  // Nothing configured at all is a fresh checkout with no key: canned
  // replies are the only thing that can work.
  if (!listed && !chosen && !nonEmpty(env.LLM_PROVIDER)) {
    return [toChoice('mock', 'mock', env)]
  }

  const provider = readProvider(env.LLM_PROVIDER ?? 'anthropic')
  // MODELS wins outright. Without it, the built-in list with LLM_MODEL
  // moved to the front, since that setting has always named the model
  // that answers and now names the one the panel starts on.
  const entries = listed ?? (
    chosen === undefined
      ? DEFAULT_MODEL_LIST
      : [`${provider}:${chosen}`, ...DEFAULT_MODEL_LIST.filter(entry => entry !== `${provider}:${chosen}`)]
  )
  const models: ModelChoice[] = []
  for (const entry of entries) {
    const at = entry.indexOf(':')
    if (at < 1) {
      throw new Error(`MODELS entries look like provider:model (got "${entry}")`)
    }
    const name = entry.slice(0, at).trim().toLowerCase()
    const model = entry.slice(at + 1).trim()
    if (name !== 'anthropic' && name !== 'ollama') {
      throw new Error(`MODELS can only name anthropic or ollama models (got "${entry}")`)
    }
    if (model.length === 0) {
      throw new Error(`MODELS entry "${entry}" names no model`)
    }
    const choice = toChoice(name, model, env)
    // A duplicate would give the picker two entries with one id.
    if (!models.some(other => other.id === choice.id)) { models.push(choice) }
  }

  if (models.length > 0) { return models }
  return [toChoice(provider, DEFAULT_MODELS[provider], env)]
}

function toChoice (provider: ProviderId, model: string, env: NodeJS.ProcessEnv): ModelChoice {
  return {
    id: `${provider}:${model}`,
    provider,
    model,
    label: provider === 'anthropic' ? formatAnthropicModel(model) : model,
    group: provider === 'anthropic' ? 'Cloud' : provider === 'ollama' ? 'On this Mac' : 'Dev',
    note: MODEL_NOTES[model] ?? GROUP_NOTES[provider],
    ...effortsFor(provider, model, readEffortLimits(env))
  }
}

function readSpeechProvider (value: string | undefined): 'whispercpp' | 'off' {
  const name = (value ?? 'whispercpp').trim().toLowerCase()
  if (name !== 'whispercpp' && name !== 'off') {
    throw new Error(`STT_PROVIDER must be whispercpp or off (got "${value}")`)
  }
  return name
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
    models: config.llm.models.map(choice => choice.id),
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
    speechProvider: config.speech.provider,
    speechUrl: config.speech.provider === 'off' ? null : config.speech.url,
    speechLanguage: config.speech.language,
    speechMaxSeconds: config.speech.maxSeconds,
    mediaDir: config.media.directory,
    mediaScanSeconds: config.media.scanSeconds,
    videoChunkSeconds: config.media.chunkSeconds,
    videoOcr: config.media.ocr,
    videoDescribe: config.media.describe,
    videoMaxMinutes: config.media.maxMinutes,
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
  if (EFFORT_LEVELS.includes(name)) { return name }
  throw new Error(`LLM_EFFORT must be one of ${EFFORT_LEVELS.join(', ')} (got "${value}")`)
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

/** A 0-to-1 setting, such as the scene-change threshold. */
function readRatio (value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '')
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback
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
