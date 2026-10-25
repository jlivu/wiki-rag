/**
 * Forgetting a page, and everything that was written because of it.
 *
 * Most of a page's traces go by themselves: its chunks, the links it had
 * to uploaded files and the alt text it gave images are all keyed to the
 * page row and cascade when it goes.
 *
 * What does not go by itself is text this page has already been *copied
 * into somewhere else*. An image is indexed with the alt text and
 * captions of the pages that show it, so deleting one of those pages
 * leaves its words inside the image's own chunks. Every image the page
 * described is therefore queued to be read again without it.
 *
 * Both ways a page can leave the index come through here — the job that
 * handles a delete event, and the reconciliation pass that notices a
 * page the wiki no longer lists — because a page that leaves unnoticed
 * leaves the same traces as one that leaves with an event.
 */
import type { Pool } from 'pg'

import { documentIdsByPath, imagePathsOnPage, removePage } from '../index-db/store.js'

/** Queue every image this page gives text to. @returns how many. */
export async function requeueImagesOf (
  db: Pool,
  pageId: number,
  requeueDocuments?: (ids: number[]) => Promise<void>
): Promise<number> {
  if (!requeueDocuments) { return 0 }
  const paths = await imagePathsOnPage(db, pageId)
  if (paths.length === 0) { return 0 }
  const ids = await documentIdsByPath(db, paths)
  if (ids.length > 0) { await requeueDocuments(ids) }
  return ids.length
}

/** Take the page out of the index. @returns how many images were queued. */
export async function forgetPage (
  db: Pool,
  pageId: number,
  requeueDocuments?: (ids: number[]) => Promise<void>
): Promise<number> {
  // Before the row goes: once it has, the image text has cascaded away
  // and there is no way left to tell which images this page spoke for.
  const images = await requeueImagesOf(db, pageId, requeueDocuments)
  await removePage(db, pageId)
  return images
}
