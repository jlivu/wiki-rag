# Switching the installed wiki over to this one

This is the plan, not a script. Read it through first; nothing in it has
been run.

**What changes.** The wiki at http://localhost:8088 stops being the stock
`ghcr.io/requarks/wiki:2` image and becomes this fork, with the assistant
panel beside it. Same address, same database, same pages, same users.

**What does not change.** The data. Production reuses the installed
wiki's own volumes — `wikijs_db-data` and `wikijs_wiki-data` — so nothing
is copied, migrated or converted. The pages, the uploaded files, the
accounts and the settings are the ones already there.

**Before you start, two facts worth knowing:**

- The installed wiki reports **2.5.317**; this fork's base is **2.5.315**,
  so Admin > System Info will show a lower number afterwards. It is not a
  downgrade of the database: both ship exactly the same 16 migrations,
  checked against the installed wiki's own `migrations` table. 2.5.316
  and 2.5.317 only added the server-side backup feature, which this fork
  does not carry. Upstream has still not tagged either of them.
- The new stack publishes **no database port at all**, and binds the wiki
  itself to `127.0.0.1:8088`. (The old stack published its database on
  `0.0.0.0:5438` until 2026-10-26; it is `127.0.0.1:5438` now.)

**Decided beforehand** (see CLAUDE.md):

- Production runs **2.5.315**. The 2.5.316/2.5.317 backup feature is not
  cherry-picked; `deploy/backup.sh` replaces it. Rebase onto v2.5.317
  when upstream finally tags it.
- The wiki database's **password is changed** (step 8). Afterwards it
  exists only in `deploy/.env.prod`, never in a compose file.
- Production gets its **own Anthropic key**, separate from development's.
- One page comes across from development: **`sops/sqlserver-restore`**
  (step 11). Nothing else does.
- The old stack's Postgres is already bound to `127.0.0.1` (done
  2026-10-26); it was on `0.0.0.0:5438`.

Set aside about half an hour. Steps 1 to 6 are reversible in seconds;
after step 7 the rollback is still simple but takes a few minutes.

---

## 1. Rehearse the backup

Not the backup you will rely on — that one is taken in step 5, once the
wiki has stopped accepting edits. This is to prove the machinery works
while there is still plenty of time to fix it.

```bash
WIKI_DB_CONTAINER=wikijs-db-1 WIKI_DB_USER=wikijs WIKI_DB_NAME=wiki \
  deploy/backup.sh

deploy/restore.sh --check ~/Backups/wiki-rag/wiki-<the file it just wrote>.dump
```

`backup.sh` refuses to write a dump that is too small or that lacks data
for `pages`, `users`, `settings` or `assetData`, so a dump with a name is
a dump worth having. `restore.sh --check` goes further and restores it
into a throwaway container.

Expect 2 pages, 1 asset and 2 users — the installed wiki as it stands.
Do not continue until both pass.

## 2. Build the images

```bash
cd ~/Workspaces/Wiki/wiki-rag
git status            # a clean tree, so the build tag means something
deploy/build.sh
```

Note the dated tags it prints; they are what you roll back to.

## 3. Write deploy/.env.prod

```bash
cp deploy/.env.prod.example deploy/.env.prod
```

Fill in, following "Secrets" in `deploy/README.md` so nothing is echoed
and nothing lands in your shell history:

- `WIKI_DB_PASS` — **for now**, the installed wiki's existing password,
  the one in `~/WikiJS/docker-compose.yml`, because production opens that
  same database volume. It is replaced in step 8.

  ```bash
  read -rs "value?WIKI_DB_PASS (the existing one): " && printf 'WIKI_DB_PASS=%s\n' "$value" >> deploy/.env.prod && unset value
  ```

- `INDEX_DB_PASS` — new, and nobody ever types it, so let the machine
  choose it:

  ```bash
  printf 'INDEX_DB_PASS=%s\n' "$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)" >> deploy/.env.prod
  ```

- `ANTHROPIC_API_KEY` — a **separate production key**, not development's,
  so the two can be told apart on the bill. Make one at
  console.anthropic.com, name it for this wiki, then:

  ```bash
  sed -i '' '/^ANTHROPIC_API_KEY=/d' deploy/.env.prod
  read -rs "value?ANTHROPIC_API_KEY (production): " && printf 'ANTHROPIC_API_KEY=%s\n' "$value" >> deploy/.env.prod && unset value
  ```

  Nothing is echoed; the command itself holds no secret, so it is safe in
  history. Check it arrived without showing it:

  ```bash
  grep -c '^ANTHROPIC_API_KEY=sk-' deploy/.env.prod     # 1
  ```

