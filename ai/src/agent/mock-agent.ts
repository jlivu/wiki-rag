/**
 * The mock agent: canned answers chosen by keyword, streamed as AG-UI events.
 * No model is called. It exists so the panel can be built and reviewed before
 * the retrieval agent lands in step 3, and so every answer component has
 * something to draw.
 */
import { randomUUID } from 'node:crypto'

import {
  EventType,
  PROTOCOL_VERSION,
  contentToText,
  type BaseEvent,
  type Message,
  type RunAgentInput
} from '@ag-ui/core'
import type { PageContext, PanelComponent } from '../../shared/index.js'

interface MockReply {
  text: string
  /** Typed by the shared shapes, so a canned answer cannot drift from them. */
  component?: PanelComponent
}

export interface MockRunOptions {
  input: RunAgentInput
  page?: PageContext
  /** Called for each event, in order. */
  emit: (event: BaseEvent) => void
  /** True once the reader has navigated away or closed the panel. */
  isAborted: () => boolean
  /** Pause between text chunks; 0 turns streaming delays off (tests). */
  chunkDelayMs?: number
}

const DEFAULT_CHUNK_DELAY_MS = 45

export async function runMockAgent (opts: MockRunOptions): Promise<void> {
  const { input, emit, isAborted } = opts
  const delay = opts.chunkDelayMs ?? DEFAULT_CHUNK_DELAY_MS

  emit({
    type: EventType.RUN_STARTED,
    threadId: input.threadId,
    runId: input.runId,
    protocolVersion: PROTOCOL_VERSION
  })

  const reply = chooseReply(lastUserText(input.messages), opts.page)
  const messageId = randomUUID()

  emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' })
  for (const chunk of textChunks(reply.text)) {
    if (isAborted()) { return }
    await sleep(delay)
    emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: chunk })
  }
  emit({ type: EventType.TEXT_MESSAGE_END, messageId })

  const pendingToolCallIds: string[] = []
  if (reply.component && !isAborted()) {
    await sleep(delay * 3)
    const toolCallId = randomUUID()
    pendingToolCallIds.push(toolCallId)
    emit({
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: reply.component.name,
      // The card belongs to the message above it.
      parentMessageId: messageId
    })
    // Sent in pieces, like a model would, so the panel's assembly of
    // partial arguments is exercised too.
    for (const chunk of jsonChunks(JSON.stringify(reply.component.args))) {
      if (isAborted()) { return }
      emit({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: chunk })
    }
    emit({ type: EventType.TOOL_CALL_END, toolCallId })
  }

  emit({
    type: EventType.RUN_FINISHED,
    threadId: input.threadId,
    runId: input.runId,
    outcome: { type: 'success', pendingToolCallIds }
  })
}

/* ── choosing a reply ──────────────────────────────────────────────── */

/**
 * First match wins, so "compare the sources" gives a table. Every component
 * has a keyword, so the whole set can be seen without a model.
 */
export function chooseReply (question: string, page?: PageContext): MockReply {
  const q = question.toLowerCase()

  if (/error\s*3201/.test(q)) { return knownIssueReply() }
  if (/\brestore\b|\brestoring\b/.test(q)) { return checklistReply() }
  if (/\bcompare\b|\bcomparison\b/.test(q)) { return tableReply() }
  if (/\bsources?\b|\bcite\b|\bcitation/.test(q)) { return sourcesReply() }
  if (/\bdraft\b/.test(q)) { return draftReply(page) }
  return fallbackReply(page)
}

function fallbackReply (page?: PageContext): MockReply {
  const title = page?.title?.trim() || 'this page'
  const where = page ? ` (\`/${page.locale}/${page.path}\`)` : ''
  return {
    text: [
      `There is no knowledge base behind me yet — I am the mock agent, so I cannot read **${title}**${where} or anything else in the wiki.`,
      '',
      'Ask me one of these to see what a real answer will look like:',
      '',
      '- **restore** — a numbered checklist',
      '- **error 3201** — a known-issue card',
      '- **compare** — a table',
      '- **sources** — source cards',
      '- **draft** — a draft page form'
    ].join('\n')
  }
}

function checklistReply (): MockReply {
  return {
    text: 'Restoring a page takes five steps. The version history keeps every save, so nothing is lost while you work through them.',
    component: {
      name: 'checklist',
      args: {
        title: 'Restore a page from an earlier version',
        steps: [
          { text: 'Open the page you want to restore and choose **History** from the page actions menu.' },
          { text: 'Pick the version to restore in the left column. The right column stays on the current version so you can read the difference.' },
          { text: 'Check the diff. Removed lines are red, added lines are green. Confirm the version you picked is the one you want.' },
          {
            text: 'If the page will not open at all, confirm the version exists before restoring it:',
            code: 'SELECT "versionDate", "action", "authorName"\nFROM "pageHistory"\nWHERE "pageId" = 42\nORDER BY "versionDate" DESC\nLIMIT 10;'
          },
          { text: 'Select **Restore**, then save. The restore is itself a new version, so you can undo it the same way.' }
        ]
      }
    }
  }
}

