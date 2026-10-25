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
| `WIKI_URL`          | `http://wiki-app:3000`             | Where Wiki.js answers, from inside the Docker network. |

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

Every run logs the provider, the model, whether the reader was signed in, the
tool calls with their timings and result sizes, and the token usage — no page
content and no credentials:

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
