# wiki-ai

The AI service behind the wiki's assistant panel, and the chat app the panel
loads. Node 22, TypeScript, Fastify, React and Vite.

```
ai/
  shared/           schemas both halves agree on; no dependencies
  src/              the Fastify service
  panel-ui/         the chat app (React + Vite)
```

A reverse proxy (Caddy) puts everything on one origin,
http://127.0.0.1:3080, and forwards `/ai/*` here with the path unchanged. The
panel's iframe needs that shared origin: it talks to the wiki page around it
with `postMessage`, and both sides check the origin.

| Route           | What it does                                                   |
| --------------- | --------------------------------------------------------------- |
| `/ai/health`    | `{ ok, provider: { id, model, label } }`. The panel's status chip shows the label. |
| `/ai/api/agent` | One AG-UI run, streamed back as server-sent events.               |
| `/ai/panel/`    | The chat app. Vite's dev server in development, the built files in production. |
| `/ai/mcp`       | MCP over Streamable HTTP, for agents outside the wiki.            |

## Start it

From the repository root:

```sh
docker compose -f dev/containers/docker-compose.yml \
               -f dev/containers/docker-compose.ai.yml up -d
```

That starts the database, the wiki container, this service, the chat app's dev
server and the proxy. The wiki's own dev server still has to be started inside
its container:

```sh
docker exec -d wiki-app sh -c 'yarn dev > /tmp/yarn-dev.log 2>&1'
```

Then:

- http://127.0.0.1:3080/ — the wiki
- http://127.0.0.1:3080/ai/health — `{"ok":true}`
- http://127.0.0.1:3080/ai/panel/ — the chat app on its own, outside the panel

Editing anything under `ai/` reloads it: `tsx watch` restarts the service,
Vite hot-reloads the chat app (its socket runs through the proxy on port
3080). Rebuild an image only after changing a `package.json` or a
`Dockerfile`:

```sh
docker compose -f dev/containers/docker-compose.yml \
               -f dev/containers/docker-compose.ai.yml up -d --build --renew-anon-volumes ai panel-ui
```

`--renew-anon-volumes` matters: without it the container keeps the
`node_modules` volume from the previous image and the new dependency is
missing.

Logs: `docker logs -f wiki-ai`, `docker logs -f wiki-panel-ui`.

Type checks: `docker exec wiki-ai npm run typecheck` and
`docker exec wiki-panel-ui npm run typecheck`.

Never run `npm install` for these projects on the Mac itself — do it in the
container, e.g. `docker exec wiki-ai npm install --package-lock-only`, so each
`package-lock.json` stays in step with the pinned versions in its
`package.json`.

## Three settings to set by hand in the wiki

All one-off, in the wiki's admin area at http://127.0.0.1:3080/a.

1. **Admin > Theme > Head HTML Injection** — tells the panel where the chat app
   lives. Without it the panel shows its "Not connected yet" placeholder.

   ```html
   <script>window.WIKI_AI_PANEL_URL = '/ai/panel/'</script>
   ```

   The trailing slash matters: the chat app is a directory of static files.
   (`/ai/panel` works too — the proxy rewrites it, and the service redirects
   it, both keeping the query string.)

2. **Admin > General > Site URL** — `http://127.0.0.1:3080`, so the wiki builds
   its links for the proxy rather than for port 3002.

3. **Admin > Search Engine** — switch from **Database - Basic** to
   **Database - PostgreSQL**, Apply, then **Rebuild Index**. Basic matches
   titles, descriptions and paths only, so the agent cannot find a page by
   what is written in it. See "The search engine matters" below.

## Settings

Everything comes from `ai/.env`, which is gitignored and loaded by
`docker compose` through `env_file`. `ai/.env.example` lists every setting
with no values; copy what you need.

