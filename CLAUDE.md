# CLAUDE.md

Project memory for Claude Code. Keep it short and factual, and update it when a decision changes.

## What this repository is

- A fork of Wiki.js (requarks/wiki) that adds an AI assistant to the wiki.
- Work happens on branch `ai-panel`, based on upstream tag `v2.5.315` (the newest tagged 2.x release).
- The installed wiki this will replace runs 2.5.317. Releases 2.5.316 and 2.5.317 are not tagged upstream. They only add a server-side backup feature (`server/core/backup.js`, `server/helpers/zip.js`) and no database migrations. Rebase onto `v2.5.317` once that tag exists.
- Upstream's default branch `scarlett` is the Wiki.js 3.0 rewrite. Never base work on it or merge it.

## Goals

1. A slide-in assistant panel inside Wiki.js (done, see below).
2. A RAG knowledge base built from wiki pages, updated whenever a page is saved.
3. A chat assistant that answers from the knowledge base, with generative UI cards.
4. An MCP server so AI agents can search and read the wiki.

## Architecture decisions

- Wiki.js stays the source of truth. Keep edits to upstream files minimal and put new code in new files.
- The AI layer is a separate service in `ai/`, reached on the same origin under `/ai/` through a reverse proxy, so it could serve a different wiki later.
- Assistant panel (done):
  - `client/components/ai/chat-drawer.vue` (panel and launcher) and `client/store/ai.js` (open state, unread count).
  - Included from `client/themes/default/components/page.vue`. The component registers the `ai` store module itself in `beforeCreate`, so `client/store/index.js` is untouched upstream code.
  - Dimensions follow the Landger design: 400px panel, 64px header row aligned with the Wiki.js header, 50px launcher with 14px corners at bottom right. Colours follow the Wiki.js theme, in light and dark mode.
  - Docks beside the page from 960px wide, slides over it below that, full width on phones. The open state persists per browser tab (sessionStorage).
  - Loads the chat app in an iframe from `window.WIKI_AI_PANEL_URL` (set in Admin > Theme > Head HTML Injection), passing query parameters `path`, `locale`, `title` and `theme`. Shows a placeholder when it is unset.
  - Messages the chat app may post to the parent window (same origin only; the panel checks origin and source):
    - `{ type: 'wiki-ai:status', label, online }` updates the header status chip
    - `{ type: 'wiki-ai:unread', count }` sets the launcher badge
    - `{ type: 'wiki-ai:close' }` closes the panel
- AI service (started):
  - `ai/` — Node 22, TypeScript, Fastify, `tsx watch` for development. Versions are pinned and `ai/package-lock.json` is committed.
  - The proxy passes the path through, so routes keep the `/ai` prefix: `GET /ai/health` returns `{ ok: true }`, `GET /ai/panel` serves `ai/public/panel.html` (the plain-HTML stub the panel loads; the React chat app replaces it next).
  - `dev/containers/docker-compose.ai.yml` adds the service (`ai:4000`, Docker network only) and a Caddy proxy on http://127.0.0.1:3080 that sends `/ai/*` to it and everything else to `wiki-app:3000`. It does not touch `dev/containers/docker-compose.yml`.
  - Two settings have to be set by hand in the wiki; `ai/README.md` has them.
- Indexing (planned): a custom storage module in `server/modules/storage/rag/` whose `created`, `updated`, `deleted` and `renamed` hooks send `{ event, id }` to the AI service without waiting for it. The AI service queues and debounces events, fetches the page through GraphQL, splits it at headings, embeds only changed chunks, and stores them in Postgres with pgvector plus full-text search (hybrid retrieval). A scheduled reconciliation pass handles the initial backfill and any missed events.
- Permissions (planned): check each retrieved page against Wiki.js GraphQL using the asking user's own login token, instead of storing access rules in the index.
- Chat UI (planned): React and TypeScript inside the iframe, streaming AG-UI-style events. Answers use a fixed set of UI components: source cards, SOP checklist, known-issue card, table, draft-page form.
- Open decision: local models (Ollama) or a cloud API. Ask before writing any model-provider code.

## Wiki.js 2.x codebase notes

- Client: Vue 2.6, Vuetify 2.3, Vuex 3 with vuex-pathify (`get` and `sync`; mutations are named `SET_<FIELD>`).
- Templates are Pug (`<template lang='pug'>`). Styles are SCSS with a global `mc('<colour>', '<shade>')` helper. Dark mode uses `.theme--dark`, with `mc('grey', '900')` as the base.
- Key files: `client/themes/default/components/page.vue` (page view), `client/components/editor.vue`, `client/components/common/nav-header.vue` (header shared by every mode), `client/store/`.
- Every page view is a full server render. There is no client-side navigation between pages.
- Server: Node.js and Express, GraphQL at `/graphql`, modules in `server/modules/<type>/<name>/` (`definition.yml` plus code).
- Licence: AGPL-3.0. Keep this fork's source available to the wiki's users.

## Development environment (macOS, Apple Silicon, zsh)

- Everything runs in Docker. Start with:
  `docker compose -f dev/containers/docker-compose.yml -f dev/containers/docker-compose.ai.yml up -d`
  (the second file is the AI service and the proxy; leave it out for the wiki on its own)
- Install dependencies on the first run and after `docker compose down`: `docker exec wiki-app yarn`
- Run the dev server in the background with a readable log:
  `docker exec -d wiki-app sh -c 'yarn dev > /tmp/yarn-dev.log 2>&1'`
- Check the build: `docker exec wiki-app sh -c "grep -nE 'Compiled|ERROR|Failed' /tmp/yarn-dev.log | tail -n 20"`
- Never run `yarn` or `npm install` for Wiki.js on the Mac itself.
- Dev ports: proxy 3080, wiki 3002, Adminer 3001, dev database 15432. The AI service listens on 4000 inside the Docker network only. Host ports already used by other projects: 3000, 5050, 5435, 5438, 6333-6334, 6379, 8001, 8080, 8088, 8089, 8501, 9000-9001, 54322.
- Open the dev wiki at http://127.0.0.1:3080 (through the proxy), so the wiki and the assistant panel share one origin. Port 3002 reaches Wiki.js directly, without `/ai/`. Use 127.0.0.1, not localhost: this keeps the login separate from the installed wiki at localhost:8088.
- Hot reload cannot swap store modules. After changing anything under `client/store/`, do a full reload (Cmd+Shift+R).
- Production image: `docker build -f dev/build/Dockerfile -t <tag> .` (use `docker buildx build --platform linux/amd64` for an x86 server). The source reports version 2.0.0 because official builds stamp the real version; handle this when building the production image.

## Conventions

- Small upstream diffs; new code in new files and folders.
- Conventional commit messages (`feat:`, `fix:`, `dev:`, `docs:`) on `ai-panel`. Show me the changes and let me commit.
- Pin dependency versions. No secrets or credentials in the repository.
- After changing client code, confirm the build compiles before reporting the task done.
