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
3. A chat assistant that answers from the knowledge base, with generative UI cards (done for step 3a: it answers from live wiki search; the vector index comes in step 3b).
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
  - Header buttons, both 32px with 8px corners: **New chat** and **Close**.
  - Messages the chat app may post to the parent window (same origin only; the panel checks origin and source):
    - `{ type: 'wiki-ai:status', label, online }` updates the header status chip
    - `{ type: 'wiki-ai:unread', count }` sets the launcher badge
    - `{ type: 'wiki-ai:close' }` closes the panel
  - Messages the panel posts into the iframe (target origin is the panel's own origin; the chat app takes one only from `window.parent` on a matching origin):
    - `{ type: 'wiki-ai:new-chat' }` cancels a streaming reply, clears the conversation and thread ID from sessionStorage, shows the welcome message again and puts focus in the message box
- Models (decided):
  - Answers come from a switchable provider, starting with the Anthropic API. Default model `claude-sonnet-5-5`; `claude-haiku-5-5` is the cheaper option. `LLM_PROVIDER=ollama` runs a local model instead — Ollama runs natively on the Mac and containers reach it at `http://host.docker.internal:11434`. `LLM_PROVIDER=mock` keeps the canned replies for UI work.
  - Production will run on this Mac. The embeddings for the vector index in step 3b will be generated locally with Ollama, so only the answering model is a cloud cost.
  - Settings live in `ai/.env` (gitignored, loaded through `env_file`); `ai/.env.example` lists them with no values. The API key is never logged, never returned by a route and never sent to the browser.
- AI service (step 3a done; answers from live wiki search):
  - `ai/` — Node 22, TypeScript, Fastify, `tsx watch` for development. `ai/panel-ui/` is the chat app (React 19, Vite). `ai/shared/` holds the page context and the answer-component shapes both halves use; it has no dependencies on purpose, because the two are separate npm projects with separate `node_modules`. Versions are pinned and both `package-lock.json` files are committed.
  - The proxy passes the path through, so routes keep the `/ai` prefix: `GET /ai/health` returns `{ ok: true }`, `POST /ai/api/agent` streams one run, `/ai/panel/` is the chat app.
  - Protocol: AG-UI 1.0 over SSE, with the project's own packages — `@ag-ui/client` (`HttpAgent`) in the browser, `@ag-ui/core` and `@ag-ui/encoder` on the server. The page the reader is on travels in `forwardedProps.page`. A card is a tool call: the name has to be one of `sources`, `checklist`, `known_issue`, `table`, `draft_page` and the arguments have to pass `parsePanelComponent` in `ai/shared/components.ts`, or the panel ignores it.
  - `ai/src/providers/` is one `ChatProvider` interface with two implementations (Anthropic through the official SDK, Ollama through its OpenAI-compatible API). The rest of the agent does not know which is running. The panel's status chip names it: "Claude Sonnet 5.5 · Cloud", "qwen3.5 · Local", "Mock · Dev", from `GET /ai/health`.
  - `ai/src/agent/wiki-agent.ts` is the loop: ask the model, run the tools it asked for, ask again, up to `MAX_TOOL_STEPS` rounds; the pass after that offers no wiki tools, so the model has to answer with what it has. The system prompt holds it to wiki content and to the five components. Each run logs provider, model, tool calls with timings, and token usage — no page content, no key.
  - Wiki tools (`ai/src/wiki/`) run on the server but always as the reader who asked: the panel is on the wiki's origin, so the browser sends the Wiki.js `jwt` cookie, and the service forwards it as a bearer token. No token means the guest account. `search_wiki` uses `pages.search`; `get_page` reads the **rendered** page over HTTP and converts it to Markdown, because `pages.single`/`singleByPath` need `manage:pages` and `Page.content` needs `read:source` — neither is available to an ordinary reader.
  - Admin > Search Engine has to be **Database - PostgreSQL**, not the default Database - Basic: Basic matches titles, descriptions and paths only, so the agent cannot find a page by what is written in it.
  - `ai/src/agent/mock-agent.ts` is still there as `LLM_PROVIDER=mock`: canned answers by keyword, for UI work with no model calls.
  - `dev/containers/docker-compose.ai.yml` adds the service (`ai:4000`), the chat app's Vite dev server (`panel-ui:5173`) and a Caddy proxy on http://127.0.0.1:3080. Only the proxy publishes a port, and the file does not touch `dev/containers/docker-compose.yml`.
  - In development the proxy sends `/ai/panel*` to Vite, hot reload included (its socket runs over port 3080). In production the Fastify service serves `ai/panel-ui/dist` instead.
  - Two settings have to be set by hand in the wiki; `ai/README.md` has them.
- Indexing (planned): a custom storage module in `server/modules/storage/rag/` whose `created`, `updated`, `deleted` and `renamed` hooks send `{ event, id }` to the AI service without waiting for it. The AI service queues and debounces events, fetches the page through GraphQL, splits it at headings, embeds only changed chunks, and stores them in Postgres with pgvector plus full-text search (hybrid retrieval). A scheduled reconciliation pass handles the initial backfill and any missed events.
- Permissions (done for the tools, planned for the index): every wiki read happens with the asking user's own login token, so Wiki.js decides what they may see; no admin key is used. The vector index in step 3b will be filtered the same way rather than storing access rules.
- Chat UI (done, on mock data): React and TypeScript in the iframe, streaming AG-UI events. Layout and dimensions follow the assistant panel in `docs/design/tanagraon-unified-ui.html`; colours follow Wiki.js, light and dark, from the `theme` query parameter. Assistant text is Markdown with raw HTML off (no `rehype-raw`). Enter sends, Shift+Enter adds a line. Every link — source cards, the known-issue source, and links inside Markdown answers — opens in a new browser tab (`target="_blank"` with `rel="noopener noreferrer"`, a small icon and "(opens in a new tab)" in the accessible name). `index.html` also carries `<base target="_blank">`, so nothing can load inside the panel's iframe. The conversation and its thread ID live in `sessionStorage`, so it survives moving between wiki pages for as long as the tab is open. Answers use a fixed set of components: source cards, SOP checklist, known-issue card, table, draft-page form. A reply is a list of ordered parts (text, card, text, …), not text followed by a pile of cards, because a model writes around its tool calls and the reader has to see them where it put them.
- Open decision: none outstanding on models. Revisit the provider choice if the wiki moves off this Mac.

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
- Never run `yarn` or `npm install` for Wiki.js on the Mac itself. The same goes for `ai/` and `ai/panel-ui/`: install in the container, e.g. `docker exec wiki-ai npm install --package-lock-only`.
- After changing a `package.json` under `ai/`, rebuild with `--renew-anon-volumes`, or the container keeps the `node_modules` volume from the old image and the new dependency is missing.
- Dev ports: proxy 3080, wiki 3002, Adminer 3001, dev database 15432. The AI service (4000) and the chat app's Vite server (5173) listen inside the Docker network only. Host ports already used by other projects: 3000, 5050, 5435, 5438, 6333-6334, 6379, 8001, 8080, 8088, 8089, 8501, 9000-9001, 54322.
- Open the dev wiki at http://127.0.0.1:3080 (through the proxy), so the wiki and the assistant panel share one origin. Port 3002 reaches Wiki.js directly, without `/ai/`. Use 127.0.0.1, not localhost: this keeps the login separate from the installed wiki at localhost:8088.
- Hot reload cannot swap store modules. After changing anything under `client/store/`, do a full reload (Cmd+Shift+R).
- Production image: `docker build -f dev/build/Dockerfile -t <tag> .` (use `docker buildx build --platform linux/amd64` for an x86 server). The source reports version 2.0.0 because official builds stamp the real version; handle this when building the production image.

## Conventions

- Small upstream diffs; new code in new files and folders.
- Conventional commit messages (`feat:`, `fix:`, `dev:`, `docs:`) on `ai-panel`. Show me the changes and let me commit.
- Pin dependency versions. No secrets or credentials in the repository.
- After changing client code, confirm the build compiles before reporting the task done.