| Setting             | Default                            | What it does |
| ------------------- | ---------------------------------- | ------------ |
| `LLM_PROVIDER`      | `mock`                             | `anthropic`, `ollama` or `mock`. |
| `LLM_MODEL`         | per provider                       | `claude-sonnet-5-5` for Anthropic, `qwen3.5` for Ollama. |
| `ANTHROPIC_API_KEY` | —                                  | Required for `anthropic`. Never logged, never sent to the browser. |
| `OLLAMA_URL`        | `http://host.docker.internal:11434`| Ollama runs natively on the Mac, so containers reach it through the host. |
| `MAX_TOOL_STEPS`    | `6`                                | Rounds of wiki tool calls before the agent has to answer. |
| `MAX_OUTPUT_TOKENS` | `8192`                             | Ceiling for one reply. Thinking counts towards it on current Claude models. |
| `LLM_EFFORT`        | `medium`                           | Anthropic only: `low` to `max`. Higher costs more and takes longer. |
| `LLM_TIMEOUT_MS`    | `120000`                           | Give up on a model that has stopped responding. |
| `LLM_PROMPT_CACHE`  | `true`                             | Anthropic prompt caching. Set to `0` to measure its effect. |
| `WIKI_PUBLIC_URL`   | `http://127.0.0.1:3080`            | Where a person opens the wiki, for the URLs agents cite. |
| `MCP_RATE_LIMIT_PER_MINUTE` | `60`                       | Requests allowed per API key per minute. |
| `MCP_ALLOWED_HOSTS` | the dev hosts                      | `Host` values the MCP endpoint accepts. |
| `MCP_ALLOWED_ORIGINS` | the dev origins                  | `Origin` values accepted when one is sent. |
| `WIKI_URL`          | `http://wiki-app:3000`             | Where Wiki.js answers, from inside the Docker network. |
| `WIKI_API_KEY`      | —                                  | Reads page source as an administrator, for the indexer. Without it the indexer stays off. |
| `EMBED_MODEL`       | `nomic-embed-text`                 | Pulled in Ollama. Changing it re-embeds every page. |
| `INDEX_DEBOUNCE_SECONDS` | `10`                          | Rapid saves of one page collapse into a single job. |
| `RECONCILE_MINUTES` | `30`                               | How often the index is compared with the page list. |
| `INDEX_DB_URL`      | `postgres://wiki_ai:wiki_ai@ai-db:5432/wiki_ai` | The index database. |

Restart the service after editing `ai/.env` — `docker compose … up -d ai`
(`docker restart wiki-ai` does not reread the file).

## Providers

`src/providers/` has one interface, `ChatProvider`, and two implementations.
Nothing else in the agent knows which is running.

- **Anthropic** (`anthropic.ts`) — the official SDK. Current Claude models
  think adaptively by default and reject `temperature`/`top_p`/`budget_tokens`,
  so none of those are sent; depth is set with `effort` instead. Default model
  `claude-sonnet-5-5`; `claude-haiku-5-5` is the cheaper option.
- **Ollama** (`ollama.ts`) — its OpenAI-compatible API, through the `openai`
  client. Any locally pulled model with the `tools` capability works
  (`ollama show <model>` lists them). It is much slower than the cloud on this
  hardware.
- **Mock** (`LLM_PROVIDER=mock`) — the canned keyword replies from step 2, for
  UI work with no model calls and no cost: `restore`, `error 3201`, `compare`,
  `sources`, `draft`, and a short text answer for anything else.

The status chip in the panel header names the model and where it runs:
"Claude Sonnet 5.5 · Cloud", "qwen3.5 · Local", "Mock · Dev".

## How the agent answers

`src/agent/wiki-agent.ts` runs a short loop: ask the model, run whatever tools
it asked for, ask again with the results. It stops when the model answers, or
after `MAX_TOOL_STEPS` rounds — the pass after that offers no wiki tools, so
the model has to reply with what it has.

Two tools read the wiki (`src/wiki/tools.ts`):

- `search_wiki(query, locale?, limit?)` — Wiki.js's own `pages.search`,
  returning titles, paths and descriptions.
- `get_page(path, locale?)` — one page as Markdown.

Five more tools draw the answer: `sources`, `checklist`, `known_issue`,
`table`, `draft_page`. They are the same five components as before, described
to the model from `shared/components.ts`, so a tool call that satisfies the
schema also passes `parsePanelComponent`.

The system prompt (`src/agent/system-prompt.ts`) holds the agent to the wiki:
answer only from pages read in this run, never invent a command or a setting,
and when the wiki has no answer say so and offer a draft page.

With Anthropic, the system prompt, the tool definitions and the conversation
so far are cached: one breakpoint on the system block (tools render before
it, so both are covered) and automatic placement on the last message block.
A run asks the model several times with a growing prefix, and a follow-up
question reuses the same prefix again, so most of the input is a cache read.
`LLM_PROMPT_CACHE=0` turns it off.

Every run logs the provider, the model, whether the reader was signed in, the
tool calls with their timings and result sizes, and the token usage including
cache reads and writes — no page content and no credentials:

```
docker logs wiki-ai | grep 'agent run finished'
```

## Permissions

The tools run on the server but always as the reader who asked.

