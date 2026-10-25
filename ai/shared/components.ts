/**
 * The answer components the assistant may render, and the page context sent
 * with every question.
 *
 * Shared by the Fastify service and the chat app, so both ends agree on the
 * shape of a tool call. The agent in step 3 reuses this module: if it can
 * produce arguments that pass the readers below, the panel can draw them.
 *
 * No dependencies on purpose. This folder is imported by two separate npm
 * projects (../ and ../panel-ui), which do not share a node_modules.
 */

/* ── the shapes ────────────────────────────────────────────────────── */

/** The wiki page the question was asked from. */
export interface PageContext {
  path: string
  locale: string
  title: string
}

/** A link to a wiki page. The panel opens it in a new browser tab. */
export interface PageLink {
  title: string
  path: string
  locale?: string
}

/** Where an answer came from. */
export interface Source extends PageLink {
  snippet: string
  /** ISO 8601, e.g. 2026-09-14T04:12:00.000Z. */
  updatedAt?: string
  /** Heading path of the section the answer came from. */
  section?: string
  /** Wiki.js's anchor for that section, e.g. "#troubleshooting". */
  anchor?: string
}

export interface SourcesArgs {
  items: Source[]
}

export interface ChecklistStep {
  text: string
  code?: string
}

export interface ChecklistArgs {
  title?: string
  steps: ChecklistStep[]
}

export interface KnownIssueArgs {
  title: string
  symptoms: string[]
  rootCause: string
  fix: string
  affectedVersions: string[]
  source?: PageLink
}

export interface TableArgs {
  title?: string
  columns: string[]
  rows: string[][]
}

export interface DraftPageArgs {
  title: string
  path: string
  /** Markdown. */
  body: string
}

/**
 * The only tool names the panel can draw. A tool call with any other name is
 * ignored, so the agent cannot make the panel render something unplanned.
 */
export const PANEL_TOOL_NAMES = ['sources', 'checklist', 'known_issue', 'table', 'draft_page'] as const

export type PanelToolName = (typeof PANEL_TOOL_NAMES)[number]

export function isPanelToolName (name: string): name is PanelToolName {
  return (PANEL_TOOL_NAMES as readonly string[]).includes(name)
}

/** Tool name to argument type, so the agent side cannot mix them up. */
export interface PanelToolArgs {
  sources: SourcesArgs
  checklist: ChecklistArgs
  known_issue: KnownIssueArgs
  table: TableArgs
  draft_page: DraftPageArgs
}

/** A checked component, ready to render. */
export type PanelComponent = {
  [K in PanelToolName]: { name: K, args: PanelToolArgs[K] }
}[PanelToolName]

export type PanelComponentResult =
  | { ok: true, component: PanelComponent }
  | { ok: false, error: string }

/* ── the same shapes, as JSON Schema for a model ───────────────────── */

const PAGE_LINK_PROPERTIES = {
  title: { type: 'string', description: 'The page title, as it appears in the wiki.' },
  path: { type: 'string', description: 'The page path without the locale, e.g. "ops/backup-and-restore".' },
  locale: { type: 'string', description: 'Locale code. Defaults to the current page\'s locale.' }
} as const

/**
 * What the agent is told each component takes. Kept beside the readers above
 * so the two cannot drift: a tool call that satisfies the schema also passes
 * parsePanelComponent.
 */
export const PANEL_TOOL_SCHEMAS: Record<PanelToolName, Record<string, unknown>> = {
  sources: {
    type: 'object',
    description: 'Lists the wiki pages an answer came from.',
    properties: {
      items: {
        type: 'array',
        minItems: 1,
        description: 'One entry per page actually used, most relevant first.',
        items: {
          type: 'object',
          properties: {
            ...PAGE_LINK_PROPERTIES,
            snippet: { type: 'string', description: 'A sentence or two from the page showing why it is relevant. Quote the page; do not invent it.' },
            updatedAt: { type: 'string', description: 'When the page was last updated, ISO 8601, if known.' },
            section: { type: 'string', description: 'Heading path of the section used, e.g. "Procedure › 5. Verify".' },
            anchor: { type: 'string', description: 'Wiki.js anchor for that section, e.g. "#troubleshooting".' }
          },
          required: ['title', 'path', 'snippet'],
          additionalProperties: false
        }
      }
    },
    required: ['items'],
    additionalProperties: false
  },
  checklist: {
    type: 'object',
    description: 'A procedure as numbered steps. Use it whenever the answer is "do this, then this".',
    properties: {
      title: { type: 'string', description: 'What the procedure achieves.' },
      steps: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'One step. Markdown emphasis is allowed.' },
            code: { type: 'string', description: 'A command or snippet for this step, copied exactly from the page.' }
          },
          required: ['text'],
          additionalProperties: false
        }
      }
    },
    required: ['steps'],
    additionalProperties: false
  },
  known_issue: {
    type: 'object',
    description: 'A known error and its fix. Use it when the question names an error, a code or a failure.',
    properties: {
      title: { type: 'string', description: 'The error, as the reader would recognise it.' },
      symptoms: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'What the reader sees.' },
      rootCause: { type: 'string', description: 'Why it happens, according to the wiki.' },
      fix: { type: 'string', description: 'What to do about it.' },
      affectedVersions: { type: 'array', items: { type: 'string' }, description: 'Versions or environments affected, if the page says.' },
      source: {
        type: 'object',
        description: 'The page this came from.',
        properties: PAGE_LINK_PROPERTIES,
        required: ['title', 'path'],
        additionalProperties: false
      }
    },
    required: ['title', 'symptoms', 'rootCause', 'fix'],
    additionalProperties: false
  },
  table: {
    type: 'object',
    description: 'A comparison or a short set of facts in rows and columns.',
    properties: {
      title: { type: 'string' },
      columns: { type: 'array', minItems: 1, items: { type: 'string' } },
      rows: {
        type: 'array',
        items: { type: 'array', items: { type: 'string' } },
        description: 'One array of cells per row, in the same order as the columns.'
      }
    },
    required: ['columns', 'rows'],
    additionalProperties: false
  },
  draft_page: {
    type: 'object',
    description: 'A draft of a page that does not exist yet. Offer it when the wiki has no answer.',
    properties: {
      title: { type: 'string' },
      path: { type: 'string', description: 'A suggested path without the locale, lower case with hyphens.' },
      body: { type: 'string', description: 'The page body in Markdown.' }
    },
    required: ['title', 'path', 'body'],
    additionalProperties: false
  }
}