function knownIssueReply (): MockReply {
  return {
    text: 'Error 3201 is a known issue. It looks like data loss but is not: the edit is rejected before it is written.',
    component: {
      name: 'known_issue',
      args: {
        title: 'Error 3201 — saving a page fails with a duplicate key error',
        symptoms: [
          'Saving an existing page returns "Error 3201" and the editor stays open.',
          'The server log shows a unique constraint violation on pages_path_locale_unique.',
          'A new page at the same path saves without trouble.'
        ],
        rootCause: 'The page was moved to a new path while a second editor still had the old path open. The second save tries to create a page at a path that another row already holds.',
        fix: 'Close the stale editor and reopen the page from its new path, then reapply the change. If the path is genuinely free, rebuild the page tree from Administration > Utilities so the index matches the pages table.',
        affectedVersions: ['2.5.300 – 2.5.317'],
        source: {
          title: 'Troubleshooting page saves',
          path: 'ops/troubleshooting/page-saves'
        }
      }
    }
  }
}

function tableReply (): MockReply {
  return {
    text: 'Here are the storage targets side by side. Only Git keeps a usable history outside the database.',
    component: {
      name: 'table',
      args: {
        title: 'Storage targets compared',
        columns: ['Target', 'Two-way sync', 'Keeps history', 'Credentials needed'],
        rows: [
          ['Git', 'Yes', 'Yes', 'SSH key or token'],
          ['Local file system', 'Yes', 'No', 'None'],
          ['Amazon S3', 'Push only', 'Versioning only', 'Access key and secret'],
          ['Azure Blob Storage', 'Push only', 'No', 'Connection string']
        ]
      }
    }
  }
}

function sourcesReply (): MockReply {
  return {
    text: 'Three pages cover this. The first is the one to read if you only read one.',
    component: {
      name: 'sources',
      args: {
        items: [
          {
            title: 'Backup and restore',
            path: 'ops/backup-and-restore',
            snippet: 'A nightly dump of the pages table is not a backup on its own. Take the uploads directory in the same window, or restored pages will point at images that no longer exist.',
            updatedAt: '2026-09-14T04:12:00.000Z'
          },
          {
            title: 'Page version history',
            path: 'guides/editing/version-history',
            snippet: 'Every save writes a row to pageHistory, including moves and deletions. The history is kept for as long as the retention setting allows.',
            updatedAt: '2026-07-02T22:40:00.000Z'
          },
          {
            title: 'Troubleshooting page saves',
            path: 'ops/troubleshooting/page-saves',
            snippet: 'Error 3201 and error 3202 both come from the unique constraint on path and locale. Check for a second editor on the same page first.',
            updatedAt: '2026-10-01T01:05:00.000Z'
          }
        ]
      }
    }
  }
}

function draftReply (page?: PageContext): MockReply {
  const locale = page?.locale ?? 'en'
  return {
    text: 'Here is a draft. Edit anything you like — creating the page comes in a later step.',
    component: {
      name: 'draft_page',
      args: {
        title: 'Restoring a page from history',
        path: 'ops/wiki/restoring-a-page',
        body: [
          '# Restoring a page from history',
          '',
          'Every save is kept, so a bad edit can always be undone.',
          '',
          '## Steps',
          '',
          '1. Open the page and choose **History**.',
          '2. Select the version to restore and read the diff.',
          '3. Select **Restore**, then save.',
          '',
          '## Notes',
          '',
          '- A restore is a new version. It can be undone the same way.',
          '- Deleted pages are restored from Administration > Pages instead.',
          '',
          `> Drafted by the assistant from the ${locale} wiki.`
        ].join('\n')
      }
    }
  }
}

/* ── helpers ───────────────────────────────────────────────────────── */

function lastUserText (messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && message.role === 'user') {
      return contentToText(message.content)
    }
  }
  return ''
}

/** Split into small pieces at word boundaries, keeping every character. */
export function textChunks (text: string, target = 18): string[] {
  const pieces = text.match(/\S+\s*|\s+/g) ?? []
  const chunks: string[] = []
  let current = ''
  for (const piece of pieces) {
    current += piece
    if (current.length >= target || piece.includes('\n')) {
      chunks.push(current)
      current = ''
    }
  }
  if (current.length > 0) { chunks.push(current) }
  return chunks
}

/** Tool arguments arrive in pieces too, as they would from a model. */
function jsonChunks (json: string, size = 160): string[] {
  const chunks: string[] = []
  for (let i = 0; i < json.length; i += size) {
    chunks.push(json.slice(i, i + size))
  }
  return chunks.length > 0 ? chunks : ['{}']
}

function sleep (ms: number): Promise<void> {
  if (ms <= 0) { return Promise.resolve() }
  return new Promise(resolve => { setTimeout(resolve, ms) })
}
