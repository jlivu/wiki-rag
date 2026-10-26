#!/bin/bash
# Dump the production wiki database to ~/Backups/wiki-rag and keep 14
# days of dumps.
#
# One dump is the whole wiki: pages, their history, users, groups,
# settings — and the uploaded files, which Wiki.js stores in the database
# rather than on disk. The index is not backed up on purpose: it can be
# rebuilt from the wiki in a minute, and it is large.
#
# Videos are the one thing the dump does not cover, because they are not
# in the database: they sit in the media folder on this Mac. They are
# mirrored rather than dumped — one copy kept in step with rsync, not
# fourteen dated copies of files that are large and rarely change — and
# a dated manifest is written beside the dumps so it is possible to say
# which videos existed on any given day.
#
#   deploy/backup.sh            # take a dump now
#
# The launch agent in deploy/vu.gov.doft.wiki-backup.plist runs this
# daily. See "Backups" in deploy/README.md.
set -euo pipefail

CONTAINER="${WIKI_DB_CONTAINER:-wiki-prod-db}"
DB_USER="${WIKI_DB_USER:-wikijs}"
DB_NAME="${WIKI_DB_NAME:-wiki}"
DEST="${BACKUP_DIR:-$HOME/Backups/wiki-rag}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
MEDIA_DIR="${MEDIA_HOST_DIR:-$HOME/Media/wiki}"
MEDIA_DEST="${MEDIA_BACKUP_DIR:-$DEST/media}"

mkdir -p "$DEST"
stamp="$(date +%Y-%m-%d-%H%M)"
file="$DEST/wiki-$stamp.dump"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "backup: $CONTAINER is not there — is production running?" >&2
  exit 1
fi

# -Fc is the custom format: compressed, and pg_restore can read it
# selectively. Written to a temporary name first, so a dump interrupted
# half way is never mistaken for a good one.
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$file.part"

# A dump that restores to nothing is worse than no dump, because it
# looks like one. Check it before it is given a real name: the archive
# has to be readable, and it has to contain the wiki's own tables with
# their data, not just an empty schema.
bytes="$(wc -c < "$file.part" | tr -d ' ')"
if [ "$bytes" -lt 10000 ]; then
  echo "backup: FAILED — the dump is only ${bytes} bytes, which cannot be a wiki" >&2
  rm -f "$file.part"
  exit 1
fi

toc="$(docker exec -i "$CONTAINER" pg_restore -l < "$file.part" 2>/dev/null || true)"
for table in pages users settings assetData; do
  if ! printf '%s' "$toc" | grep -q "TABLE DATA public $table "; then
    echo "backup: FAILED — the dump has no data for \"$table\"" >&2
    rm -f "$file.part"
    exit 1
  fi
done

mv "$file.part" "$file"

size="$(du -h "$file" | cut -f1)"
echo "backup: $file ($size, $(printf '%s' "$toc" | grep -c 'TABLE DATA') tables with data)"

# Keep the last KEEP_DAYS days. A dump is only dropped once a newer one
# exists, so an empty backup directory never follows a failed run.
newest="$(ls -1t "$DEST"/wiki-*.dump 2>/dev/null | head -1 || true)"
if [ -n "$newest" ]; then
  find "$DEST" -name 'wiki-*.dump' -type f -mtime "+$KEEP_DAYS" -print -delete |
    sed 's/^/backup: removed /'
fi

# Anything half-written from an interrupted run.
find "$DEST" -name 'wiki-*.dump.part' -type f -mtime +1 -delete 2>/dev/null || true

count="$(ls -1 "$DEST"/wiki-*.dump 2>/dev/null | wc -l | tr -d ' ')"
echo "backup: $count dump(s) in $DEST"

# ── the videos ──────────────────────────────────────────────────────
#
# Not in the dump, because they are not in the database. One mirror,
# kept in step: a video that is deleted from the media folder is deleted
# from the mirror on the next run, so the manifest beside each dump is
# what says it was ever there.
if [ -d "$MEDIA_DIR" ]; then
  mkdir -p "$MEDIA_DEST"
  # --delete so the mirror matches, --partial so an interrupted copy of
  # a large file resumes rather than starting again.
  rsync -a --delete --partial "$MEDIA_DIR"/ "$MEDIA_DEST"/
  manifest="$DEST/media-$stamp.txt"
  ( cd "$MEDIA_DIR" && find . -type f -not -name '.*' -exec ls -l {} \; ) | sort -k9 > "$manifest"
  videos="$(grep -ciE '\.(mp4|mov|m4v|webm)$' "$manifest" || true)"
  mirrored="$(du -sh "$MEDIA_DEST" | cut -f1)"
  echo "backup: $videos video(s), $mirrored mirrored to $MEDIA_DEST"
  find "$DEST" -name 'media-*.txt' -type f -mtime "+$KEEP_DAYS" -delete 2>/dev/null || true
else
  echo "backup: no media folder at $MEDIA_DIR — nothing to mirror"
fi
