/**
 * Creating a page, as whoever asked for it.
 *
 * One implementation for both callers: an agent through MCP, which may
 * only write under `drafts/`, and a person pressing the button on a draft
 * card, who may choose the path. Neither gets any authority of its own —
 * the mutation runs with the caller's own Wiki.js token, so Wiki.js
 * decides whether they may write there, exactly as it would in the editor.
 */
import {
  AI_DRAFT_TAG, checkPagePath, editorUrl, withDraftNote,
  type CreatePageResult, type CreatedPage
} from '../../shared/index.js'

import { WikiClient, WikiError } from './client.js'

/**
 * Every field `pages.create` declares. An omitted one is written as a
 * default, which is how a page quietly ends up untitled or published.
 */
const CREATE_MUTATION = `
  mutation AiCreatePage(
    $content: String!, $description: String!, $editor: String!, $isPublished: Boolean!,
    $isPrivate: Boolean!, $locale: String!, $path: String!, $tags: [String]!, $title: String!,
    $scriptCss: String, $scriptJs: String, $publishStartDate: Date, $publishEndDate: Date
  ) {
    pages {
      create(
        content: $content, description: $description, editor: $editor,
        isPublished: $isPublished, isPrivate: $isPrivate, locale: $locale, path: $path,
        tags: $tags, title: $title, scriptCss: $scriptCss, scriptJs: $scriptJs,
        publishStartDate: $publishStartDate, publishEndDate: $publishEndDate
      ) {
        responseResult { succeeded errorCode slug message }
        # Never select page { locale }: a page that has just been created
        # carries localeCode, and selecting the non-nullable Page.locale
        # errors *after* the page has already been written.
        page { id path }
      }
    }
  }
`

export interface CreatePageInput {
  title: string
  path: string
  content: string
  description?: string
  locale: string
}

export interface CreatePageOptions {
  /** Where a person opens the wiki, for the links handed back. */
  publicUrl: string
  /** What to call the caller when the wiki refuses them. */
  who: 'reader' | 'key'
}

export async function createPage (
  client: WikiClient,
  input: CreatePageInput,
  options: CreatePageOptions
): Promise<CreatePageResult> {
  const title = input.title.trim()
  if (title.length === 0) {
    return { ok: false, reason: 'failed', error: 'Give the page a title.' }
  }
  if (input.content.trim().length === 0) {
    return { ok: false, reason: 'failed', error: 'The page has no content.' }
  }

  // The browser checked this too; it is checked again because a browser is
  // not where a rule is enforced.
  const checked = checkPagePath(input.path, input.locale)
  if (!checked.ok) {
    return { ok: false, reason: 'path', error: checked.error }
  }
  const path = checked.path

  try {
    const data = await client.graphql<{
      pages: {
        create: {
          responseResult: { succeeded: boolean, errorCode: number, slug: string, message: string }
          page: { id: number, path: string } | null
        }
      }
    }>(CREATE_MUTATION, {
      content: withDraftNote(input.content),
      description: (input.description ?? '').trim() || `Draft: ${title}`,
      editor: 'markdown',
      // A draft is never published by the assistant. A person publishes it.
      isPublished: false,
      isPrivate: false,
      locale: input.locale,
      path,
      tags: [AI_DRAFT_TAG],
      title,
      scriptCss: '',
      scriptJs: '',
      publishStartDate: '',
      publishEndDate: ''
    })

    const result = data.pages.create
    if (!result.responseResult.succeeded || !result.page) {
      return refusal(result.responseResult.errorCode, result.responseResult.message, {
        publicUrl: options.publicUrl,
        locale: input.locale,
        path,
        who: options.who
      })
    }

    return { ok: true, page: describe(result.page.id, title, result.page.path, input.locale, options.publicUrl) }
  } catch (err) {
    if (err instanceof WikiError) {
      if (err.status === 503) {
        return { ok: false, reason: 'unavailable', error: 'The wiki is not responding. Try again in a moment.' }
      }
      return refusal(err.status === 403 ? 6009 : 0, err.message, {
        publicUrl: options.publicUrl,
        locale: input.locale,
        path,
        who: options.who
      })
    }
    throw err
  }
}

function describe (
  id: number,
  title: string,
  path: string,
  locale: string,
  publicUrl: string
): CreatedPage {
  const base = publicUrl.replace(/\/+$/, '')
  return {
    id,
    title,
    path,
    locale,
    editUrl: editorUrl(base, locale, path),
    viewUrl: `${base}/${locale}/${path}`
  }
}

/**
 * Wiki.js's error codes, turned into something worth reading.
 * 6002 duplicate, 6005 illegal path, 6009/6010 not allowed
 * (server/helpers/error.js).
 */
function refusal (
  code: number,
  message: string,
  context: { publicUrl: string, locale: string, path: string, who: 'reader' | 'key' }
): CreatePageResult {
  const base = context.publicUrl.replace(/\/+$/, '')
  const where = `${base}/${context.locale}/${context.path}`

  if (code === 6002 || /already exists/i.test(message)) {
    return {
      ok: false,
      reason: 'exists',
      error: 'A page already exists at that path. Change the path, or edit the page that is there.',
      existingUrl: where
    }
  }
  if (code === 6005 || /illegal characters/i.test(message)) {
    return { ok: false, reason: 'path', error: 'The wiki will not accept that path.' }
  }
  if (code === 6009 || code === 6010 || /not authorized|forbidden|unauthorized/i.test(message)) {
    return {
      ok: false,
      reason: 'forbidden',
      error: context.who === 'reader'
        ? 'Your account is not allowed to create a page at that path. Try a different path, or ask an administrator.'
        : 'This key is not allowed to create pages there. It needs write:pages on that path.'
    }
  }
  return { ok: false, reason: 'failed', error: `The wiki refused to create the page: ${message}` }
}