- `WIKI_API_KEY` — leave empty for now; it is made in step 9.

Check it parses, without starting anything:

```bash
cd deploy && docker compose --env-file .env.prod -f docker-compose.prod.yml config --quiet && echo ok
```

`--quiet` matters. Plain `docker compose config` renders the whole file
with every variable substituted — `WIKI_DB_PASS` and both keys printed
to the terminal, where they stay in the scrollback. `--quiet` validates
and prints nothing at all, while still reporting a genuine problem:

```
error while interpolating services.ai-db.environment.POSTGRES_PASSWORD:
required variable INDEX_DB_PASS is missing a value
```

### Pre-flight: the two Postgres versions must match

Production opens the installed wiki's data directory as it stands. A
Postgres data directory is readable only by the major version that wrote
it: point 17 at a directory written by 16 and it refuses to start, with
`database files are incompatible with server`. Nothing is damaged, but
the switch-over stops dead, so check first:

```bash
# What wrote the data directory, and what the new stack would run.
echo "data directory: $(docker exec wikijs-db-1 cat /var/lib/postgresql/data/PG_VERSION)"
echo "old stack:      $(grep -m1 'image: postgres' ~/WikiJS/docker-compose.yml | sed 's/.*image: *//')"
echo "new stack:      $(grep -m1 'image: postgres' deploy/docker-compose.prod.yml | sed 's/.*image: *//')"
```

Checked on 2026-10-26: data directory **16**, both compose files
`postgres:16-alpine`, running 16.13. They match, and nothing in this
plan upgrades Postgres — that is a separate job with its own dump and
reload.

The index's `pgvector/pgvector:0.8.7-pg17` is Postgres 17, but that is a
different database on a volume of its own that this image creates from
empty. It has nothing to do with the wiki's data directory.

## 4. Stop the old wiki, leaving its database up

From here on the old wiki accepts no more edits. Its database stays
running for one more step, because that is what the final backup is
taken from.

```bash
cd ~/WikiJS
docker compose stop wiki
docker compose ps                    # wiki Exited, db still Up
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8088/   # 000: nothing is listening
```

Development can keep running throughout; it uses different ports and
different volumes.

## 5. Take the backup you will actually rely on

Nothing can change the data now, so this dump is the exact state
production is about to inherit — and the thing you restore from if the
switch-over goes wrong.

```bash
WIKI_DB_CONTAINER=wikijs-db-1 WIKI_DB_USER=wikijs WIKI_DB_NAME=wiki \
  deploy/backup.sh
```

It fails loudly rather than writing a dump that cannot be a wiki: under
10 000 bytes, or missing data for `pages`, `users`, `settings` or
`assetData`. A dump that gets a name has passed those. Expect a line
like `(224K, 32 tables with data)`.

Then restore it somewhere harmless and look at what comes back:

```bash
FINAL=~/Backups/wiki-rag/wiki-<the file it just wrote>.dump
deploy/restore.sh --check "$FINAL"
```

Expect **2 pages, 1 asset, 2 users**. If any of that is missing or the
dump was refused, **stop**: start the old wiki again
(`cd ~/WikiJS && docker compose start wiki`) and work out why before
going any further.

Copy `$FINAL` somewhere off this Mac as well. It is the whole wiki in one
file, and from here the original volume is about to be written to by a
different stack.

## 6. Remove the old stack

Not `stop` — **`down`**. Stopping leaves the containers in place, and
anything that starts them again (a `docker compose up` in `~/WikiJS` out
of habit, the start button in Docker Desktop, `docker start
wikijs-db-1`) would run a second Postgres against the very volume
production is now using. `down` removes the containers, so there is
nothing left to start by accident.

```bash
cd ~/WikiJS
docker compose down
docker compose ps -a                 # nothing
docker volume ls | grep wikijs_      # both volumes still there
```

`down` removes containers and the project network. It does **not** touch
named volumes, which is where all the data is; `wikijs_db-data` and
`wikijs_wiki-data` survive, and are exactly what production opens next.

