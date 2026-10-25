/**
 * When a page is actually visible.
 *
 * `isPublished` is not the whole answer. Wiki.js also honours a publish
 * window, and applies it on every page view:
 *
 *   let pageIsPublished = page.isPublished
 *   if (pageIsPublished && !_.isEmpty(page.publishStartDate)) {
 *     pageIsPublished = moment(page.publishStartDate).isSameOrBefore()
 *   }
 *   if (pageIsPublished && !_.isEmpty(page.publishEndDate)) {
 *     pageIsPublished = moment(page.publishEndDate).isSameOrAfter()
 *   }
 *                                  — server/controllers/common.js:466-473
 *
 * Two things make this worth handling here rather than leaving to the
 * reader-side permission check. Nothing fires an event when a window
 * closes, so the index would go on citing the page for as long as the
 * wiki kept it; and Wiki.js shows an out-of-window page to anyone with
 * write permission, so the permission check would let an editor — or an
 * administrator asking a question — be cited a page the wiki is hiding
 * from everyone else.
 */

export interface PublishWindow {
  /** Null when unset, which is the usual case. */
  start: string | null
  end: string | null
}

/** Wiki.js stores an unset date as an empty string, not as null. */
export function readPublishWindow (page: {
  publishStartDate?: string | null
  publishEndDate?: string | null
}): PublishWindow {
  return { start: asDate(page.publishStartDate), end: asDate(page.publishEndDate) }
}

function asDate (value: string | null | undefined): string | null {
  const text = (value ?? '').trim()
  if (text.length === 0) { return null }
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/** Whether the wiki would show this page to an ordinary reader now. */
export function isVisibleNow (
  page: { isPublished: boolean } & PublishWindow,
  now: Date = new Date()
): boolean {
  if (!page.isPublished) { return false }
  const at = now.getTime()
  if (page.start !== null && Date.parse(page.start) > at) { return false }
  if (page.end !== null && Date.parse(page.end) < at) { return false }
  return true
}

/** Why a page is not visible, for the log and for the document's reason. */
export function hiddenReason (
  page: { isPublished: boolean } & PublishWindow,
  now: Date = new Date()
): string {
  if (!page.isPublished) { return 'unpublished' }
  if (page.start !== null && Date.parse(page.start) > now.getTime()) {
    return `not published until ${page.start}`
  }
  if (page.end !== null && Date.parse(page.end) < now.getTime()) {
    return `publishing ended ${page.end}`
  }
  return 'visible'
}
