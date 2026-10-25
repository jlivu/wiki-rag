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
| `/ai/health`    | Returns `{ "ok": true }`.                                         |
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

## Two settings to set by hand in the wiki

Both are one-off, in the wiki's admin area at http://127.0.0.1:3080/a.

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

## The mock agent

There is no model and no knowledge base yet. `src/agent/mock-agent.ts` picks a
canned answer by keyword, so every answer component can be seen:

| Ask for      | You get             |
| ------------ | ------------------- |
| `restore`    | a numbered checklist |
| `error 3201` | a known-issue card   |
| `compare`    | a table              |
| `sources`    | source cards         |
| `draft`      | a draft page form    |
| anything else | a short text answer that names the page you are on |

The first match wins, so "compare the sources" gives a table. Text is streamed
in small pieces with short delays, so the panel's streaming and typing
indicator are exercised.

## The protocol

The chat app and the service speak [AG-UI](https://docs.ag-ui.com) 1.0, using
the project's own packages: `@ag-ui/client` in the browser (`HttpAgent`),
`@ag-ui/core` and `@ag-ui/encoder` on the server.

A run is `POST /ai/api/agent` with an AG-UI `RunAgentInput`. The page the
reader is on travels in `forwardedProps.page` as `{ path, locale, title }`.
The reply is an SSE stream of:

```
RUN_STARTED
TEXT_MESSAGE_START -> TEXT_MESSAGE_CONTENT… -> TEXT_MESSAGE_END
TOOL_CALL_START -> TOOL_CALL_ARGS… -> TOOL_CALL_END     (zero or one, for a card)
RUN_FINISHED
```

and `RUN_ERROR` instead of the rest if something fails.

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