Both old containers were `restart: unless-stopped`. That policy would
not have restarted them after a reboot once they were explicitly
stopped — but it would have left them one click away from running, which
is the risk `down` removes.

To put the old stack back later, `docker compose up -d` in `~/WikiJS`
recreates the containers from the same file and the same volumes. See
"Rolling back".

## 7. Start production on the same data

```bash
cd ~/Workspaces/Wiki/wiki-rag/deploy
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
```

The wiki container mounts `deploy/config.prod.yml` over the image's own
`config.yml` — the same file plus `offline: true`. If that file is
missing, Docker makes a directory in its place, Wiki.js cannot read its
configuration and the container exits with *"Unable to read configuration
file!"*; `docker logs wiki-prod` says so plainly. Step 9.13 confirms it
took effect.

Wait for `wiki-prod` to be healthy (up to a minute on the first start),
then:

```bash
curl -s http://localhost:8088/healthz
curl -s http://localhost:8088/ai/health | python3 -m json.tool
```

Open http://localhost:8088 and log in with your existing account. The two
pages should be there, the coat of arms should still load. **Stop here if
anything looks wrong** and go to "Rolling back" at the bottom.

## 8. Change the database password

The installed wiki's password has sat in `~/WikiJS/docker-compose.yml` in
plain text, and that file is readable by anything running as you. Now
that production has opened the database successfully, replace it. The new
one is generated, used and stored without ever being displayed:

```bash
cd ~/Workspaces/Wiki/wiki-rag

# Generated, applied and saved in one go. The value never reaches the
# screen, and the commands hold no secret, so history is harmless.
new="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40)"
printf "ALTER ROLE wikijs WITH PASSWORD '%s';\n" "$new" | docker exec -i wiki-prod-db psql -U wikijs -d wiki -q
sed -i '' '/^WIKI_DB_PASS=/d' deploy/.env.prod
printf 'WIKI_DB_PASS=%s\n' "$new" >> deploy/.env.prod
unset new
```

Then restart the two containers that use it:

```bash
cd deploy
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
curl -s http://localhost:8088/healthz        # {"ok":true}
```

Two things worth knowing:

- The role's password lives **in the database**, not in
  `POSTGRES_PASSWORD`. That variable is only read when a data directory
  is first created, and this one already exists, so changing it in
  `.env.prod` keeps the file honest but changes nothing by itself. The
  `ALTER ROLE` is what does the work.
- `docker exec … psql -U wikijs` connects over the container's local
  socket, which trusts local connections. It therefore works whether or
  not you know the current password — which is also what makes the
  rollback below possible.

Afterwards `deploy/.env.prod` is the only place the password exists. Back
it up somewhere safe — a password manager, not a file beside the
repository. Losing it is recoverable (the `ALTER ROLE` above sets a new
one), but only from this Mac.

## 9. Settings to apply in the admin area

All at http://localhost:8088/a. Each is one-off.

1. **General > Site URL** → `http://localhost:8088`
   So the wiki builds its own links for this address.

2. **General > Uploads > Max file size** → `25 MB`
   The assistant indexes uploads up to `MAX_DOCUMENT_MB` (25). Leaving
   the wiki at its 5 MB default would stop most PDFs being uploaded at
   all. Max files per upload can stay at 10.

3. **Search Engine** → **Database - PostgreSQL**, then **Apply**, then
   **Rebuild Index**.
   The default, Database - Basic, matches only titles, descriptions and
   paths. The assistant's own index does the real work, but Wiki.js's
   search is the fallback when the index is empty or unreachable.

4. **Theme > Head HTML Injection** →
   ```html
   <script>window.WIKI_AI_PANEL_URL = '/ai/panel/'</script>
   ```
   Without it the panel shows its "not connected" placeholder. The
   trailing slash matters.

5. **API** → turn **API Access** on.
   Needed for the indexer key and the agent key below.

