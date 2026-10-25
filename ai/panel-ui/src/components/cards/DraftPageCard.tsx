import { useId, useState } from 'react'

import {
  PAGES_PATH, checkPagePath,
  type CreatePageResult, type CreatedPage, type DraftPageArgs
} from '@shared'

import { createdPageFor, rememberCreatedPage } from '../../lib/created-pages'
import { NEW_TAB_LINK, NewTabHint } from '../ExternalLink'
import { DraftIcon } from '../Icons'
import { Card } from './Card'

/**
 * A draft the reader can edit, and then make into a real page.
 *
 * The page is created by the *reader*, with their own Wiki.js login, when
 * they press the button — never by the model, which has no way to reach
 * that route. It is created unpublished, so nothing appears in the wiki
 * until a person has read it and published it themselves.
 *
 * Once created, the card remembers it — in a store of its own, not in the
 * card's arguments, because those come from the model. That is what makes
 * the created state survive a reload and what stops a second press making
 * a second page.
 */
export function DraftPageCard ({ args, locale, signedIn, cardKey }: {
  args: DraftPageArgs
  locale: string
  /** False for a reader who is not logged in: they cannot create pages. */
  signedIn: boolean
  /** Identifies this card, so its created page is found again on reload. */
  cardKey: string
}) {
  const [title, setTitle] = useState(args.title)
  const [path, setPath] = useState(args.path)
  const [body, setBody] = useState(args.body)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<CreatePageResult & { ok: false } | null>(null)
  // Looked up once: a page created earlier in this conversation, before a
  // reload, is still created.
  const [created, setCreated] = useState<CreatedPage | null>(() => createdPageFor(cardKey))
  const id = useId()

  const create = async () => {
    setFailure(null)

    // Say what is wrong while they can still fix it. The service checks
    // the same rules again — this is a courtesy, not the enforcement.
    const checked = checkPagePath(path, locale)
    if (!checked.ok) {
      setFailure({ ok: false, reason: 'path', error: checked.error })
      return
    }

    setBusy(true)
    try {
      const response = await fetch(PAGES_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, path: checked.path, content: body, locale })
      })
      const result = await response.json() as CreatePageResult
      if (result.ok) {
        rememberCreatedPage(cardKey, result.page)
        setCreated(result.page)
      } else {
        setFailure(result)
      }
    } catch {
      setFailure({
        ok: false,
        reason: 'unavailable',
        error: 'The wiki could not be reached. Try again in a moment.'
      })
    } finally {
      setBusy(false)
    }
  }

  if (created) {
    return (
      <Card icon={<DraftIcon />} title="Page created">
        <div className="draft">
          <p className="draft-done">
            <strong>{created.title}</strong> was created at <code>/{created.locale}/{created.path}</code>,
            unpublished and tagged <code>ai-draft</code>. Check it, take the draft note off the top,
            and publish it when you are happy with it.
          </p>
          <a className="draft-create draft-open" href={created.editUrl} {...NEW_TAB_LINK}>
            Open in editor
            <NewTabHint />
          </a>
        </div>
      </Card>
    )
  }

  return (
    <Card icon={<DraftIcon />} title="Draft page">
      <div className="draft">
        <label className="draft-label" htmlFor={`${id}-title`}>Title</label>
        <input
          id={`${id}-title`}
          className="draft-input"
          value={title}
          onChange={event => setTitle(event.target.value)}
          disabled={busy}
        />

        <label className="draft-label" htmlFor={`${id}-path`}>Path</label>
        <input
          id={`${id}-path`}
          className="draft-input draft-mono"
          value={path}
          onChange={event => setPath(event.target.value)}
          spellCheck={false}
          disabled={busy}
        />

        <label className="draft-label" htmlFor={`${id}-body`}>Body (Markdown)</label>
        <textarea
          id={`${id}-body`}
          className="draft-input draft-mono draft-body"
          value={body}
          onChange={event => setBody(event.target.value)}
          rows={8}
          spellCheck={false}
          disabled={busy}
        />

        {failure
          ? (
            <p className="draft-error" role="alert">
              {failure.error}
              {failure.existingUrl
                ? (
                  <>
                    {' '}
                    <a href={failure.existingUrl} {...NEW_TAB_LINK}>
                      Open the page that is there
                      <NewTabHint />
                    </a>
                  </>
                  )
                : null}
            </p>
            )
          : null}

        <button
          className="draft-create"
          type="button"
          onClick={() => { void create() }}
          disabled={!signedIn || busy || title.trim().length === 0 || path.trim().length === 0}
          title={signedIn ? undefined : 'Log in to create pages'}
        >
          {busy ? 'Creating…' : signedIn ? 'Create page' : 'Log in to create pages'}
        </button>

        <p className="draft-note">
          Created unpublished and tagged <code>ai-draft</code>, with a note at the top saying it is a
          draft. Nobody else sees it until you publish it.
        </p>
      </div>
    </Card>
  )
}
