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
| `/ai/api/pages` | Creates one page, as the reader who pressed the button. |
| `/ai/api/transcribe` | One recording in, its text out. Dictation only; nothing is stored. |
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
| `MAX_DOCUMENT_MB`   | `25`                               | Uploaded files larger than this are listed as skipped and never downloaded. |
| `IMAGE_DESCRIBER`   | `anthropic`                        | Which model describes an image: `anthropic`, `ollama` or `off`. Falls back to `off` with no API key. |
| `IMAGE_DESCRIBER_MODEL` | `claude-haiku-5-5`             | The vision model. `qwen3.5` when the describer is `ollama`. |
| `IMAGE_DESCRIBE_EXCLUDE` | —                             | Asset folders whose images are never sent to a model. OCR and alt text still apply. |
| `IMAGE_DESCRIBE_DAILY_LIMIT` | `200`                     | Descriptions a day, counted in the index so a restart does not reset it. |
| `STT_PROVIDER`      | `whispercpp`                       | Dictation: `whispercpp` or `off`. Off hides the microphone button. |
| `STT_URL`           | `http://host.docker.internal:8178` | whisper.cpp's server, running natively on the Mac. |
| `STT_LANGUAGE`      | `en`                               | The language spoken. `auto` detects it, less accurately. |
| `STT_MAX_SECONDS`   | `120`                              | The panel stops recording at this; the service refuses more. |
| `STT_RATE_LIMIT_PER_MINUTE` | `20`                       | Recordings a reader may send per minute. |
| `WIKI_PAGE_EXTENSIONS` | `md,html,txt`                   | Wiki.js's own `pageExtensions`. A file with one of these cannot be served as a file, so it is skipped. |

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
  hardware, and much worse at drawing the cards — see *Local models*.
- **Mock** (`LLM_PROVIDER=mock`) — the canned keyword replies from step 2, for
  UI work with no model calls and no cost: `restore`, `error 3201`, `compare`,
  `sources`, `draft`, and a short text answer for anything else.

The status chip in the panel header names the model, and says where it runs
when that is not obvious: "Claude Sonnet 5.5", "gemma4:e4b · Local",
"Mock · Dev".

## Choosing the model and the effort, from the panel

Under the message box, beside the note about checking answers, a small
button shows what will answer the next question — "Sonnet 5.5 · Medium".
It opens a menu **upwards**, because it sits at the bottom of the panel:

- the model in use, with its one-line description and a tick;
- an **Effort** row showing the current level;
- a **More models** row.

Either row opens a submenu that **replaces the menu's contents**, with a
back control at the top, rather than opening beside it: the panel is
400px wide and this app cannot draw outside its own frame.

The effort submenu explains the trade in one line, then lists the levels
that model supports, with **Recommended** on its default and a tick on
the current one. A model with no effort control has no Effort row at
all. More models lists the rest of the allowlist under **Cloud** and **On
this Mac**, each with a description, and anything that cannot answer
right now greyed out with the reason — "Ollama is not running on this
Mac", "Not downloaded — run: ollama pull …", "No API key on the server".

Arrow keys move, Enter chooses, Escape leaves a submenu and then closes
the menu; the rows are `menuitem`/`menuitemradio` and an unavailable one
is `aria-disabled` and announces its reason instead of its description.

The choice applies from the next message and is kept in that browser
(`localStorage`). The effort is remembered **per model**, because the
levels do not mean the same thing from one to the next — "high" on a
local model means thinking is on. The default is Claude Sonnet 5.5 at
Medium. The chip in the panel header keeps naming the model and where it
runs: "Sonnet 5.5 · Cloud", "gemma4:e4b · Local".

### MODELS, and the two older settings

`MODELS` in `ai/.env` is the allowlist: `provider:model`, comma separated, in
the order the menu shows them. **The first entry is the default** — what a
reader who has not chosen gets.

```
MODELS=anthropic:claude-sonnet-5-5,anthropic:claude-haiku-5-5,ollama:gemma4:e4b
```

Once `MODELS` is set it is the whole story, and the two settings that came
before it mostly step aside:

| | With `MODELS` set | With `MODELS` unset |
| --- | --- | --- |
| **`MODELS`** | the list, and its first entry is the default | — |
| **`LLM_MODEL`** | **ignored** | the default model |
| **`LLM_PROVIDER`** | **not needed** — each entry names its own provider. Only `LLM_PROVIDER=mock` still does anything, and it overrides `MODELS` | picks the provider for `LLM_MODEL` |

So with an explicit `MODELS` line you can delete `LLM_MODEL`, and you can
delete `LLM_PROVIDER` unless you want the mock agent. Both are kept in
`.env.example` because they are still the short way to run one model.

`LLM_PROVIDER=mock` keeps the canned keyword replies from step 2 and
overrides `MODELS`, so UI work costs nothing. Only an *explicit* `mock`
does that: the setting's own default is `mock`, and treating an absent
`LLM_PROVIDER` the same way would have meant a `MODELS` line being
silently ignored.

Which models are supported is in `.env.example`, with a line on each.
`claude-opus-5-5` is among them and is deliberately **not** in the
default list — see *Is Opus worth it here* below.