6. **API > New API Key** → name it *AI indexer (production)*, **Full
   Access on**, a long expiry. Copy the key once; the wiki will not show
   it again. Put it in `.env.prod` and restart the service, which is
   what makes it read the key:
   ```bash
   sed -i '' '/^WIKI_API_KEY=/d' deploy/.env.prod
   read -rs "value?WIKI_API_KEY: " && printf 'WIKI_API_KEY=%s\n' "$value" >> deploy/.env.prod && unset value
   cd deploy && docker compose --env-file .env.prod -f docker-compose.prod.yml up -d ai
   ```
   `up -d` **recreates** the container when the contents of `.env.prod`
   change — a container keeps the environment it was started with, so
   without a new container the key would not be seen. Verified on
   Compose v5.6.1: editing the env file and running plain `up -d` prints
   `Recreate`, and the new container has the new value.

   Confirm the service actually has it. Until the key is there the
   indexer says so on every start, and with it the line disappears:
   ```bash
   docker logs wiki-prod-ai 2>&1 | grep -c 'the indexer is off'   # was 1+, now 0 for the newest start
   docker logs --since 1m wiki-prod-ai 2>&1 | grep -E 'embeddings ready|image indexing ready'
   ```
   This key reads page *source*, which needs `read:source`; no ordinary
   reader has it. It is the one place an admin token is used, and only
   the indexer uses it.

7. **Groups > New Group** → *AI agents (production)*, with `read:pages`,
   `read:assets` and `write:pages`; under **Page Rules**, allow
   `read:pages` on everything and add deny rules for anything agents must
   not see.

8. **API > New API Key** → name it *Claude Code (production)*, **Full
   Access off**, group *AI agents (production)*. This is the MCP key —
   separate from the indexer's, and far less privileged.

9. **Storage > AI Assistant Index** → **Active** on, AI service URL
   **`http://ai:4000`**, timeout `2000`, **Apply**.
   Nothing is indexed on save until this is on.

   `ai` is the *service* name in `docker-compose.prod.yml`, which is the
   name Docker resolves on the stack's network. The container is called
   `wiki-prod-ai`, but that is only a label — the URL must use the
   service name, and it is the same `http://ai:4000` as in development
   because both stacks name the service `ai`. Prove it from the wiki
   container, which is where the storage module runs:
   ```bash
   docker exec wiki-prod curl -fsS http://ai:4000/ai/health
   ```
   That should print the health JSON. If it cannot resolve `ai`, the
   storage module will log `(STORAGE/RAG) /internal/page-event failed`
   on every save and nothing will be indexed.

   Then check the round trip for real: edit any page, save it, and
   ```bash
   docker logs --since 1m wiki-prod-ai 2>&1 | grep -E 'page-event|indexed a page'
   ```

10. **Utilities > Telemetry** → confirm it is still **off**.

    You turned it off in the installed wiki on 2026-10-26, and the
    switch-over reuses that same database volume, so the setting should
    come across — but it is one row in a table this plan has been
    restoring and repointing, so it is worth one look. Telemetry sends
    Wiki.js's servers one message per process start: version, platform,
    OS name and release, CPU architecture, database type and version,
    Node version, CPU cores, RAM in MB, and a random client id. No page
    content and no user data. (`sendError` and `sendEvent` are stubs in
    2.5.315 and send nothing at all.)

    Check it without the browser:
    ```bash
    docker exec wiki-prod-db psql -U wikijs -d wiki -tAc \
      "SELECT value->>'isEnabled' FROM settings WHERE key='telemetry';"
    ```
    `false` is what you want. If it says `true`, turn it off in
    **Administration > Utilities > Telemetry** rather than editing the
    row, so the running process picks it up.

    See "What leaves this Mac" in `deploy/README.md` for everything else
    the stack talks to.

11. **General > Logo** → confirm it is **not** the Wiki.js butterfly.

    You set the coat of arms in the installed wiki, and the switch-over
    reuses that database, so it should come across. The default logo is
    fetched from `static.requarks.io` by **every reader's browser on
    every page view**, which is the stack's most frequent call off this
    Mac — worth confirming rather than assuming.

    Note it is `logoUrl` that matters, not `hasLogo`: `hasLogo` is
    written once at install and never read again in 2.5.315, so it stays
    `false` whatever you do in the admin area. The check is:
    ```bash
    docker exec wiki-prod-db psql -U wikijs -d wiki -tAc \
      "SELECT value->>'v' FROM settings WHERE key='logoUrl';"
    ```
    Anything but a `static.requarks.io` URL is right; a path like
    `/_assets/logo/…` is served by this wiki.

    Then prove it from the page the readers get:
    ```bash
    curl -s http://localhost:8088/en/home | grep -c 'static.requarks.io'   # want 0
    ```
    And once, in a browser: open http://localhost:8088, dev tools >
    Network, reload, and sort by domain. Every row should be
    `localhost:8088`. (Verified this way on a copy of the database:
    with the logo set locally, a browser loading the home page, a
    content page and `/login` made no request off the machine.)