/* ── reading one tool call ─────────────────────────────────────────── */

/** Check a tool call against its shape before anything is drawn. */
export function parsePanelComponent (name: string, args: unknown): PanelComponentResult {
  if (!isPanelToolName(name)) {
    return { ok: false, error: `Unknown component "${name}"` }
  }
  try {
    switch (name) {
      case 'sources':
        return { ok: true, component: { name, args: readSources(args) } }
      case 'checklist':
        return { ok: true, component: { name, args: readChecklist(args) } }
      case 'known_issue':
        return { ok: true, component: { name, args: readKnownIssue(args) } }
      case 'table':
        return { ok: true, component: { name, args: readTable(args) } }
      case 'draft_page':
        return { ok: true, component: { name, args: readDraftPage(args) } }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'the arguments do not match'
    return { ok: false, error: `Invalid "${name}" arguments: ${reason}` }
  }
}

export function readPageContext (value: unknown): PageContext {
  const page = obj(value, 'page')
  return {
    path: str(page.path, 'page.path'),
    locale: str(page.locale, 'page.locale'),
    title: str(page.title, 'page.title')
  }
}

function readSources (value: unknown): SourcesArgs {
  const args = obj(value, 'sources')
  return {
    items: list(args.items, 'sources.items', readSource, 1)
  }
}

function readSource (value: unknown, path: string): Source {
  const item = obj(value, path)
  return {
    ...readPageLink(item, path),
    snippet: str(item.snippet, `${path}.snippet`),
    ...optional('updatedAt', optStr(item.updatedAt, `${path}.updatedAt`)),
    ...optional('section', optStr(item.section, `${path}.section`)),
    ...optional('anchor', optStr(item.anchor, `${path}.anchor`))
  }
}

function readPageLink (item: Record<string, unknown>, path: string): PageLink {
  return {
    title: str(item.title, `${path}.title`),
    path: str(item.path, `${path}.path`),
    ...optional('locale', optStr(item.locale, `${path}.locale`))
  }
}

function readChecklist (value: unknown): ChecklistArgs {
  const args = obj(value, 'checklist')
  return {
    ...optional('title', optStr(args.title, 'checklist.title')),
    steps: list(args.steps, 'checklist.steps', (step, path) => {
      const entry = obj(step, path)
      return {
        text: str(entry.text, `${path}.text`),
        ...optional('code', optStr(entry.code, `${path}.code`))
      }
    }, 1)
  }
}

function readKnownIssue (value: unknown): KnownIssueArgs {
  const args = obj(value, 'known_issue')
  const source = args.source === undefined || args.source === null
    ? undefined
    : readPageLink(obj(args.source, 'known_issue.source'), 'known_issue.source')
  return {
    title: str(args.title, 'known_issue.title'),
    symptoms: list(args.symptoms, 'known_issue.symptoms', str, 1),
    rootCause: str(args.rootCause, 'known_issue.rootCause'),
    fix: str(args.fix, 'known_issue.fix'),
    affectedVersions: args.affectedVersions === undefined
      ? []
      : list(args.affectedVersions, 'known_issue.affectedVersions', str),
    ...optional('source', source)
  }
}

function readTable (value: unknown): TableArgs {
  const args = obj(value, 'table')
  return {
    ...optional('title', optStr(args.title, 'table.title')),
    columns: list(args.columns, 'table.columns', str, 1),
    rows: list(args.rows, 'table.rows', (row, path) => list(row, path, str))
  }
}

function readDraftPage (value: unknown): DraftPageArgs {
  const args = obj(value, 'draft_page')
  return {
    title: str(args.title, 'draft_page.title'),
    path: str(args.path, 'draft_page.path'),
    body: str(args.body, 'draft_page.body')
  }
}

/* ── the few readers everything above is built from ────────────────── */

function obj (value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function str (value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string`)
  }
  return value
}

function optStr (value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) { return undefined }
  return str(value, path)
}

function list<T> (value: unknown, path: string, read: (item: unknown, path: string) => T, min = 0): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`)
  }
  if (value.length < min) {
    throw new Error(`${path} needs at least ${min} item${min === 1 ? '' : 's'}`)
  }
  return value.map((item, index) => read(item, `${path}[${index}]`))
}

/** Leave an optional field out altogether rather than setting undefined. */
function optional<K extends string, T> (key: K, value: T | undefined): { [P in K]?: T } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: T }
}
