import {
  MODELS_PATH, isEffortLevel,
  type EffortLevel, type ModelAvailability, type ModelsResponse
} from '@shared'

/**
 * Which model answers.
 *
 * The list is the service's; this half only remembers which of them the
 * reader picked. localStorage rather than sessionStorage, because a
 * preference should outlive the tab — the conversation does not, but the
 * choice of model does.
 */
const CHOICE_KEY = 'wiki-ai-model'
const EFFORT_KEY = 'wiki-ai-effort'

export async function fetchModels (): Promise<ModelsResponse> {
  const response = await fetch(MODELS_PATH, { headers: { accept: 'application/json' } })
  if (!response.ok) { throw new Error(`the model list returned ${response.status}`) }
  const body = await response.json() as Partial<ModelsResponse>
  return {
    models: Array.isArray(body.models) ? body.models : [],
    defaultId: typeof body.defaultId === 'string' ? body.defaultId : ''
  }
}

export function rememberedModel (): string | null {
  try {
    const id = window.localStorage.getItem(CHOICE_KEY)
    return id && id.length > 0 ? id : null
  } catch {
    // Private mode: the reader simply gets the default each time.
    return null
  }
}

export function rememberModel (id: string): void {
  try {
    window.localStorage.setItem(CHOICE_KEY, id)
  } catch {
    // Not worth interrupting the chat for.
  }
}

/**
 * The effort is remembered per model, because the levels are not the
 * same from one to the next: "high" on a local model means thinking is
 * on, and carrying that across to Sonnet would silently change what the
 * reader is paying for.
 */
export function rememberedEffort (modelId: string): EffortLevel | null {
  try {
    const raw = window.localStorage.getItem(EFFORT_KEY)
    if (!raw) { return null }
    const byModel = JSON.parse(raw) as Record<string, unknown>
    const level = byModel[modelId]
    return isEffortLevel(level) ? level : null
  } catch {
    return null
  }
}

export function rememberEffort (modelId: string, effort: EffortLevel): void {
  try {
    const raw = window.localStorage.getItem(EFFORT_KEY)
    const byModel = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    window.localStorage.setItem(EFFORT_KEY, JSON.stringify({ ...byModel, [modelId]: effort }))
  } catch {
    // Not worth interrupting the chat for.
  }
}

/** The level to run at: what was remembered, if the model still has it. */
export function resolveEffort (
  model: ModelAvailability | undefined,
  remembered: EffortLevel | null
): EffortLevel | null {
  if (!model || model.efforts.length === 0) { return null }
  const wanted = model.efforts.find(level => level.id === remembered)
  return wanted?.id ?? model.defaultEffort ?? model.efforts[0]?.id ?? null
}

/**
 * The id to run with.
 *
 * A remembered choice is only honoured while it is still on the server's
 * list and can still answer: a model dropped from MODELS, or a local one
 * with Ollama switched off, falls back to the default rather than
 * failing every question until someone notices.
 */
export function resolveChoice (
  models: ModelAvailability[],
  defaultId: string,
  remembered: string | null
): string {
  const wanted = models.find(model => model.id === remembered)
  if (wanted?.available === true) { return wanted.id }
  const fallback = models.find(model => model.id === defaultId) ?? models.find(model => model.available)
  return fallback?.id ?? defaultId
}
