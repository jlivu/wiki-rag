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
