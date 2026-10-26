#!/bin/bash
# The monthly restore drill.
#
# Takes the newest backup, restores it into a throwaway Postgres, counts
# what came back and says whether it is believable. It touches nothing
# that is running: production is not stopped, not written to, and not
# connected to except to ask it how many rows it has.
#
#   deploy/drill.sh                 # the newest dump in ~/Backups/wiki-rag
#   deploy/drill.sh <dump file>     # a particular one
#
# Exit code 0 means the backup would restore. Anything else means look at
# it now rather than on the day you need it.
#
# This deliberately does not call restore.sh: a drill that depends on the
# script it is drilling tells you nothing when that script is the thing
# that broke. What it cannot rehearse is `restore.sh --into-production`,
# which writes over the live database — that path is only ever exercised
# for real.
set -euo pipefail

DEST="${BACKUP_DIR:-$HOME/Backups/wiki-rag}"
DB_USER="${WIKI_DB_USER:-wikijs}"
DB_NAME="${WIKI_DB_NAME:-wiki}"
LIVE_DB="${WIKI_DB_CONTAINER:-wiki-prod-db}"
MEDIA_DIR="${MEDIA_HOST_DIR:-$HOME/Media/wiki}"
MEDIA_MIRROR="${MEDIA_BACKUP_DIR:-$DEST/media}"
# A wiki that has lost this much since the backup was taken is not a
# wiki anyone wants restored without looking first.
TOLERANCE_PERCENT="${DRILL_TOLERANCE_PERCENT:-10}"

# The throwaway has to be able to read the dump, and pg_restore cannot
# read an archive written by a newer pg_dump. So: whatever production is
# running, when it is running, and the version in docker-compose.prod.yml
# otherwise.
if [ -z "${DRILL_POSTGRES_IMAGE:-}" ]; then
  DRILL_POSTGRES_IMAGE="$(docker inspect --format '{{.Config.Image}}' "${WIKI_DB_CONTAINER:-wiki-prod-db}" 2>/dev/null || true)"
  [ -n "$DRILL_POSTGRES_IMAGE" ] || DRILL_POSTGRES_IMAGE=postgres:16-alpine
fi

fail () { echo "drill: FAILED — $1" >&2; exit 1; }

dump="${1:-}"
if [ -z "$dump" ]; then
  dump="$(ls -1t "$DEST"/wiki-*.dump 2>/dev/null | head -1 || true)"
  [ -n "$dump" ] || fail "there are no dumps in $DEST. Has deploy/backup.sh ever run?"
fi
[ -f "$dump" ] || fail "no such dump: $dump"

age_hours=$(( ( $(date +%s) - $(stat -f %m "$dump" 2>/dev/null || stat -c %Y "$dump") ) / 3600 ))
echo "drill: $(basename "$dump") — $(du -h "$dump" | cut -f1), ${age_hours}h old"
if [ "$age_hours" -gt 48 ]; then
  echo "drill: WARNING — the newest backup is ${age_hours} hours old; is the launch agent loaded?"
fi