12. **Rendering > markdown > PlantUML** → confirm it is **off**.

    You disabled it in the installed wiki. It is the one renderer that
    would put page content on the wire: a ` ```plantuml ` block becomes
    `<img src="https://plantuml.requarks.io/svg/<the diagram source,
    deflated and base64'd>">`, which the reader's browser fetches and
    that server logs.
    ```bash
    docker exec wiki-prod-db psql -U wikijs -d wiki -tAc \
      'SELECT "isEnabled" FROM renderers WHERE key = '"'"'markdownPlantuml'"'"';'
    ```
    `f` is what you want. **Mermaid** (`htmlMermaid`) stays on and is the
    one to use for diagrams — it renders in the browser from code in the
    image and calls nothing.

13. **Offline mode** → confirm it took, which needs no admin page.

    `docker-compose.prod.yml` mounts `deploy/config.prod.yml` over the
    image's `/wiki/config.yml`. It is that file plus `offline: true`,
    which makes Wiki.js skip the version check and the locale sync and
    refuse to send telemetry whatever the admin setting says. Production
    only — development keeps the image default.

    The jobs announce that they were skipped:
    ```bash
    docker logs wiki-prod 2>&1 | grep -i 'offline mode is enabled'
    ```
    Two lines, `syncGraphLocales` and `syncGraphUpdates`. If instead you
    see `Fetching latest updates from Graph endpoint`, the mount did not
    land — check that `deploy/config.prod.yml` exists and that the
    compose file was the one used.

    The admin area is unharmed: Administration still shows the version
    (it reports the installed one as the latest, rather than an error),
    and **Locale** still lists what is in the database. The one thing
    lost is downloading a *new* language; English is built in. To add one
    later, comment out `offline: true`, `up -d wiki`, install it, put the
    line back.

## 10. Register the production MCP server in Claude Code

A second server, beside the development one, with its own key:

```bash
mkdir -p ~/.config/wiki-ai && chmod 700 ~/.config/wiki-ai
printf '%s' 'PASTE_THE_PRODUCTION_AGENT_KEY' > ~/.config/wiki-ai/mcp-key-prod
chmod 600 ~/.config/wiki-ai/mcp-key-prod

claude mcp add --scope user --transport http wiki-rag-prod \
  http://localhost:8088/ai/mcp \
  --header "Authorization: Bearer $(cat ~/.config/wiki-ai/mcp-key-prod)"

claude mcp list
```

Development stays registered as `wiki-rag` on port 3080. Check
`claude mcp list` names both, so you always know which wiki an agent is
reading.

**The address has to be one the MCP endpoint accepts.** It checks the
`Host` header against `MCP_ALLOWED_HOSTS` and refuses anything else with
403, which is its protection against DNS rebinding. Caddy passes the
browser's or client's original `Host` upstream unchanged, so the service
sees exactly what you typed. `.env.prod.example` therefore lists
`localhost:8088,127.0.0.1:8088,ai:4000` — register the server on
`localhost:8088`, as above, and it matches.

Check it before trusting it. An unkeyed call should be **401** (the key
was refused) and not **403** (the address was refused):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8088/ai/mcp \
  -H 'content-type: application/json' -d '{}'          # 401
```

A 403 means `Host` was rejected: add the address you are using to
`MCP_ALLOWED_HOSTS` in `.env.prod` and `up -d ai`. If you ever reach the
wiki by another name, that name has to be in the list too.

## 11. Carry one page over from development

**Decided:** `sops/sqlserver-restore` — the SQL Server restore runbook —
moves to production. Nothing else does: not `templates`, not
`policies/backup-retention`, and none of the test assets. The dev wiki is
left exactly as it is.

The page is self-contained: 2 522 characters of Markdown, no tags, no
images and no links to other pages, so it needs nothing but itself.

Each half runs **inside** the container that already holds the right key,
so neither key is ever on a command line. Development first:

```bash
cat > /tmp/export-page.js <<'JS'
const PATH = process.argv[2]
const KEY = process.env.WIKI_API_KEY
if (!KEY) { throw new Error('WIKI_API_KEY is not set in this container') }
const gql = async (query) => {
  const r = await fetch('http://wiki-app:3000/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ query })
  })
  const j = await r.json()
  if (j.errors) { throw new Error(j.errors.map(e => e.message).join('; ')) }
  return j.data
}
const list = await gql('{ pages { list(orderBy: ID) { id path } } }')
const found = list.pages.list.find(p => p.path === PATH)
if (!found) { throw new Error(`no page at ${PATH}`) }
const data = await gql(`{ pages { single(id: ${found.id}) {
  path title description editor locale content isPublished isPrivate tags { tag } } } }`)
