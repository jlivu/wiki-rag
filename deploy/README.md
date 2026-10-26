# Running this in production

Production is this Mac, and only this Mac. The wiki and the assistant are
served at **http://localhost:8088**, every published port binds to
`127.0.0.1`, and nothing is reachable from the network. No certificate is
needed: browsers treat `localhost` as a secure context, so the microphone
works over plain HTTP.

Development (http://127.0.0.1:3080) keeps running alongside, with its own
containers, database, index, settings file and API keys. The two share
nothing except Ollama and whisper.cpp, which run natively on the Mac.

| | Development | Production |
| --- | --- | --- |
| Address | http://127.0.0.1:3080 | http://localhost:8088 |
| Compose | `dev/containers/*.yml` | `deploy/docker-compose.prod.yml` |
| Settings | `ai/.env` | `deploy/.env.prod` |
| Wiki database | volume `containers_db-data` | volume `wikijs_db-data` |
| Index | volume `containers_ai-db-data` | volume `wiki-rag-prod-index` |
| Wiki.js | `yarn dev`, rebuilt on save | the image `wiki-rag/wiki` |
| Chat app | Vite dev server | built files, served by the AI service |

## First time

```bash
cp deploy/.env.prod.example deploy/.env.prod   # then fill it in (below)
deploy/build.sh                                 # build both images
cd deploy
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
```

Open http://localhost:8088.

`deploy/.env.prod` is gitignored and is the only place production
settings live. The compose file refuses to start if a password is
missing, rather than quietly using a default.

### Secrets

Never put a key on a command line — it would sit in your shell history
and on screen. Read it in instead; the command itself contains no secret,
so it is safe in history:

```bash
# Paste the value at the prompt. Nothing is echoed.
read -rs "value?ANTHROPIC_API_KEY: " && printf 'ANTHROPIC_API_KEY=%s\n' "$value" >> deploy/.env.prod && unset value
```

The same for each of `WIKI_DB_PASS`, `INDEX_DB_PASS` and `WIKI_API_KEY`.
To change one later, delete its line first:

```bash
# macOS sed needs the empty argument after -i.
sed -i '' '/^ANTHROPIC_API_KEY=/d' deploy/.env.prod
read -rs "value?ANTHROPIC_API_KEY: " && printf 'ANTHROPIC_API_KEY=%s\n' "$value" >> deploy/.env.prod && unset value
```

For a password nobody has to type again, let the machine choose it:

```bash
printf 'INDEX_DB_PASS=%s\n' "$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)" >> deploy/.env.prod
```

`WIKI_DB_PASS` has to match the role in the database that
`WIKI_DB_VOLUME` holds — it is not free to invent. Before the switch-over
that is the password in `~/WikiJS/docker-compose.yml`; step 8 of
`SWITCHOVER.md` replaces it with a generated one that exists only in
`.env.prod`. To change it again later:

```bash
new="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40)"
printf "ALTER ROLE wikijs WITH PASSWORD '%s';\n" "$new" | docker exec -i wiki-prod-db psql -U wikijs -d wiki -q
sed -i '' '/^WIKI_DB_PASS=/d' deploy/.env.prod
printf 'WIKI_DB_PASS=%s\n' "$new" >> deploy/.env.prod
unset new
cd deploy && docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
```

`docker exec … psql` uses the container's local socket, which trusts
local connections, so this works even if the current password is lost.
`POSTGRES_PASSWORD` in the compose file is only read when a data
directory is first created; on an existing volume the `ALTER ROLE` is
what counts.

Keep `.env.prod` backed up somewhere safe — a password manager, not a
file beside the repository.

Check nothing is missing before starting. Use `--quiet`: plain
`docker compose config` prints the resolved file, secrets and all, into
your scrollback.

```bash
cd deploy && docker compose --env-file .env.prod -f docker-compose.prod.yml config --quiet && echo ok
```

## Every day

```bash
cd deploy
docker compose --env-file .env.prod -f docker-compose.prod.yml ps        # what is running
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f ai   # follow the assistant
docker compose --env-file .env.prod -f docker-compose.prod.yml stop      # stop
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d     # start again
```

Everything has `restart: unless-stopped`, so the stack comes back by
itself when the Mac restarts and Docker Desktop starts. Having stopped it
by hand, it stays stopped until you start it again.

Health, without opening a browser:

```bash
curl -s http://localhost:8088/healthz                 # Wiki.js
curl -s http://localhost:8088/ai/health | python3 -m json.tool   # the assistant
```

## Updating after new commits

```bash
git pull                     # or just carry on from your own commits
deploy/build.sh              # builds both, tagged with the date and commit
cd deploy
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
```

`up -d` recreates only what changed. The wiki's database is untouched by
an update; the index survives too, and anything that changed in the
indexing code is picked up by **Re-index everything** in
Admin > Storage > AI Assistant Index.

Each build is tagged `wiki-rag/wiki:YYYYMMDD-<commit>` as well as
`:latest`, and `deploy/build.log` lists them. Rolling back is a matter of
naming an older tag in `.env.prod`:

```
WIKI_IMAGE=wiki-rag/wiki:20261026-d0fe2ead
AI_IMAGE=wiki-rag/ai:20261026-d0fe2ead
```

then `up -d` again.

## Backups

One dump is the whole wiki: pages and their history, users, groups,
settings, and the uploaded files, which Wiki.js keeps in the database
rather than on disk. The index is deliberately not backed up — it is
rebuilt from the wiki in about a minute.

**Videos are the exception.** They are not in the database: they live in
`~/Media/wiki` on this Mac, mounted read-only into the AI service, which
is what makes them seekable and keeps them out of fourteen daily dumps.
The same script mirrors that folder to `~/Backups/wiki-rag/media` with
`rsync -a --delete` — one copy kept in step, not a dated copy a day — and
writes `media-<date>.txt` beside each dump listing what was there, so it
is possible to say which videos existed on a given day even though the
mirror only holds today's. Set `MEDIA_HOST_DIR` if the folder is
elsewhere. A deleted video disappears from the mirror on the next run, so
if the folder itself is the only copy of something, keep a copy of the
mirror too.

```bash
deploy/backup.sh                    # dump now, into ~/Backups/wiki-rag
```

Daily, at 02:10:

```bash
cp deploy/vu.gov.doft.wiki-backup.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/vu.gov.doft.wiki-backup.plist
launchctl list | grep wiki-backup          # it is loaded
tail ~/Backups/wiki-rag/backup.log         # what it did
```

Fourteen days of dumps are kept; older ones are deleted, but only once a
newer dump exists, so a failed run never empties the folder. A Mac asleep
at 02:10 takes the backup when it next wakes.

To stop the daily backup:
`launchctl unload ~/Library/LaunchAgents/vu.gov.doft.wiki-backup.plist`

### The monthly restore drill

A backup nobody has restored is a hope, not a backup. Once a month:

```bash
deploy/drill.sh
```

It takes the newest dump in `~/Backups/wiki-rag`, restores it into a
throwaway Postgres, and checks what came back:

```
drill: wiki-2026-10-26-0210.dump — 232K, 8h old
drill: restoring into a throwaway postgres:16-alpine
drill: restored in 3s
drill:   pages 41, assets 87, users 6, settings 23
drill:   newest page in the dump: 2026-10-25T21:58:43.769Z
drill:   live wiki now: pages 41, users 6
drill:   videos: 12 in /Users/joelivu/Media/wiki, 12 in the mirror
drill: PASSED — wiki-2026-10-26-0210.dump restores, and what came back looks like the wiki
```

It fails, loudly and with exit code 1, when:

- there is no dump at all, or `pg_restore` cannot read the one there is
- the dump has no pages, no users or no settings
- the dump has more than 10% fewer pages than the live wiki
  (`DRILL_TOLERANCE_PERCENT` to change that) — a dump can restore
  perfectly and still be missing half the wiki
- the media mirror is short of a video that is in the media folder,
  since videos are not in the dump at all

It warns, without failing, when the newest backup is over 48 hours old —
which usually means the launch agent is not loaded.

Nothing that is running is touched: production is not stopped, not
written to, and only asked how many rows it has. If production is not
running the drill still checks the dump, and says it had nothing to
compare against.

It takes the throwaway's Postgres image from the live database
container, because `pg_restore` cannot read an archive written by a
newer `pg_dump`. After a Postgres upgrade it follows the upgrade by
itself; set `DRILL_POSTGRES_IMAGE` to override.

It deliberately does not call `restore.sh`: a drill that depends on the
script it is drilling tells you nothing on the day that script is what
broke. What it cannot rehearse is `restore.sh --into-production`, which
writes over the live database — that path is only ever exercised for
real, which is why the drill proves the dump instead.

### Checking a backup can be restored

Worth doing after any change to the stack, and occasionally anyway. It
starts a throwaway Postgres, restores into it, counts what came back and
throws it away. It touches nothing that is running:

```bash
deploy/restore.sh --check ~/Backups/wiki-rag/wiki-2026-10-26-0210.dump
```

### Restoring for real

```bash
deploy/backup.sh                                     # a dump of the state you are leaving
deploy/restore.sh --into-production ~/Backups/wiki-rag/wiki-<date>.dump
```

It asks for confirmation, stops the wiki, replaces the database,
starts everything again, and then the index should be rebuilt from
Admin > Storage.

## Rolling back to the stock Wiki.js image

If something in this fork turns out to be broken, the wiki itself can run
on the official image against the same database. The assistant goes away
(the panel is part of the fork), the pages do not.

```bash
cd deploy
docker compose --env-file .env.prod -f docker-compose.prod.yml down
WIKI_IMAGE=ghcr.io/requarks/wiki:2 \
  docker compose --env-file .env.prod -f docker-compose.prod.yml up -d wiki db caddy
```

Or go back to the original setup entirely: bring production **fully
down** first, then `cd ~/WikiJS && docker compose up -d`, which recreates
the old containers from the same volumes. Only one stack may hold the
wiki's data volume at a time. After the switch-over has changed the
database password, that needs one extra command as well — see "Rolling
back" in `SWITCHOVER.md`.

The stock image is 2.5.317 and this fork's base is 2.5.315, which is a
*downgrade* in version number but not in schema: both have exactly the
same 16 migrations, verified against the installed wiki's own database.
Nothing has to be migrated in either direction.

## Container logs

Every service in `docker-compose.prod.yml` writes through the `json-file`
driver with **`max-size: 10m`, `max-file: 3`** — at most 30 MB each, 150
MB for the stack, rotated by Docker with no cron job and nothing to
remember. Without an explicit limit `json-file` grows without bound, and
the service that would fill it first is the one that logs a line per
indexed page.

```bash
# what each container is actually set to
docker compose --env-file .env.prod -f docker-compose.prod.yml ps -q |
  xargs docker inspect --format '{{.Name}} {{.HostConfig.LogConfig.Type}} {{.HostConfig.LogConfig.Config}}'
```

A change to the logging block only takes effect when the container is
recreated (`docker compose up -d`), not on a restart.

Development is capped the same way, in
`dev/containers/docker-compose.ai.yml` — including an override for the
`wiki` service, which is defined in the upstream compose file this fork
leaves alone.

## What is in the images

**`wiki-rag/wiki`** is upstream's own production build of this branch
(`dev/build/Dockerfile`) with two changes the official CI also makes and
a plain `docker build` does not: the version is stamped in — the source
says `2.0.0` — and `dev` is set to false, which is what turns off
`WIKI.devMode`. Admin > System Info will read **2.5.315**, the upstream
tag this branch is based on.

**`wiki-rag/ai`** is the assistant: the service compiled to JavaScript,
its production dependencies, Tesseract and poppler for reading images and
scanned PDFs, and the chat app's built files. The service serves those
itself at `/ai/panel/`, with `cache-control: no-store` on the page and a
year's `immutable` caching on the hashed files Vite emits.

Neither image carries a secret. Everything comes from `.env.prod` at
runtime.

## What leaves this Mac

Production is only reachable from this Mac, and as configured it reaches
out to **nothing** — the two things that used to, the Wiki.js butterfly
logo and the version/locale/telemetry calls, are both switched off. This
section says what each one was, how it is stopped, and what would turn it
back on.

Everything below was read from the code of 2.5.315 and this fork. It was
also measured: a copy of the wiki database was run against the production
image with `graph.requarks.io` and `static.requarks.io` pointed at a
listener on the same Docker network, and a browser loaded the home page,
a content page and `/login` with its network tab recorded.

| | Connections seen |
| --- | --- |
| Image's own config, default logo | 3 to `graph.requarks.io` within a second of startup, plus one per page view to `static.requarks.io` from the browser |
| **This stack** (`offline: true`, logo set) | **none, from the server or the browser** |

Videos change nothing here. They are read entirely on this Mac — ffmpeg
and Tesseract in the container, whisper.cpp natively — and served from
the media folder to signed-in readers. The one exception is switched off:
`VIDEO_DESCRIBE=1` would send sampled frames to whichever model
`IMAGE_DESCRIBER` names, exactly as an uploaded image is sent. It is `0`
by default; leave it there unless the cost and the exposure are both
wanted.

### Stopped, and how

| Was going to | When | What it would send | What stops it |
| --- | --- | --- | --- |
| **`static.requarks.io`** — the Wiki.js butterfly logo | Every page view, in every reader's browser | Whatever a browser sends: IP, user agent, and the wiki's URL as the `Referer` | **The site logo is set** (Admin > General > Logo), so `logoUrl` points at this wiki. Note that `hasLogo` in the `settings` table is a dead field — written once at install, never read in 2.5.315 — so `logoUrl` is the thing to check. |
| `graph.requarks.io` — update check (`syncGraphUpdates`) | At every start, then daily | The release channel and the Wiki.js version | **`offline: true`** in `deploy/config.prod.yml` |
| `graph.requarks.io` — locale list (`syncGraphLocales`) | At every start, then daily | A plain query with no variables | **`offline: true`** |
| `graph.requarks.io` — locale download | Only when an administrator installs a language | Which locale was asked for | **`offline: true`** — and this is the one real cost of it, see below |
| `graph.requarks.io` — telemetry | Once per process start, if the admin setting is on | Version, platform, OS name and release, CPU architecture, database type and version, Node version, CPU cores, RAM in MB, a random client id. No page content, no user data | **Both**: the setting is off (Admin > Utilities > Telemetry), and `offline: true` refuses it regardless — verified by enabling the setting in a throwaway copy and watching nothing leave. (`sendError`/`sendEvent` are stubs in 2.5.315 and send nothing in any case.) |
| **`plantuml.requarks.io`** | Any page holding a ` ```plantuml ` block, fetched by the reader's browser | **The diagram's source**, deflate-compressed and base64'd into the URL path — reversible, and it lands in that server's access log | **The renderer is disabled** (Admin > Rendering > markdown > PlantUML). Use **Mermaid** for diagrams: it is enabled, renders in the browser from code in the image, and calls nothing. |
| `static.requarks.io` — module logos | Admin pages listing modules (Auth, Comments, Analytics, Storage, Search) | The same, from the administrator's browser only | Nothing short of editing the modules' `definition.yml`. Only an administrator triggers it, and only on those pages. |

### About offline mode

`offline: true` is Wiki.js's single switch for the four
`graph.requarks.io` rows: it marks both daily jobs skipped
(`server/app/data.yml` flags them `offlineSkip`) and makes
`server/core/telemetry.js` refuse to enable itself.

It is not in the admin area and not an environment variable — it is a
line in `config.yml`, and the one baked into the image
(`dev/build/config.yml`, upstream's) does not have it. So
`docker-compose.prod.yml` mounts **`deploy/config.prod.yml`** over it:
the image's file copied verbatim, placeholders and all, with
`offline: true` appended. Keep the two in step when rebasing.

Confirmed working against a copy of the database: both jobs log
`Skipping job … because offline mode is enabled. [SKIPPED]`, nothing
reaches the listener, and **login, search, page rendering and the admin
area all behave** — Administration reports the installed version as the
latest rather than erroring, and Locale still lists what is installed.

The one thing it costs is downloading a **new** language. English is
built in. To add another later: comment the line out, `up -d wiki`,
install the language, put the line back.

This is production only. Development keeps the image's default, so the
behaviour upstream expects stays testable.

### Was never on

- **Mail** — no SMTP host is set, so nothing is sent. (The e-mail
  templates reference `static.requarks.io` images, but those are fetched
  by the recipient's mail client, not by this machine.)
- **All sixteen analytics modules** — Google, GTM, Matomo, Plausible,
  Yandex, Baidu, New Relic, Hotjar and the rest — are disabled.
- **`markdownKroki`** and **`markdownMathjax`** renderers are disabled.
  **Mermaid** and **KaTeX** are enabled but render in the browser from
  code bundled in the image; no request leaves. Mermaid is the diagram
  renderer to use.
- **Authentication** is local only. An external provider would add two
  paths: the sign-in round trip, and readers' browsers loading avatars
  from the provider's `pictureUrl`.
- **Storage** is our own *AI Assistant Index* module, which only calls
  `http://ai:4000` on the Docker network. The git, S3, Azure and Dropbox
  modules are not enabled.
- **Ollama** (embeddings, local answers) and **whisper.cpp** (dictation)
  run on this Mac and listen on `127.0.0.1` only. Containers reach them
  through `host.docker.internal`, which Docker Desktop forwards to
  loopback — the traffic never reaches a network interface.
- The **assistant's own MCP server** is inbound only.

### On, and does send page content

This is the part that is deliberately left on, because it is what the
assistant is for.

| Goes to | When | What it sends | Turning it off |
| --- | --- | --- | --- |
| **`api.anthropic.com`** — answering a question | Every question a reader asks the assistant | The system prompt, the conversation, and whatever the wiki tools returned for that question: page text, document text, image OCR and AI descriptions, titles and paths. Prompt caching is on, so that content is also held by Anthropic for the cache's lifetime | Put only local models in `MODELS` (e.g. `MODELS=ollama:gemma4:e4b`), or `LLM_PROVIDER=ollama`. The reader can also pick a local model per question, under the message box — but the allowlist is what decides whether the cloud is reachable at all. |
| **`api.anthropic.com`** — describing an image | While indexing an uploaded image, once per distinct picture (cached by content hash) | The picture, resized and re-encoded as JPEG, which strips EXIF, XMP, IPTC and the colour profile — GPS with them. Only the capture date survives | `IMAGE_DESCRIBER=off` in `.env.prod`. OCR and alt text still work; only the generated description goes. |

### Not at runtime

Building the images pulls from Docker Hub, npm and Debian's archives
(Tesseract and poppler for the AI image). `deploy/build.sh` is the only
thing that does this, and the running stack does not.

### Checking for yourself

```bash
# Offline mode took. Want: two "[SKIPPED]" lines, and no "Graph endpoint"
docker logs wiki-prod 2>&1 | grep -iE 'offline mode is enabled|Graph endpoint'

# The logo is ours, not the butterfly. Want: not a requarks.io URL
docker exec wiki-prod-db psql -U wikijs -d wiki -tAc \
  "SELECT value->>'v' FROM settings WHERE key='logoUrl';"

# PlantUML. Want: f
docker exec wiki-prod-db psql -U wikijs -d wiki -tAc \
  'SELECT "isEnabled" FROM renderers WHERE key = '"'"'markdownPlantuml'"'"';'

# Telemetry, from the database rather than the browser. Want: false
docker exec wiki-prod-db psql -U wikijs -d wiki -tAc \
  "SELECT value->>'isEnabled' FROM settings WHERE key='telemetry';"

# Analytics modules that are switched on. Want: no rows
docker exec wiki-prod-db psql -U wikijs -d wiki -tAc \
  'SELECT key FROM analytics WHERE "isEnabled";'

# Pages that would call out to the PlantUML server. Want: 0
docker exec wiki-prod-db psql -U wikijs -d wiki -tAc \
  "SELECT count(*) FROM pages WHERE content LIKE '%plantuml%';"
```

For the browser side, open the dev tools' network tab on a page and sort
by domain. Every row should be `localhost:8088`. A `static.requarks.io`
row means the site logo has gone back to the Wiki.js default.

## When Ollama or whisper.cpp is not running

Both run natively on this Mac, outside the stack, so both can be away
while the wiki is up. Neither takes the assistant down with it:

| | What still works | What does not |
| --- | --- | --- |
| **Ollama away** | Questions are answered: the index is searched by keyword, and the reply says the assistant is searching by keyword and may have missed something. Pages, files and videos are all still found. | No new or changed content is indexed. The queue keeps it and runs it when Ollama is back — nothing is lost, and no job is dropped for it. |
| **whisper.cpp away** | Everything except the two below. | The microphone button disappears from the panel (the health check probes for it), and a video with no subtitles beside it is left for later rather than indexed without its words. |

`deploy/drill.sh` and `deploy/backup.sh` do not need either.

The index status is where to look:

```bash
docker exec wiki-prod-ai node -e "fetch('http://127.0.0.1:4000/internal/status?compare=0')
  .then(r => r.json()).then(j => console.log(j.ready, j.reason ?? 'ok', j.queued, 'queued'))"
```

## What runs outside Docker

Ollama (embeddings, and a local answering model if you want one) and
whisper.cpp (dictation) run natively on the Mac so they can use the GPU,
and are shared with development. Both listen on `127.0.0.1` only;
containers reach them through `host.docker.internal`, which Docker
Desktop forwards to the Mac's loopback.

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E 'ollama|whisper'   # both should say 127.0.0.1
launchctl list | grep whisper                             # whisper.cpp's launch agent
```
