/**
 * Which model answers.
 *
 * The reader chooses from a list the server publishes; the browser never
 * names a model of its own. An id is `<provider>:<model>` — unique even
 * if two providers ever offer the same model name — and the only thing
 * the browser sends back.
 */

/** The two headings the panel groups the list under. */
export type ModelGroup = 'Cloud' | 'On this Mac' | 'Dev'

/**
 * How hard the model works on one answer.
 *
 * These are Anthropic's five levels, set through `output_config.effort`.
 * A local model has no such dial, so the ones that can think are offered
 * the two ends of the scale and nothing in between; a model with no
 * control at all offers none, and the panel hides the row.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

export function isEffortLevel (value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value)
}

/** One level, as the panel lists it. */
export interface EffortChoice {
  id: EffortLevel
  /** "Medium", "Extra high". */
  label: string
  /** One line under the name, measured rather than guessed. */
  note: string
}

/** One entry in the picker, as the service publishes it. */
export interface ModelChoice {
  /** `<provider>:<model>`, e.g. "anthropic:claude-sonnet-5-5". */
  id: string
  /** anthropic, ollama or mock. */
  provider: string
  /** What the provider is asked for. */
  model: string
  /** What the reader sees, e.g. "Claude Sonnet 5.5". */
  label: string
  group: ModelGroup
  /** One line under the name, e.g. "Fastest and cheapest". */
  note: string
  /** The levels this model supports, in order. Empty means no control. */
  efforts: EffortChoice[]
  /** The level used when the reader has not chosen. Null with no control. */
  defaultEffort: EffortLevel | null
}

/** A choice with whether it can actually answer right now. */
export interface ModelAvailability extends ModelChoice {
  available: boolean
  /** Why not, shown in the menu on a disabled entry. Empty when available. */
  reason: string
}

/** What GET /ai/api/models answers. */
export interface ModelsResponse {
  models: ModelAvailability[]
  /** The id used when the reader has not chosen, always the first entry. */
  defaultId: string
}

/** What the reader picked: a model from the list, and a level it supports. */
export interface ModelSelection {
  modelId: string
  effort: EffortLevel | null
}

/** "Sonnet 5.5 · Medium" — the button under the message box. */
export function selectionLabel (
  choice: Pick<ModelChoice, 'label' | 'efforts'> | undefined,
  effort: EffortLevel | null
): string {
  if (!choice) { return 'Model' }
  // "Claude " is dropped here: the button sits in a 400px panel under the
  // message box, and the menu above it spells the name out in full.
  const name = choice.label.replace(/^Claude /, '')
  const level = choice.efforts.find(entry => entry.id === effort)
  return level ? `${name} · ${level.label}` : name
}

export const MODELS_PATH = '/ai/api/models'

/**
 * The status chip's text: "Sonnet 5.5 · Cloud", "gemma4:e4b · Local".
 *
 * The chip's job is to say which model is answering and whether the
 * question leaves the machine, in the room left beside the title and
 * two buttons — about twenty-five characters. "Claude " is dropped to
 * make space for the part that is not obvious from the name.
 */
export function modelChipLabel (choice: Pick<ModelChoice, 'label' | 'group'>): string {
  const name = choice.label.replace(/^Claude /, '')
  switch (choice.group) {
    case 'On this Mac': return `${name} · Local`
    case 'Dev': return `${name} · Dev`
    default: return `${name} · Cloud`
  }
}