const page = data.pages.single
console.error(`exported ${page.path}: "${page.title}", ${page.content.length} chars`)
process.stdout.write(JSON.stringify(page, null, 2))
JS

docker cp /tmp/export-page.js wiki-ai:/tmp/export-page.js
docker exec wiki-ai node /tmp/export-page.js sops/sqlserver-restore > /tmp/sqlserver-restore.json
docker exec wiki-ai rm -f /tmp/export-page.js
```

That should report `2522 chars`. Read `/tmp/sqlserver-restore.json` if
you want to see exactly what is about to move — it is only the page.

Then production:

```bash
cat > /tmp/import-page.js <<'JS'
const fs = require('node:fs')
const page = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const KEY = process.env.WIKI_API_KEY
if (!KEY) { throw new Error('WIKI_API_KEY is not set in this container') }
const mutation = `mutation (
  $content: String!, $description: String!, $editor: String!, $isPublished: Boolean!,
  $isPrivate: Boolean!, $locale: String!, $path: String!, $tags: [String]!, $title: String!
) { pages { create(
    content: $content, description: $description, editor: $editor,
    isPublished: $isPublished, isPrivate: $isPrivate, locale: $locale, path: $path,
    tags: $tags, title: $title, scriptCss: "", scriptJs: "",
    publishStartDate: "", publishEndDate: ""
  ) { responseResult { succeeded message } page { id path } } } }`
const variables = {
  content: page.content,
  description: page.description ?? '',
  editor: page.editor ?? 'markdown',
  isPublished: page.isPublished !== false,
  isPrivate: false,
  locale: page.locale ?? 'en',
  path: page.path,
  tags: (page.tags ?? []).map(t => (typeof t === 'string' ? t : t.tag)),
  title: page.title
}
const r = await fetch('http://wiki:3000/graphql', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ query: mutation, variables })
})
const j = await r.json()
if (j.errors) { throw new Error(j.errors.map(e => e.message).join('; ')) }
const result = j.data.pages.create
console.log(result.responseResult.succeeded
  ? `created ${result.page.path} (id ${result.page.id})`
  : `refused: ${result.responseResult.message}`)
JS

docker cp /tmp/import-page.js wiki-prod-ai:/tmp/import-page.js
docker cp /tmp/sqlserver-restore.json wiki-prod-ai:/tmp/page.json
docker exec wiki-prod-ai node /tmp/import-page.js /tmp/page.json
docker exec wiki-prod-ai rm -f /tmp/import-page.js /tmp/page.json
rm -f /tmp/export-page.js /tmp/import-page.js /tmp/sqlserver-restore.json
```

Note the different GraphQL hosts: `wiki-app:3000` is development's wiki,
`wiki:3000` is production's, each on its own Docker network.

Open http://localhost:8088/en/sops/sqlserver-restore to check it reads
properly before moving on.

## 12. Build the index

In **Admin > Storage > AI Assistant Index**, press **Re-index
everything**, then watch it:

```bash
docker logs -f wiki-prod-ai | grep -E 'reconciled|indexed a'
```

Three pages and one image is a few seconds' work. The image will be sent to
the description model once; everything else is local.

Confirm:

```bash
curl -s http://localhost:8088/ai/health | python3 -m json.tool
docker exec wiki-prod-ai-db psql -U wiki_ai -d wiki_ai \
  -c "SELECT (SELECT count(*) FROM index_pages) AS pages,
             (SELECT count(*) FROM index_documents) AS documents,
             (SELECT count(*) FROM index_chunks) AS chunks;"