`GET /ai/api/models` returns each model's description, availability and the
effort levels it supports. The browser only ever sends an **id** and a
**level** from that answer back: a run naming anything else is refused with
`UNKNOWN_MODEL` or `UNKNOWN_EFFORT` and logged, so no one can reach a model
the administrator did not list or a level the model does not have. Each run's
log line names the model, the effort, and whether the reader chose each.

The choice affects answers only. Embeddings (`EMBED_MODEL`) and image
descriptions (`IMAGE_DESCRIBER_MODEL`) keep their own settings.

### How effort is set

Anthropic's own dial, `output_config.effort`, which is generally available
and takes `low`, `medium`, `high`, `xhigh` and `max`. Every current Claude
model accepts all five; the API's own default is `high` on Sonnet 5.5 and
`medium` on Haiku and Opus 5.5, so this service always names the level
rather than leaving it out.

Ollama has no such scale — only thinking on or off — so a local model that
can think is offered the two ends of the scale and nothing in between
(`reasoning_effort: 'none'` for Low), and one that cannot think is offered
nothing and loses the row.

**`LLM_EFFORT` sets the default level.** It is what a reader gets before
they choose, and what the menu marks *Recommended*, so the badge always
names what they would actually get. A model that does not have that level
— a local one has only low and high — falls back to its own default. The
reader's own choice is remembered per model in their browser and wins over
it.

**`EFFORTS` limits which levels the menu may offer at all**, applied on top
of what each model supports:

```
EFFORTS=low,medium,high     # hide the two dearest levels
EFFORTS=medium              # no choice at all; the row disappears
EFFORTS=                    # every level the model has — the default
```

It is enforced by the server, not just hidden in the menu: the route
validates the run against the narrowed list, so a request naming a level
outside it is refused with `UNKNOWN_EFFORT`, exactly as a forged one is.
`LLM_EFFORT` has to be one of the allowed levels or the service refuses to
start, and an unknown name in either setting is refused at startup rather
than ignored. If the list leaves a model with nothing — `EFFORTS=medium`
and a local model that only has low and high — that model keeps no Effort
row and runs at its own default.

### What effort is worth here

Every level of every model, against the three questions from step 3a, on
this wiki's three pages. The time and tokens are the total for all three
answers; the cost is at the published prices (Sonnet 5.5 $2 / $10 per MTok,
cache write $2.50, cache read $0.10; Haiku 5.5 $0.10 / $0.50, $0.125,
$0.01).

| Model | Effort | 3 answers | Input + cache read | Output | Cost | vs Low |
| --- | --- | --- | --- | --- | --- | --- |
| **Sonnet 5.5** | Low | 27.3 s | 45,931 | 1,889 | $0.0351 | 1.0× |
| | Medium | 23.6 s | 51,577 | 2,155 | $0.0417 | 1.2× |
| | High | 29.9 s | 53,490 | 2,769 | $0.0519 | 1.5× |
| | Extra high | 34.2 s | 55,183 | 3,358 | $0.0608 | 1.7× |
| | Maximum | 118.9 s | 67,079 | 15,652 | $0.1952 | 5.6× |
| **Haiku 5.5** | Low | 15.9 s | 39,482 | 2,378 | $0.0030 | 1.0× |
| | Medium | 20.7 s | 54,431 | 3,343 | $0.0034 | 1.1× |
| | High | 25.1 s | 60,638 | 4,084 | $0.0039 | 1.3× |
| | Extra high | 29.2 s | 61,650 | 4,700 | $0.0042 | 1.4× |
| | Maximum | 114.2 s | 69,114 | 25,366 | $0.0165 | 5.5× |
| **gemma4:e4b** | Low | 28.0 s | 19,348 | 744 | free | — |
| | High | 44.8 s | 27,291 | 2,034 | free | — |
| **qwen3.5** | Low | 68.8 s | 36,922 | 1,686 | free | — |
| | High | 597.2 s | 68,238 | 3,937 | free | — |

What the answers were actually like:

- **Low to Extra high is a narrow band.** Sonnet answered all three
  questions correctly at every one of them. Low and Medium are hard to
  tell apart; **High** is where the restore answer gains the
  troubleshooting `table` card as well as the checklist, and Extra high
  adds the sources card to the LDAP answer. Half again the cost between
  the two ends, and about a third more time.
- **Maximum is not worth it on a wiki this size.** Five and a half times
  the cost and four times the time on both cloud models, for the same
  cards and the same facts — Sonnet wrote 15,652 output tokens where
  Extra high wrote 3,358. Haiku at Maximum was actively *worse*: it lost
  the checklist on the restore question and answered with sources alone.
  It is listed because a question that has to be right is worth paying
  for; nothing here showed it earning the money.
- **Haiku is about twelve times cheaper than Sonnet** and roughly as
  quick, but it over-draws: at Low, Medium and High it answered the
  restore question with a checklist and *four* `known_issue` cards. Extra
  high is the level where it settles down to checklist + table + sources.
- **Medium is the default** because it is the cheapest level that never
  gave a wrong or thin answer, and because the difference up to Extra
  high is a fuller answer rather than a more correct one.

### Is Opus worth it here