The panel is served from the wiki's own origin, so the browser sends the
reader's Wiki.js `jwt` cookie with every run. The service forwards that token
to Wiki.js as a bearer token (`server/helpers/security.js` accepts either),
and Wiki.js applies its own page permissions. With no token the reader is the
guest account, exactly as if they were logged out in a browser. There is no
admin key anywhere in this path.

`get_page` reads the **rendered** page over HTTP rather than the Markdown
source over GraphQL, because an ordinary reader cannot use the source:
`pages.single` and `pages.singleByPath` both require `manage:pages` or
`delete:pages`, and `Page.content` requires `read:source`. The rendered HTML
is converted to Markdown with turndown, tables included — troubleshooting
pages keep their error codes in tables.

## The page index

`ai-db` is a Postgres with pgvector, on the Docker network only, holding a
copy of every published page split into chunks with their embeddings. The
schema is created by migrations that run at startup
(`src/index-db/migrate.ts`):

- `index_pages` — one row per page: path, locale, title, content type, a hash
  of the source and Wiki.js's `updatedAt`.
- `index_chunks` — the page id, the heading path, the chunk text, a content
  hash, the embedding, the model that produced it, and `fts`, a generated
  `tsvector`. An **HNSW** index covers the vectors and a **GIN** index covers
  `fts`.
- `index_queue` — one row per page waiting to be indexed.
- `index_meta` — the embedding model and its width.

### Embeddings

Ollama on the Mac, with `EMBED_MODEL` (default `nomic-embed-text`, 768
dimensions). The width is asked for at startup and recorded, because pgvector
needs a fixed width to build an HNSW index. Changing the model empties the
index and rebuilds it, since a vector from one model means nothing to
another. pgvector indexes at most 2000 dimensions, so a wider model is
refused with a message rather than half-applied.

### The indexer

A durable queue with one row per page, so five saves in a minute collapse
into one job: each event pushes the deadline out by
`INDEX_DEBOUNCE_SECONDS` (10 in development).

A job fetches the page through Wiki.js GraphQL with `WIKI_API_KEY`, converts
it to Markdown if it was not written in Markdown, splits it at its headings
into chunks of roughly 300–600 tokens — each prefixed with the page title and
the headings above it — embeds only the chunks whose hash changed, and
replaces the page's chunks in one transaction. An unpublished page is removed
from the index, a deleted page is removed, and a rename updates the path
without re-embedding anything, because the text did not change.

Reconciliation runs five seconds after startup and every
`RECONCILE_MINUTES` (30). It compares Wiki.js's page list with the index,
queues anything new or changed and removes anything that is gone. On an empty
index that is the backfill.

```
docker logs wiki-ai | grep -E 'indexed a page|reconciled'
docker exec wiki-ai-db psql -U wiki_ai -d wiki_ai -c 'SELECT * FROM index_pages'
```

### Routes for the wiki, not for readers

`/internal/*` sits **outside** the `/ai` prefix, and the proxy forwards only
`/ai/*` to this service. So `http://127.0.0.1:3080/internal/...` reaches
Wiki.js and 404s, while `wiki-app` can call
`http://ai:4000/internal/...` directly on the Docker network.

| Route | Called by |
| ----- | --------- |
| `POST /internal/page-event` | the storage module, on every page change |
| `POST /internal/reconcile`  | its scheduled sync, and "Reconcile now" |
| `POST /internal/reindex`    | "Re-index everything" |
| `GET  /internal/status`     | whoever wants to see queue depth and counts |

### How search_wiki answers

`search_wiki` keeps its name and its input schema, but the index answers it
now. Two searches run over the same chunks — nearest neighbours by cosine
distance (HNSW) and full text (`websearch_to_tsquery` ranked by
`ts_rank_cd`, GIN) — taking the top 30 from each. The two rankings are merged
with reciprocal rank fusion, `score = Σ 1 / (60 + rank)`, which needs no
calibration between a distance and a text rank. Chunks are then grouped back
into pages, each page keeping its best one or two chunks as its snippet, and
the top pages come back with title, path, heading, snippet, last-updated date
and score.

Wiki.js's own search is the fallback, used only when there is no index to
ask — the database is unreachable, or nothing has been indexed yet. It is
logged when that happens. A query that simply matches nothing is an answer,
not a fallback.

### Permissions at query time

The index is built with the admin key, so it holds pages that a particular
reader may not see. Every candidate page is therefore checked against
Wiki.js **as the reader who asked**, with the same request `get_page` makes,
before anything reaches the model — snippets included. More candidates are
fetched than are returned so enough survive, and each reader's decisions are
cached for a minute (keyed by a hash of their token, never the token).

### Turning it on in the wiki