```

## 13. Check it properly

- [ ] http://localhost:8088 loads and you are logged in as yourself
- [ ] All three pages read correctly — the two that were already there,
      plus `sops/sqlserver-restore` — and the coat of arms image displays
- [ ] Edit a page, save it, and it saves
- [ ] The assistant panel opens from the launcher at the bottom right
- [ ] A question about something in the wiki is answered **with sources**,
      and a source link opens the right page in a new tab
- [ ] A question about something absent offers a draft card, and
      **Create page** makes an unpublished `ai-draft` page
- [ ] The microphone button is there, dictation transcribes, and the text
      lands in the box without being sent
- [ ] Upload a PDF; within a minute the assistant can answer from it
- [ ] `docker logs wiki-prod-ai | grep -i error` is quiet
- [ ] Restart the Mac. Everything comes back by itself: the containers
      (`restart: unless-stopped`), whisper.cpp and Ollama (launch agents)
- [ ] After that restart, `docker ps -a | grep wikijs-` is **empty** —
      the old containers are gone, not merely stopped, so nothing can
      open the data volume behind production's back
- [ ] `deploy/backup.sh` writes a dump of the new stack, and
      `deploy/restore.sh --check` reads it back

## 14. Afterwards

- Install the daily backup agent (see `deploy/README.md`), if it is not
  installed already.
- Leave the old stack stopped but **do not delete it** for a few weeks.
  `~/WikiJS/docker-compose.yml` is the way back, and the volumes are
  shared, so there is nothing to keep in sync.
- Development keeps running on 3080. Nothing about it changed.

---

## Rolling back

Whichever of these you reach for, the rule is the same one that made
step 6 a `down`: **only one stack may have the wiki's data volume at a
time.** Bring production fully down before bringing the old stack up.

### Before step 8 — seconds

The password is still the old one, so the old stack starts as it always
did. `up -d` recreates the containers step 6 removed, from the same
compose file and the same volumes:

```bash
cd ~/Workspaces/Wiki/wiki-rag/deploy
docker compose --env-file .env.prod -f docker-compose.prod.yml down
docker compose --env-file .env.prod -f docker-compose.prod.yml ps -a   # nothing left

cd ~/WikiJS && docker compose up -d
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8088/        # 200
```

The old wiki comes back on the same data, exactly as it was.

### After step 8 — one extra command

The password changed, and `~/WikiJS/docker-compose.yml` still holds the
original, so the old stack would start and fail to authenticate. Set the
role password back to the one written in that file, and it works again:

```bash
cd ~/Workspaces/Wiki/wiki-rag/deploy
docker compose --env-file .env.prod -f docker-compose.prod.yml down
docker compose --env-file .env.prod -f docker-compose.prod.yml ps -a   # nothing left

# Only now: bring up the old stack's database on the same volume …
cd ~/WikiJS && docker compose up -d db

# … and put its own password back. Read it in from the compose file
# rather than typing it, so it is not echoed and not in history.
old="$(grep -m1 'POSTGRES_PASSWORD:' ~/WikiJS/docker-compose.yml | sed 's/.*POSTGRES_PASSWORD: *//')"
printf "ALTER ROLE wikijs WITH PASSWORD '%s';\n" "$old" | docker exec -i wikijs-db-1 psql -U wikijs -d wiki -q
unset old

docker compose up -d
```

`docker exec … psql -U wikijs` goes through the container's local socket,
which trusts local connections, so this works without knowing the current
password. That is also why a lost `WIKI_DB_PASS` is recoverable: the same
command with a new value sets one.

The data itself needs nothing either way. The stock image reads
everything this fork wrote; the assistant's only additions are an
`ai-draft` tag and some unpublished pages, which simply look like ordinary
drafts to it.

**If the fork's wiki image is the problem but the assistant is not**,
stay on the new stack and swap just the wiki image:

```bash
WIKI_IMAGE=ghcr.io/requarks/wiki:2 \
  docker compose --env-file .env.prod -f docker-compose.prod.yml up -d wiki
```

**If a bad build is the problem**, name the previous dated tag from
`deploy/build.log` in `.env.prod` and `up -d` again.

**If the data itself is damaged**, restore the dump from step 5 — the
one taken after the wiki stopped, so it holds every edit the old wiki
ever saw:

```bash
deploy/restore.sh --into-production ~/Backups/wiki-rag/wiki-<date>.dump
```