`claude-opus-5-5` is supported but deliberately **not** in the default
`MODELS` line. It was measured the same way, all five levels, three
questions each:

| Effort | 3 answers | Input + cache read | Output | Cost | vs Low |
| --- | --- | --- | --- | --- | --- |
| Low | 37.3 s | 49,567 | 2,922 | $0.1250 | 1.0× |
| Medium | 49.8 s | 60,225 | 3,604 | $0.1233 | 1.0× |
| High | 45.9 s | 53,474 | 3,675 | $0.1240 | 1.0× |
| Extra high | 52.9 s | 60,252 | 4,555 | $0.1481 | 1.2× |
| Maximum | 296.7 s | 76,507 | 31,221 | $0.7123 | 5.7× |

Priced at Opus 5.5's $4 / $20 per MTok, cache write $5, cache read $0.20.

It is the best of the three at the cards: from **Medium** upwards it drew
checklist + table + sources on the restore question, which Sonnet only
manages at High. But that is the whole of the difference, and it is not
worth what it costs:

| | 3 answers | Cost | Cards on the restore question |
| --- | --- | --- | --- |
| Sonnet 5.5, Medium | 23.6 s | $0.0417 | checklist + sources |
| **Sonnet 5.5, High** | **29.9 s** | **$0.0519** | **checklist + table + sources** |
| Opus 5.5, Medium | 49.8 s | $0.1233 | checklist + table + sources |

**Sonnet at High gives the same answer as Opus at Medium for 42% of the
cost and 60% of the time.** On a wiki of a few pages there is nothing for
the extra capability to do. Opus is worth adding if the wiki grows to the
point where answers have to hold several long pages together at once —
measure it again then.

Opus at Maximum repeats the trap the other two show, and worse: 5.7× the
cost, six times the time, and it **lost the checklist** on the restore
question and answered with sources alone. Of the three models, every one
of them is at its worst at Maximum.

To offer it, add it to `MODELS`:

```
MODELS=anthropic:claude-sonnet-5-5,anthropic:claude-opus-5-5,anthropic:claude-haiku-5-5,ollama:gemma4:e4b
```

### Local models

Measured on this M1 Max against the three questions from step 3a, with the
real agent — nine tools and the full system prompt. Both installed models
have Ollama's `tools` capability; neither is as good as it looks on paper.

| At its better level | restore a backup | error 3201 | LDAP (not in the wiki) |
| --- | --- | --- | --- |
| **Sonnet 5.5**, Medium | 9.2 s, checklist + sources | 6.6 s, known_issue + sources | 7.8 s, draft_page |
| **Haiku 5.5**, Extra high | 10.7 s, checklist + table + sources | 6.0 s, known_issue + sources | 12.5 s, draft_page + sources |
| **gemma4:e4b**, High | 25.5 s, checklist + table + sources | 3.4 s, **nothing at all** | 15.9 s, draft_page |
| **qwen3.5**, High | **531.8 s**, the same checklist **five times** | 21.6 s, known_issue + sources | 43.8 s, draft_page, no text |

Both installed models have Ollama's `tools` capability, so both were
measured; the answers vary a great deal from one run to the next, and so
does the time, which depends on whether Ollama still has the model loaded:

- **gemma4:e4b** is the one to list. At High it matched Sonnet exactly on
  the restore question — checklist, troubleshooting table and sources — and
  offered a draft for the LDAP question. At Low it drew one card across all
  three questions instead of five, which is why thinking stays on. It
  returned nothing at all for "what does error 3201 mean" at **both**
  levels, where the run now says so rather than showing an empty bubble.
- **gemma4:e4b** gets the *content* right nearly every time, and cites it.
  What it does not do reliably is draw the cards: in about half the runs it
  produced the right ones (its best runs matched Sonnet exactly, checklist
  and troubleshooting table and all), and in the others it missed one,
  repeated its own paragraph, stopped mid-sentence, came back empty, or
  printed the card's own markup at the reader (`<known_issue title=…>`, a
  fenced `{"tool_calls": …}` block). It is listed anyway, clearly marked,
  because a reader who wants nothing to leave the Mac can pick it and switch
  back in one click. Take it out of `MODELS` to remove it from the menu.
- **qwen3.5** is not listed. At High it spent **nine minutes** on the restore
  question and drew the same checklist card five times; two of its three
  answers came back with cards but no text. At Low it is quicker but stops
  using the cards. Either way it is slower than gemma4:e4b for a worse
  answer.
- `OLLAMA_THINKING=0` sends `reasoning_effort: 'none'`, which makes both two
  to five times faster and both worse: qwen3.5 then stops using the cards at
  all and narrates its own searching ("I'll search the wiki for…"), and
  gemma4:e4b writes its tool call out as text (`search_wiki[query="…"]`).
  Left on.
- It is the models, not the plumbing: through Ollama's own `/api/chat` and
  through the OpenAI-compatible `/v1`, both parse a two-tool request
  identically. They come apart under the real prompt.
- A model that ends its turn having produced only thinking used to leave an
  empty bubble. The run now says so instead, and suggests another model.

## How the agent answers