The indexer only hears about a change if the storage module is enabled.
In **Administration > Storage**:

1. Pick **AI Assistant Index** in the list.
2. Turn **Active** on.
3. Leave **AI service URL** as `http://ai:4000` and **Timeout** as `2000`.
4. **Apply**.

The two buttons under **Actions** on the same page are **Re-index
everything** and **Reconcile now**. Sync Direction is Push — the only mode
it supports — and the sync schedule defaults to every 30 minutes.

The module stores nothing and writes no files. It posts
`{ event, id, path, locale }` and returns immediately: a page save never
waits for the assistant, and never fails because of it.

## MCP: the wiki as a tool for agents

`POST /ai/mcp` speaks MCP over Streamable HTTP, built on the official
TypeScript SDK (`@modelcontextprotocol/sdk`). It is reachable through the
proxy, so an agent on this Mac connects to
`http://127.0.0.1:3080/ai/mcp`.

Four tools, described for an agent rather than a person. Each result carries
the page's URL, so an agent can cite what it used.

| Tool | What it does |
| ---- | ------------ |
| `search_wiki(query, limit?)` | The same hybrid index search the panel uses, with snippets. |
| `get_page(path, locale?)` | One page as Markdown, with title, path, URL and last-updated date; a very long page is cut and says so. |
| `list_pages(prefix?, limit?)` | Titles and paths for browsing. |
| `create_draft_page(title, path, content, description?)` | Files an unpublished page under `drafts/`, tagged `ai-draft`, for a person to review. |

Nothing here is new logic: search goes through the same `Retriever`, reading
a page through the same `WikiClient`, and a draft through Wiki.js's own
`pages.create`.

### Authentication and what a key can see

Every request needs `Authorization: Bearer <Wiki.js API key>`. A missing or
rejected key gets a `401`; the key is validated against Wiki.js and the
answer cached for a minute.

**Every read runs with that key's own permissions**, exactly as the panel
reads as a signed-in reader. A key scoped to a group sees only what that
group can read: `search_wiki` filters its candidates page by page before any
snippet is built, `get_page` refuses a page the key cannot open, and
`list_pages` walks Wiki.js's own page tree, which Wiki.js filters itself.
`create_draft_page` is Wiki.js's decision too — the key needs `write:pages`
under `drafts/`.

Keys and page content are never logged. Each tool call logs the tool name, a
ten-character fingerprint of the key, how long it took and how many
characters came back:

```
docker logs wiki-ai | grep 'mcp tool call'
```

There is a per-key limit of `MCP_RATE_LIMIT_PER_MINUTE` requests a minute
(60 by default); over it the server answers `429` with `Retry-After`.

`Origin` and `Host` are checked before anything else, against DNS rebinding.
The SDK's own `allowedHosts`/`allowedOrigins` options are deprecated in
1.32.2 in favour of external middleware, so the check lives in
`src/routes/mcp.ts` and reads `MCP_ALLOWED_HOSTS` and
`MCP_ALLOWED_ORIGINS`. An absent `Origin` is allowed: agents are not
browsers.

### Making a group and a key for agents

In the wiki's admin area:

1. **Administration > Groups > New Group** — call it something like
   *AI agents*. Give it `read:pages` (and `write:pages` if agents should be
   able to file drafts). Under **Page Rules**, allow `read:pages` on
   everything, then add a **deny** rule for anything agents must not see.
2. **Administration > API** — turn the API on if it is off, then
   **New API Key**. Name it after the agent, set an expiry, leave
   **Full Access** off and pick the group from step 1. **Copy the key now**;
   the wiki never shows it again.
3. Put the key in a file only you can read, outside this repository:

   ```sh
   mkdir -p ~/.config/wiki-ai && chmod 700 ~/.config/wiki-ai
   printf '%s' 'PASTE_THE_KEY_HERE' > ~/.config/wiki-ai/mcp-key
   chmod 600 ~/.config/wiki-ai/mcp-key
   ```

A key with Full Access would let an agent read everything, drafts and
restricted pages included. Scope it to a group.

### Connecting a client

**Claude Code** — at user scope, so it is available in every project. The
key is read from the file, so it never enters your shell history:

```sh
claude mcp add --scope user --transport http wiki-rag   http://127.0.0.1:3080/ai/mcp   --header "Authorization: Bearer $(cat ~/.config/wiki-ai/mcp-key)"
```

Check it with `claude mcp list`; remove it with
`claude mcp remove --scope user wiki-rag`. Claude Code stores the resolved
header in `~/.claude.json`, which is outside the repository — keep that file
private.

