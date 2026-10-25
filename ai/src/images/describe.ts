/**
 * Asking a model what is in a picture.
 *
 * This is the only part of indexing that sends anything out of the wiki, so
 * it is the part with the rules: the image has already been stripped of its
 * metadata and resized by images/prepare.ts, a folder may be excluded from
 * it altogether, the same picture is never described twice, and there is a
 * daily ceiling. The description is written into the index as a *generated*
 * description and labelled as one wherever it is shown.
 */
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

import type { Config } from '../config.js'
import { ProviderError } from '../providers/types.js'

import type { PreparedImage } from './prepare.js'

export type DescriberId = 'anthropic' | 'ollama' | 'off'

export interface Description {
  text: string
  model: string
  inputTokens: number
  outputTokens: number
  ms: number
}

export interface ImageDescriber {
  readonly id: DescriberId
  readonly model: string
  /** Null when the model answered with nothing usable. */
  describe: (image: PreparedImage) => Promise<Description | null>
}

/**
 * What the model is asked for. It is deliberately narrow: a factual
 * description and the text that is actually legible, with an explicit
 * instruction not to fill gaps — a guess written into the index reads
 * exactly like a fact.
 */
const INSTRUCTION = [
  'Describe this image for a wiki search index, in plain English.',
  '',
  'Write at most four sentences, in two parts:',
  '1. What the image shows — the kind of image (screenshot, photograph, diagram, chart, scan),',
  '   the subject, and the details someone might search for: equipment, model and serial numbers,',
  '   labels, the layout of a diagram.',
  '2. Any text you can read in the image, transcribed exactly.',
  '',
  'Rules: describe only what is visible. Do not guess, do not infer a purpose, and do not add',
  'context you were not given. If text is too small or blurred to read, say so rather than',
  'guessing at it. No preamble, no "this image shows" — start with the content itself.'
].join('\n')

const MAX_OUTPUT_TOKENS = 400

export function createImageDescriber (config: Config): ImageDescriber {
  switch (config.images.describer) {
    case 'anthropic': return anthropicDescriber(config)
    case 'ollama': return ollamaDescriber(config)
    case 'off': return offDescriber()
  }
}

function offDescriber (): ImageDescriber {
  return {
    id: 'off',
    model: 'none',
    describe: async () => null
  }
}

function anthropicDescriber (config: Config): ImageDescriber {
  const client = new Anthropic({
    apiKey: config.llm.apiKey,
    timeout: config.llm.timeoutMs,
    maxRetries: 2
  })
  const model = config.images.describerModel

  return {
    id: 'anthropic',
    model,
    async describe (image: PreparedImage): Promise<Description | null> {
      const startedAt = Date.now()
      try {
        const message = await client.messages.create({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: [{
            role: 'user',
            content: [
              // The image comes first: the instruction then reads as being
              // about the picture above it.
              {
                type: 'image',
                source: { type: 'base64', media_type: image.mediaType, data: image.data.toString('base64') }
              },
              { type: 'text', text: INSTRUCTION }
            ]
          }]
        })

        const text = message.content
          .flatMap(block => (block.type === 'text' ? [block.text] : []))
          .join('\n')
          .trim()

        return text.length === 0
          ? null
          : {
              text,
              model,
              inputTokens: message.usage.input_tokens,
              outputTokens: message.usage.output_tokens,
              ms: Date.now() - startedAt
            }
      } catch (err) {
        throw toProviderError(err)
      }
    }
  }
}

function ollamaDescriber (config: Config): ImageDescriber {
  const client = new OpenAI({
    baseURL: `${config.llm.ollamaUrl.replace(/\/+$/, '')}/v1`,
    apiKey: 'ollama',
    timeout: config.llm.timeoutMs,
    maxRetries: 1
  })
  const model = config.images.describerModel

  return {
    id: 'ollama',
    model,
    async describe (image: PreparedImage): Promise<Description | null> {
      const startedAt = Date.now()
      try {
        const completion = await client.chat.completions.create({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          // Ollama's vision models think by default and will spend the
          // whole budget on reasoning, returning an empty answer.
          reasoning_effort: 'none',
          messages: [{
            role: 'user',
            content: [
              // The data: prefix is required here; bare base64 is refused.
              {
                type: 'image_url',
                image_url: { url: `data:${image.mediaType};base64,${image.data.toString('base64')}` }
              },
              { type: 'text', text: INSTRUCTION }
            ]
          }]
        })

        const text = (completion.choices[0]?.message.content ?? '').trim()
        return text.length === 0
          ? null
          : {
              text,
              model,
              inputTokens: completion.usage?.prompt_tokens ?? 0,
              outputTokens: completion.usage?.completion_tokens ?? 0,
              ms: Date.now() - startedAt
            }
      } catch (err) {
        throw toProviderError(err)
      }
    }
  }
}

/** The same mapping the chat providers use, so the log reads the same. */
function toProviderError (err: unknown): ProviderError {
  if (err instanceof ProviderError) { return err }
  if (err instanceof Anthropic.AuthenticationError || err instanceof OpenAI.AuthenticationError) {
    return new ProviderError('AUTH', 'The image describer\'s API key was not accepted.', { cause: err })
  }
  if (err instanceof Anthropic.RateLimitError || err instanceof OpenAI.RateLimitError) {
    return new ProviderError('RATE_LIMIT', 'The image describer is rate limited.', { cause: err })
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError || err instanceof OpenAI.APIConnectionTimeoutError) {
    return new ProviderError('TIMEOUT', 'The image describer took too long.', { cause: err })
  }
  if (err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError) {
    return new ProviderError('UNREACHABLE', 'The image describer could not be reached.', { cause: err })
  }
  if (err instanceof OpenAI.NotFoundError) {
    return new ProviderError('NO_MODEL', 'The local vision model is not pulled in Ollama.', { cause: err })
  }
  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) {
    return new ProviderError('API_ERROR', 'The image describer returned an error.', { cause: err })
  }
  return new ProviderError('UNKNOWN', 'The image could not be described.', { cause: err })
}