`src/agent/wiki-agent.ts` runs a short loop: ask the model, run whatever tools
it asked for, ask again with the results. It stops when the model answers, or
after `MAX_TOOL_STEPS` rounds — the pass after that offers no wiki tools, so
the model has to reply with what it has.

Two tools read the wiki (`src/wiki/tools.ts`):

- `search_wiki(query, locale?, limit?)` — the hybrid index search, returning
  titles, paths, the matching section or place in a file, and its link.
- `get_page(path, locale?)` — one page as Markdown.
- `get_document(path)` — one uploaded file as text, each part labelled with
  where in the file it came from.

Every result from either carries a short source id — `S1`, `S2` — for the
model to cite. See *Citing sources* below.

Four more tools draw the answer: `checklist`, `known_issue`, `table`,
`draft_page`, described to the model from `shared/components.ts`, so a tool
call that satisfies the schema also passes `parsePanelComponent`. The fifth
component, `sources`, is not offered to the model: the server builds that
card itself.

The system prompt (`src/agent/system-prompt.ts`) holds the agent to the wiki:
answer only from pages read in this run, never invent a command or a setting,
and when the wiki has no answer say so and offer a draft page.

With Anthropic, the system prompt, the tool definitions and the conversation
so far are cached: one breakpoint on the system block (tools render before
it, so both are covered) and automatic placement on the last message block.

### Citing sources

Links and titles never come from the model. `src/agent/sources.ts` keeps a
registry for the run: every page a tool returns is recorded once — one entry
per page, filled in further each time it comes back — with its title, the
section that matched, a snippet, the last-updated date and the URL to open,
section anchor included.

The model is given only the ids. It writes `[S1]`, or `[S1, S2]`, after the
statement each source supports. As the answer streams, the same registry
rewrites those markers into `[1](cite:1)` — a marker split across two deltas
is held back until it is whole, and a marker naming something this run did
not return is dropped rather than shown. The numbers are citation order,
first cited first.

The run then ends with a `sources` card the server builds from exactly those
sources, in that order. If the model cited nothing but did read pages, the
pages it read are listed instead, so an answer drawn from the wiki never
ends without its sources. An answer that found nothing relevant — nothing
cited, nothing read — shows no card at all.

A source that is an uploaded file carries more: the file name, its type,
where in the file the answer came from, and the pages that link to it —
only the ones this reader may open, since a title leaks as much as a
snippet does. Its link opens the file itself, and a PDF opens at the cited
page (`#page=4`).

In the panel, `cite:1` is resolved against that card: entry 1 is marker [1].
The link, the title and the section come from the card, never from the href,
and a marker with no entry behind it (the card has not arrived yet) stays a
plain number. See `panel-ui/src/components/Citation.tsx`.
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
copy of every published page and every uploaded document, split into chunks
with their embeddings. The schema is created by migrations that run at
startup (`src/index-db/migrate.ts`):

- `index_pages` — one row per page: path, locale, title, content type, a hash
  of the source and Wiki.js's `updatedAt`.
- `index_documents` — one row per uploaded file: path, file name, type, size,
  Wiki.js's `updatedAt`, a hash of the bytes, and a status with a reason. A
  file that cannot be indexed is recorded too, so the reason is visible and
  reconciliation does not keep retrying it.
- `index_chunks` — the page **or** the document it belongs to (exactly one of
  the two, by a check constraint), the heading path, Wiki.js's anchor or a
  PDF page fragment, where in a document it came from, where an image's text
  came from (`origin`: `ocr`, `alt` or `description`), the chunk text, a
  content hash, the embedding, the model that produced it, and `fts`, a
  generated `tsvector`. An **HNSW** index covers the vectors and a **GIN**
  index covers `fts`.
- `index_document_links` — which pages link to which file, filled in as each
  page is indexed.
- `index_image_text` — the alt text and caption each page gives an image.
- `index_image_descriptions` — one generated description per image content
  hash, with the model and the tokens it cost. This is both the cache that
  stops an image being described twice and the day's tally.
- `index_queue` — one row per page or file waiting to be indexed, keyed by
  kind and id: a page and an asset can share a number.
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
replaces the page's chunks in one transaction.

A chunk belongs to one section: a long section is cut into several chunks and
short pieces are merged back together, but nothing is ever merged across a
heading, because a chunk that ran on past its heading would send a reader to
a section its text had already left. Each chunk keeps Wiki.js's own anchor
for its heading (`#troubleshooting`,
`#h-1-copy-the-backup-into-the-container`), read from the rendered page's
heading ids — the very elements Wiki.js walks to build a page's table of
contents, so the rules for turning a heading into a slug are not repeated
here. (Wiki.js's `toc` field itself cannot be fetched over GraphQL: it is
declared `String` and resolved to an array, so selecting it fails.) An unpublished page is removed
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

### When something leaves the wiki

Nothing the wiki has stopped showing may be searched, quoted or cited, so
every way content can disappear has a path out of the index.

**A page.** Deleted, unpublished, moved or edited — the storage module
posts the event and the job replaces or removes the page's chunks
wholesale, so a section removed from a page takes its chunks with it.
Measured in development: about 11 seconds, which is the ten-second
debounce plus the job.