**Claude Desktop** has no HTTP transport of its own, so it goes through
`mcp-remote`. In *Settings > Developer > Edit Config*:

```json
{
  "mcpServers": {
    "wiki-rag": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "http://127.0.0.1:3080/ai/mcp",
        "--header", "Authorization:${WIKI_MCP_KEY}"
      ],
      "env": { "WIKI_MCP_KEY": "Bearer PASTE_THE_KEY_HERE" }
    }
  }
}
```

The header value goes in `env` because `mcp-remote` does not split an
argument containing a space; `Authorization:${WIKI_MCP_KEY}` has none.

**Cursor** — *Settings > MCP > Add new global MCP server*, or
`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "wiki-rag": {
      "url": "http://127.0.0.1:3080/ai/mcp",
      "headers": { "Authorization": "Bearer PASTE_THE_KEY_HERE" }
    }
  }
}
```

### What an agent should do with it

The server sends instructions along with the tool list: search before
answering, read a page before quoting it, cite by URL, and remember that a
missing page may simply be one this key cannot read. Drafts are the one
write: they land unpublished, out of the wiki and out of the index, until a
person publishes them.

## The search engine matters

Admin > Search Engine decides what `search_wiki` can find.

- **Database - Basic** (`db`, the default) matches the **title, description
  and path only**. A page whose body covers a topic its title does not mention
  is invisible, so the agent correctly reports that the wiki does not cover it.
- **Database - PostgreSQL** indexes the page **content** as well.

Switch to **Database - PostgreSQL** in Admin > Search Engine, press Apply,
then **Rebuild Index**. Nothing else in the assistant has to change.

## The protocol

The chat app and the service speak [AG-UI](https://docs.ag-ui.com) 1.0, using
the project's own packages: `@ag-ui/client` in the browser (`HttpAgent`),
`@ag-ui/core` and `@ag-ui/encoder` on the server.

A run is `POST /ai/api/agent` with an AG-UI `RunAgentInput`. The page the
reader is on travels in `forwardedProps.page` as `{ path, locale, title }`.
The reply is an SSE stream of:

```
RUN_STARTED
TEXT_MESSAGE_START -> TEXT_MESSAGE_CONTENT… -> TEXT_MESSAGE_END   (once per round)
TOOL_CALL_START -> TOOL_CALL_ARGS… -> TOOL_CALL_END               (one per card)
RUN_FINISHED
```

and `RUN_ERROR` instead of the rest if something fails — a missing key, a
provider error, a timeout — each with a short message for the reader and the
detail in the service log.

A run can hold several text messages, one per round of tool calls, so the
panel joins them rather than letting the last one replace the rest. The wiki
tools are not in this stream: they run on the server and only their results
reach the model.

A tool call is how an answer asks for a card. The name has to be one of
`sources`, `checklist`, `known_issue`, `table` or `draft_page`, and the
arguments have to pass `parsePanelComponent` in `shared/components.ts`;
anything else is ignored rather than drawn. `shared/` has no dependencies on
purpose, because the service and the chat app are separate npm projects with
separate `node_modules`.

## The chat app

- `src/App.tsx` holds the conversation and runs the agent; the components in
  `src/components/` draw it.
- Layout and dimensions follow the assistant panel in
  `docs/design/tanagraon-unified-ui.html`. Colours follow Wiki.js in light and
  dark, matching `client/components/ai/chat-drawer.vue`, and come from the
  `theme` query parameter.
- Assistant text is Markdown. Raw HTML is off: there is no `rehype-raw`, on
  purpose.
- Every link opens in a new browser tab, with a small icon and "(opens in a
  new tab)" in its accessible name. `index.html` carries
  `<base target="_blank">` as well, so nothing can load inside the panel's
  iframe.
- The conversation and its thread ID are kept in `sessionStorage`, so it
  survives moving from one wiki page to the next for as long as the tab is
  open. Stored cards are re-checked against the shared schemas when they are
  read back.
- It posts `wiki-ai:status` to the wiki page: `Mock · Dev` when the service
  answers, `Offline` when it does not.
- The bundle is large (about 250 kB gzipped) because `@ag-ui/client` brings
  rxjs, protobuf and zod with it.

### Building it for production

```sh
docker exec wiki-panel-ui sh -c 'cd /app/panel-ui && npm run build'
```

That writes `panel-ui/dist`, which the Fastify service serves at `/ai/panel/`.
In development the proxy sends `/ai/panel*` to Vite instead, so the build is
only used where there is no Vite — restart the service after the first build,
since it looks for `dist` at startup.