# ── restore it somewhere harmless ───────────────────────────────────
name="wiki-drill-$$"
cleanup () { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "drill: restoring into a throwaway $DRILL_POSTGRES_IMAGE"
docker run -d --rm --name "$name" \
  -e POSTGRES_USER="$DB_USER" \
  -e POSTGRES_PASSWORD=drill \
  -e POSTGRES_DB="$DB_NAME" \
  "$DRILL_POSTGRES_IMAGE" >/dev/null

waited=0
until docker exec "$name" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; do
  sleep 1
  waited=$((waited + 1))
  [ "$waited" -lt 60 ] || fail "the throwaway Postgres never came up"
done

started=$(date +%s)
if ! docker exec -i "$name" pg_restore -U "$DB_USER" -d "$DB_NAME" \
     --no-owner --no-privileges < "$dump" 2>/tmp/drill-restore.$$; then
  sed 's/^/drill:   /' /tmp/drill-restore.$$ >&2
  hint=""
  if grep -q 'unsupported version' /tmp/drill-restore.$$; then
    hint=" — the dump was written by a newer pg_dump than $DRILL_POSTGRES_IMAGE can read; set DRILL_POSTGRES_IMAGE to match the database the dump came from"
  fi
  rm -f /tmp/drill-restore.$$
  fail "pg_restore could not read the dump$hint"
fi
rm -f /tmp/drill-restore.$$
echo "drill: restored in $(( $(date +%s) - started ))s"

# `set -o pipefail` means a psql that fails would kill the script with no
# message at all, so a missing table has to come back as an empty string
# and be reported by the checks below.
count () {
  { docker exec "$name" psql -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT count(*) FROM $1;" 2>/dev/null || true; } | tr -d ' \r'
}

videos_in () {
  [ -d "$1" ] || { echo 0; return; }
  { find "$1" -type f \( -name '*.mp4' -o -name '*.mov' -o -name '*.m4v' -o -name '*.webm' \) 2>/dev/null || true; } |
    wc -l | tr -d ' '
}

pages="$(count pages)"
assets="$(count '"assetData"')"
users="$(count users)"
settings="$(count settings)"
newest="$({ docker exec "$name" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  'SELECT coalesce(max("updatedAt")::text, '"'"'none'"'"') FROM pages;' 2>/dev/null || true; } | tr -d ' \r')"

printf 'drill:   pages %s, assets %s, users %s, settings %s\n' "$pages" "$assets" "$users" "$settings"
printf 'drill:   newest page in the dump: %s\n' "$newest"

# ── is it believable? ───────────────────────────────────────────────
[ -n "$pages" ] && [ -n "$users" ] && [ -n "$settings" ] || fail "the restored database has no pages, users or settings table"
[ "$pages" -ge 1 ]    || fail "the dump has no pages"
[ "$users" -ge 1 ]    || fail "the dump has no users"
[ "$settings" -ge 1 ] || fail "the dump has no settings"

# Against the live wiki, when it is running. A dump taken while something
# was wrong can restore perfectly and still be missing half the wiki.
if docker inspect "$LIVE_DB" >/dev/null 2>&1; then
  live_pages="$(docker exec "$LIVE_DB" psql -U "$DB_USER" -d "$DB_NAME" -tAc 'SELECT count(*) FROM pages;' 2>/dev/null | tr -d ' \r' || echo '')"
  live_users="$(docker exec "$LIVE_DB" psql -U "$DB_USER" -d "$DB_NAME" -tAc 'SELECT count(*) FROM users;' 2>/dev/null | tr -d ' \r' || echo '')"
  if [ -n "$live_pages" ]; then
    printf 'drill:   live wiki now: pages %s, users %s\n' "$live_pages" "$live_users"
    floor=$(( live_pages - (live_pages * TOLERANCE_PERCENT / 100) - 1 ))
    [ "$pages" -ge "$floor" ] || fail "the dump has $pages page(s) and the live wiki has $live_pages — more than ${TOLERANCE_PERCENT}% missing"
  fi
else
  echo "drill:   production is not running, so there is nothing to compare against"
fi

# ── the videos, which are not in the dump at all ────────────────────
if [ -d "$MEDIA_DIR" ]; then
  live_videos="$(videos_in "$MEDIA_DIR")"
  mirror_videos="$(videos_in "$MEDIA_MIRROR")"
  printf 'drill:   videos: %s in %s, %s in the mirror\n' "$live_videos" "$MEDIA_DIR" "$mirror_videos"
  if [ "$live_videos" -gt 0 ] && [ "$mirror_videos" -lt "$live_videos" ]; then
    fail "the media mirror has $mirror_videos of $live_videos video(s) — run deploy/backup.sh"
  fi
fi

echo "drill: PASSED — $(basename "$dump") restores, and what came back looks like the wiki"