**A publish window.** A page can be published and still not visible:
Wiki.js honours `publishStartDate` and `publishEndDate` and shows an
out-of-window page only to someone with write permission. Nothing fires
an event when a date passes, so the dates are indexed with the page
(`index_pages.publish_start`, `publish_end`) and used twice. Search
filters on them in SQL, so a window that closes takes effect on the next
question with no indexing at all; and reconciliation takes the chunks
away from a page whose window has closed, keeping the row so it knows
when the page may be read again. A window that opens again puts the page
back. Leaving this to the reader-side permission check would not do: an
administrator asking a question *can* see an out-of-window page, and
would be cited it.

**A file.** Deleted, renamed or replaced with a new version: the same
event path, the same ten seconds. Deleting a file also takes the AI
description written for it — unless another file still has the same
bytes, because a description is cached by the image's content hash and
shared between copies.

**Text copied somewhere else.** An image is indexed with the alt text and
captions of the pages that show it, so a page that is deleted, or that
simply stops showing the image, leaves its words inside the image's
chunks. Every image a page spoke for is therefore queued to be read again
when the page changes or goes — from the job *and* from reconciliation,
because a page can leave without an event. "Linked from" needs no such
care: it is queried live from a table that cascades with the page.

**While the service is down.** Nothing is lost, only delayed:
reconciliation five seconds after startup compares both lists and removes
what went missing, images included. Measured: a page and a file deleted
with the service stopped were gone about seven seconds after it started.

**Anything still slipping through.** Every search result is checked
against Wiki.js as the reader who asked, and Wiki.js answers 403 for
something that reader may not see and 404 for something that is not
there. A 404 means the index is stale: the result is dropped before the
model sees it, the page or file is queued to be read again — by id, with
the admin key, so a page that was only moved has its path corrected
rather than being thrown away — and a line goes into the log:

```
docker logs wiki-ai | grep 'no longer in the wiki'
```

Because a cached "yes" would hide exactly that check, a positive
permission decision is cached for fifteen seconds rather than a minute,
and anything leaving the index clears the cache outright.

### Is the index in step with the wiki?

```
docker exec wiki-ai node -e "fetch('http://127.0.0.1:4000/internal/status').then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)))"
```

It reports what the index holds (pages, files, chunks, image
descriptions, alt-text rows, links), what the wiki holds, the time and
result of the last reconciliation, and a `drift.note` listing anything
out of step — pages or files on one side only, pages with no chunks,
pages held back by a publish window, jobs still queued. `inStep` is true
when the two agree. Add `?compare=0` to skip asking the wiki, which is
the only slow part.

The same thing without a terminal: **Administration > Storage > AI
Assistant Index > Index status**. Wiki.js only ever says "Action
completed." in the browser, so the answer goes to the wiki's log:

```
docker logs wiki-app | grep 'STORAGE/RAG'
```

### Uploaded documents

Files uploaded through Wiki.js's asset manager are indexed alongside pages,
so one search covers both and an answer can cite the file itself.

**What is indexed.** PDF, DOCX, XLSX, PPTX, CSV and images — PNG, JPEG, WebP and the first frame of a GIF (see *Images* below). Everything else is
recorded with the reason it was left out, which is also logged
(`document not indexed`): a file larger than `MAX_DOCUMENT_MB` (never
downloaded — the size comes from the listing), a legacy `.doc`, `.xls` or
`.ppt`, an unsupported type, or an image in a format the bundled libvips
cannot decode: HEIC (`convert it to JPEG to index it`), SVG, TIFF, BMP,
AVIF and icons.

A folder whose name is one or two characters is the other trap: Wiki.js
reads the first segment of a URL as a locale, so a file in `it/` or `hr/`
is looked up without it — it 404s, or a different file of the same name at
the root is served in its place. Such a file is recorded as skipped with
that reason rather than indexed from the wrong bytes.

Plain text and Markdown are the awkward case. Wiki.js's `pageExtensions`
setting makes it serve `/notes.txt` as a *page*, so an uploaded `.txt`,
`.md` or `.html` cannot be downloaded at its own URL — and a reader's
access to it cannot be checked there either. Such a file is recorded as
skipped with that reason rather than indexed and shown to people who may
not be allowed to see it. `WIKI_PAGE_EXTENSIONS` has to match the wiki's
own setting.

**Where the text comes from.** Each format is read with its structure
intact, because a citation has to name a place the reader can go back to:

| Format | Split into | A citation reads |
| ------ | ---------- | ---------------- |
| PDF (`unpdf`) | pages | `Page 4`, and the link opens there with `#page=4` |
| DOCX (`mammoth`, then the service's Turndown) | headings | `Section "Pricing"` |
| PPTX (`fflate` + `fast-xml-parser`, no library) | slides, in `p:sldIdLst` order | `Slide 7 "Findings"` |
| XLSX (`read-excel-file`) | sheets, then rows | `Sheet "Budget" rows 12–40` |
| CSV (`csv-parse`) | rows | `Rows 12–40` |

Chunking follows the page rules — roughly 300–600 tokens, never crossing
from one place in the file into another — and every chunk is prefixed with
the file name and that place. A sheet's header row is repeated at the top
of every chunk cut from it, so a row still has its column names.

**How a file is fetched.** Wiki.js's storage hooks (`assetUploaded`,
`assetRenamed`, `assetDeleted`) post the asset id to
`/internal/asset-event`; the service then lists and downloads the file
itself with `WIKI_API_KEY`, rather than being handed the bytes. Listing
means walking the folder tree — `assets.list` takes one folder and there is
no query for all of them — so the walk is cached for a few seconds and
shared by a burst of uploads. Reconciliation compares that walk with
`index_documents` by path, size and date, so a file that arrived while the
service was down is picked up anyway.

