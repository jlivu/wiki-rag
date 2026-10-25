# wiki-ai

The AI service behind the wiki's assistant panel. Node 22, TypeScript, Fastify.

A reverse proxy (Caddy) puts this service and Wiki.js on one origin,
http://127.0.0.1:3080, and forwards `/ai/*` here with the path unchanged. The
panel's iframe needs that shared origin: it talks to the wiki page around it
with `postMessage`, and both sides check the origin.

| Route        | What it does                                                        |
| ------------ | ------------------------------------------------------------------- |
| `/ai/health` | Returns `{ "ok": true }`.                                            |
| `/ai/panel`  | The page the assistant panel loads. Plain HTML/CSS/JS for now; React replaces it in the next step. |

`/ai/panel` reads `path`, `locale`, `title` and `theme` from the query string
(the panel passes them in), matches the Wiki.js light and dark colours, tells
the panel it is online with `{ type: 'wiki-ai:status', label: 'Dev stub',
online: true }`, and has a **Test close** button that posts
`{ type: 'wiki-ai:close' }`.

## Start it

From the repository root:

```sh
docker compose -f dev/containers/docker-compose.yml \
               -f dev/containers/docker-compose.ai.yml up -d
```

That starts the database, the wiki container, this service and the proxy. The
wiki's own dev server still has to be started inside its container:

```sh
docker exec -d wiki-app sh -c 'yarn dev > /tmp/yarn-dev.log 2>&1'
```

Then:

- http://127.0.0.1:3080/ — the wiki
- http://127.0.0.1:3080/ai/health — `{"ok":true}`
- http://127.0.0.1:3080/ai/panel — the panel page on its own

Editing anything in `ai/` restarts the service (`tsx watch`); the source is
mounted into the container, so there is nothing to rebuild. Rebuild the image
only after changing `package.json` or the `Dockerfile`:

```sh
docker compose -f dev/containers/docker-compose.yml \
               -f dev/containers/docker-compose.ai.yml up -d --build ai
```

Logs: `docker logs -f wiki-ai`. Type check: `docker exec wiki-ai npm run typecheck`.

Never run `npm install` for this service on the Mac itself — do it in the
container, e.g. `docker exec wiki-ai npm install --package-lock-only`, so
`package-lock.json` stays in step with the pinned versions in `package.json`.

## Two settings to set by hand in the wiki

Both are one-off, in the wiki's admin area at http://127.0.0.1:3080/a.

1. **Admin > Theme > Head HTML Injection** — tells the panel where the chat app
   lives. Without it the panel shows its "Not connected yet" placeholder.

   ```html
   <script>window.WIKI_AI_PANEL_URL = '/ai/panel'</script>
   ```

2. **Admin > General > Site URL** — `http://127.0.0.1:3080`, so the wiki builds
   its links for the proxy rather than for port 3002.

## Layout

```
ai/
  Dockerfile        development image (Node 22, npm install, tsx watch)
  package.json      pinned dependencies
  package-lock.json generated in the container; commit it
  tsconfig.json     strict, ESM (NodeNext)
  src/server.ts     Fastify app and routes
  public/panel.html the panel page served at /ai/panel
```