**Which pages link to a file.** As each page is indexed, its rendered HTML
is scanned for links to assets and the pairs are written to
`index_document_links`. The same pass records what each page calls the
images it shows — alt text, a `<figcaption>`, a caption line under the
image, or a `"title"` — in `index_image_text`, and re-queues any image
whose text changed. Wiki.js has no table for this — `pageLinks` holds
page-to-page links only. A document source then shows "Linked from", with
the pages the asking reader is allowed to open and no others.

**Permissions.** Exactly as for a page, and with the reader's own token: a
file is checked with a `HEAD` of its URL, which runs Wiki.js's `read:assets`
check against the path (`server/controllers/common.js`) and answers 403 when
it refuses. The indexer's download has already warmed the wiki's cache, so
the check is cheap. `get_document` makes the same check before returning a
word.

### Images

An image carries no text of its own, so three sources are tried and each
becomes its own chunk, labelled with where it came from:

| Origin | Shown as | Where it comes from |
| ------ | -------- | ------------------- |
| `ocr` | Text in image | Tesseract, run locally on the original file |
| `alt` | Alt text | the alt text and captions of the pages that show it |
| `description` | AI description | a vision model, when that is switched on |

The same Tesseract reads a **scanned PDF** — one with no text layer, which
used to be recorded as `needs_ocr` and left at that. Each page is rendered
with `pdftoppm` at 150 dpi and read, so a citation still says "Page 4" and
the link still opens there. A scan longer than 50 pages is read that far
and the log says so; a scan with nothing legible on any page stays
`needs_ocr`.

Both tools are installed in the service's image (`ai/Dockerfile`):
`tesseract-ocr`, `tesseract-ocr-eng` and `poppler-utils`, about 110 MB,
most of it the ICU library Tesseract depends on. Tesseract always reads a
file the service wrote itself, never stdin: handed bytes it cannot decode,
it falls back to treating stdin as a *list of file paths* and OCRs those.

**Before an image leaves the machine.** `src/images/prepare.ts` decodes it,
bakes in the EXIF orientation, resizes it and re-encodes it as JPEG. That
re-encoding is what removes the metadata — EXIF, XMP, IPTC and the colour
profile all go — so a photograph's GPS position cannot reach a model even
by accident. The only field ever read out of it is the capture date, with
`exifr`'s top-level `pick`, which is the one form that does not hand back
GPS alongside what was asked for. The date may be indexed; the position
never is.

The resize fits **both** of Anthropic's limits, a long edge and a visual
token count. Capping the long edge alone is not enough: a 4032×3024
photograph capped to 1568px is 2352 tokens against a 1568-token tier, and
the API would quietly shrink it a second time.

**What it costs, and what stops it.** A description is looked up by the
image's **content hash**, so the same picture is never described twice,
however often it is uploaded or re-indexed. `IMAGE_DESCRIBE_EXCLUDE` lists
folders whose images are never sent at all — OCR and alt text still apply
to them. `IMAGE_DESCRIBE_DAILY_LIMIT` caps the day's descriptions, counted
from the index rather than from memory, so a restart does not reset it.
Every image logs what it cost:

```
docker logs wiki-ai | grep 'indexed a document'
{"documentId":17,"action":"indexed","chunks":2,"ocrChars":191,"described":"fresh",
 "describeModel":"claude-haiku-5-5","describeInputTokens":1774,"describeOutputTokens":400,
 "sentPixels":"1311x901","sentTokens":1551}
```

`described` says what happened: `fresh`, `cached`, `off`, `excluded`,
`over-limit`, `unreadable` or `empty`.

The model is asked for a factual description and any text it can read, and
told not to guess. What it writes goes into the index behind "Generated
description of this image:", is labelled **AI description** in the sources
card with a "generated, not read from the image" badge beside it, and the
agent is told to prefer the text read from the picture when the two
disagree.

An image is re-read every time it is queued, unlike a document: some of
its text comes from outside the file, so a page that gains a caption makes
the image stale without changing a byte of it. Re-reading is cheap — OCR
is local and the description comes from the cache.

### Routes for the wiki, not for readers

`/internal/*` sits **outside** the `/ai` prefix, and the proxy forwards only
`/ai/*` to this service. So `http://127.0.0.1:3080/internal/...` reaches
Wiki.js and 404s, while `wiki-app` can call
`http://ai:4000/internal/...` directly on the Docker network.

| Route | Called by |
| ----- | --------- |
| `POST /internal/page-event` | the storage module, on every page change |
| `POST /internal/asset-event` | the storage module, on every upload, rename or delete |
| `POST /internal/reconcile`  | its scheduled sync, and "Reconcile now" |
| `POST /internal/reindex`    | "Re-index everything" |
| `GET  /internal/status`     | whoever wants the index measured against the wiki (`?compare=0` for counts only) |
| `POST /internal/status`     | "Index status", which logs the one-line summary |

### How search_wiki answers

`search_wiki` keeps its name and its input schema, but the index answers it
now. Two searches run over the same chunks — nearest neighbours by cosine
distance (HNSW) and full text (`websearch_to_tsquery` ranked by
`ts_rank_cd`, GIN) — taking the top 30 from each. The two rankings are merged
with reciprocal rank fusion, `score = Σ 1 / (60 + rank)`, which needs no
calibration between a distance and a text rank. Chunks are then grouped back
into pages, each page keeping its best one or two chunks as its snippet, and
the top pages come back with title, path, the heading and anchor of the
best-matching chunk, a snippet, the last-updated date and the score. The
snippet is tidied for reading — fenced code dropped, table rows flattened to
one line — unless that would leave nothing, in which case the text stands as
it is.

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
cached (keyed by a hash of their token, never the token): a refusal for a
minute, a "yes" for only fifteen seconds, because a "yes" is also the claim
that the page is still there. A check that comes back 404 means the index is
stale rather than the reader unlucky — see "When something leaves the wiki".

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

## Creating a page from a draft card

When the wiki has no answer, the assistant offers a `draft_page` card: a
title, a path and a body the reader can edit. Pressing **Create page**
creates it.

**The model cannot do this.** It has no tool for creating a page in the
panel, and nothing in an answer can cause a request. A page appears only
because a person pressed the button.

**It is created as that person.** The request carries their Wiki.js login
cookie and nothing else — no admin key is in scope on this route — so
Wiki.js applies their own permissions, exactly as the editor would. A
reader who is not logged in gets a disabled button reading "Log in to
create pages".

The page is created **unpublished**, tagged `ai-draft`, in the Markdown
editor, with a warning block at the top:

```
> **Draft written by the wiki assistant.** Nothing here has been checked by a person.
> Read it against the sources, correct what is wrong, delete this note, then publish.
{.is-warning}
```

Nothing is visible to anyone else until a person publishes it, and an
unpublished page is not indexed. Publishing it indexes it within seconds
(measured: 12, which is the 10-second debounce plus the job).

Afterwards the card turns into its created state with **Open in editor**,
which opens `/e/{locale}/{path}` in a new tab. That state is kept in
`sessionStorage`, keyed by the message and the position of the card in it,
so it survives a reload and the button cannot make a second page. It is
deliberately *not* kept in the card's own arguments: those come from the
model and are re-checked from storage on every reload, so a model that
wrote `created: { editUrl: … }` into a tool call would put a link of its
own choosing in front of the reader. A stored entry whose links point off
this origin is thrown away.

### POST /ai/api/pages

| Answer | When |
| ------ | ---- |
| `201 { ok: true, page }` | created; `page` carries `editUrl` and `viewUrl` |
| `400` | the path breaks one of Wiki.js's rules, or a field is missing |
| `401` | not logged in |
| `403` | the `Origin` is not the wiki's, or Wiki.js refused this reader |
| `409` | a page already exists there; the answer carries `existingUrl` |
| `415` | the body was not JSON |
| `503` | the wiki did not answer |

Because it writes, the route is stricter than the rest: the body must be
JSON (a cross-site form post cannot be), the `Origin` header must be the
wiki's own, and the mutation runs with the reader's token. The log records
who created what — a short fingerprint of the token, the id, the path and
the timing — and never the content.

`shared/pages.ts` holds the path rules, so the panel and the service check
the same ones: the panel can tell the reader what is wrong while they can
still fix it, and the service checks again because a browser is not where
a rule is enforced. They are Wiki.js's own rules:

| Refused | Why |
| ------- | --- |
| `ops/my page`, `ops/notes.md`, `ops\win`, `ops//x` | `pages.create` rejects spaces, dots, backslashes and empty folders |
| `"` `\|` `<` `>` `:` `*` `?`, control characters | Wiki.js's `unsafeCharsRegex` |
| `x/thing` | a one-letter first folder is one of Wiki.js's own routes |
| `it/manual`, `en/guide` | Wiki.js reads a two-letter first folder as a language code |
| `login/…`, `img/…`, `js/…`, `svg/…`, `fonts/…` | `reservedPaths` in `server/app/data.yml` |

The last three are the interesting ones: `pages.create` accepts those paths
happily and the page is then unreachable, because `isReservedPath` is
checked by the *editor* route and not by the mutation.

The same code creates the page for MCP's `create_draft_page`
(`src/wiki/pages.ts`), with one difference: an agent always writes under
`drafts/`, while a person may choose the path.

## Dictation

The composer has a microphone button with a chevron beside it. The button
records; the chevron opens a popover with a live input-level meter and the
list of microphones, the system default first and a check mark against the
one in use. The choice is remembered in `localStorage`. Before the browser
has been given permission it will not say what the devices are called, so
the popover explains that and offers to ask.

Pressing the button again stops; **Escape** cancels without transcribing;
recording stops by itself at `STT_MAX_SECONDS`. The text is inserted at the
cursor in the message box and **nothing is ever sent for the reader** —
they read it, fix it and press Send.

### Speech to text, locally

Whisper runs on this Mac through whisper.cpp, natively rather than in a
container so it can use the GPU — the same arrangement as Ollama.

```
brew install whisper.cpp                      # 1.9.5, Metal enabled
mkdir -p /opt/homebrew/var/whisper/models
curl -L -o /opt/homebrew/var/whisper/models/ggml-small.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
```

`small.en` (465 MB) is the model in use: clearly better than `base.en` on
part numbers and names, and still far quicker than real time. The server
runs as a launch agent, `~/Library/LaunchAgents/vu.gov.doft.whisper-server.plist`,
so it starts at login and is restarted if it exits:

```
launchctl load   ~/Library/LaunchAgents/vu.gov.doft.whisper-server.plist   # start, and at every login
launchctl unload ~/Library/LaunchAgents/vu.gov.doft.whisper-server.plist   # stop, and stop starting
tail -f /opt/homebrew/var/log/whisper-server.log                           # what it is doing
```

It listens on **`127.0.0.1:8178`**, and must stay there. whisper.cpp has no
authentication of any kind: anything that can reach the port can transcribe
audio on this machine. Binding it to `0.0.0.0` would hand that to everyone
on the network.

Loopback is enough because Docker Desktop for Mac forwards
`host.docker.internal` (192.168.65.254 inside the container) to the Mac's
loopback — the connection is made by Docker Desktop on the host, so it
arrives on `127.0.0.1`. Ollama is the proof: it has always been loopback
only, and the indexer has always reached it. Verified both ways here — the
container gets HTTP 200 from `host.docker.internal:8178`, while the Mac's
own LAN address refuses the connection.

The first start after an upgrade compiles Metal shaders and takes a few
minutes; the compiled set is cached, and later starts take seconds.

### POST /ai/api/transcribe

The browser sends 16 kHz mono WAV — it converts the recording itself with
the Web Audio API, so the service needs no ffmpeg and whisper.cpp never has
to transcode. The service checks the RIFF header rather than trusting it,
refuses anything else, and forwards the audio to whisper.cpp.

| Answer | When |
| ------ | ---- |
| `200 { text, seconds, ms }` | transcribed; `text` is empty if nothing was heard |
| `400` | not a WAV, not 16 kHz mono, not 16-bit PCM, or empty |
| `413` | longer than `STT_MAX_SECONDS` |
| `429` | more than `STT_RATE_LIMIT_PER_MINUTE` from one reader, with `Retry-After` |
| `503` | whisper.cpp did not answer, or `STT_PROVIDER=off` |

The audio is never written to disk and never logged. One line is logged per
recording — `{"seconds":9.8,"bytes":312364,"chars":147,"ms":448}` — and the
words are not in it.

Whisper writes something even when it hears nothing: given silence it
produces one of a few stock phrases ("you", "Thank you.", "[BLANK_AUDIO]")
learnt from the end of its training clips. A transcript that is only filler
is treated as nothing heard, so a mis-press inserts nothing.

`GET /ai/health` reports `speech.enabled`, and the panel shows no
microphone at all when it is false. That is not just the setting: the
service also checks that whisper.cpp answers, cached for 30 seconds, so a
half-finished setup never shows a button that cannot work.

### HTTPS in production

Browsers only allow microphone access in a secure context. `localhost` and
`127.0.0.1` count as secure, which is why dictation works in development
over plain HTTP, but any other hostname does not: on a real address the
wiki has to be served over HTTPS or the microphone button will be there and
`getUserMedia` will refuse. The panel says so plainly when it happens
("The browser blocked the microphone"), but the fix is a certificate.

## MCP: the wiki as a tool for agents

`POST /ai/mcp` speaks MCP over Streamable HTTP, built on the official
TypeScript SDK (`@modelcontextprotocol/sdk`). It is reachable through the
proxy, so an agent on this Mac connects to
`http://127.0.0.1:3080/ai/mcp`.

Five tools, described for an agent rather than a person. Each result carries
the page's URL — a search hit links straight to the section that matched, or
to the page of a PDF — so an agent can cite what it used. Search covers
uploaded files as well as pages; a file result is marked `"kind":
"document"` and says where in the file the match is.

| Tool | What it does |
| ---- | ------------ |
| `search_wiki(query, limit?)` | The same hybrid index search the panel uses, with snippets. |
| `get_page(path, locale?)` | One page as Markdown, with title, path, URL and last-updated date; a very long page is cut and says so. |
| `get_document(path)` | One uploaded file as text, each part headed with where in the file it came from. |
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

## Running it in production

Everything above describes development: `tsx watch`, Vite's dev server,
`ai/.env`, and the proxy on `127.0.0.1:3080`.

Production is a separate stack in [`deploy/`](../deploy/README.md) —
its own containers, wiki database, index, settings file and API keys, on
`http://localhost:8088`, with the chat app served as built files by this
service rather than by Vite. The two run side by side and share only
Ollama and whisper.cpp. `deploy/SWITCHOVER.md` is the plan for moving the
installed wiki onto it.

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

A tool call is how a card reaches the panel. The name has to be one of
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
