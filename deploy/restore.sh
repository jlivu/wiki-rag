#!/bin/bash
# Restore a dump, either into a throwaway container to check it, or over
# production.
#
#   deploy/restore.sh --check  ~/Backups/wiki-rag/wiki-2026-10-26-0200.dump
#   deploy/restore.sh --into-production  <dump>
#
# --check is the one to run regularly: it starts a temporary Postgres,
# restores into it, counts what came back and throws the container away.
# It touches nothing that is running.
set -euo pipefail

mode="${1:-}"
dump="${2:-}"

if [ "$mode" != "--check" ] && [ "$mode" != "--into-production" ]; then
  echo "usage: $0 --check|--into-production <dump file>" >&2
  exit 2
fi
if [ ! -f "$dump" ]; then
  echo "restore: no such dump: $dump" >&2
  exit 2
fi

DB_USER="${WIKI_DB_USER:-wikijs}"
DB_NAME="${WIKI_DB_NAME:-wiki}"

if [ "$mode" = "--check" ]; then
  name="wiki-restore-check-$$"
  echo "restore: starting a throwaway Postgres ($name)"
  docker run -d --rm --name "$name" \
    -e POSTGRES_USER="$DB_USER" \
    -e POSTGRES_PASSWORD=restore-check \
    -e POSTGRES_DB="$DB_NAME" \
    postgres:16-alpine >/dev/null

  cleanup () { docker rm -f "$name" >/dev/null 2>&1 || true; }
  trap cleanup EXIT

  until docker exec "$name" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; do sleep 1; done

  echo "restore: restoring $(basename "$dump")"
  docker exec -i "$name" pg_restore -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges < "$dump"

  echo "restore: what came back"
  docker exec "$name" psql -U "$DB_USER" -d "$DB_NAME" -tAc "
    SELECT '  pages:    ' || count(*) FROM pages;
    SELECT '  assets:   ' || count(*) || ' (' || pg_size_pretty(coalesce(sum(length(data)), 0)) || ' of file data)' FROM \"assetData\";
    SELECT '  users:    ' || count(*) FROM users;
    SELECT '  settings: ' || count(*) FROM settings;
    SELECT '  newest page: ' || coalesce(max(\"updatedAt\")::text, 'none') FROM pages;"
  echo "restore: the dump is good; the throwaway container is being removed"
  exit 0
fi

# --into-production
cat <<WARNING
restore: this replaces everything in the production wiki database with
         the contents of $(basename "$dump").

         Take a backup first:  deploy/backup.sh
WARNING
read -r -p "Type 'restore' to go ahead: " answer
[ "$answer" = "restore" ] || { echo "restore: nothing was changed"; exit 1; }

cd "$(dirname "$0")"
echo "restore: stopping the wiki and the assistant, leaving the database up"
docker compose --env-file .env.prod -f docker-compose.prod.yml stop wiki ai caddy

echo "restore: recreating the database"
docker exec wiki-prod-db psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$DB_NAME\";"
docker exec wiki-prod-db psql -U "$DB_USER" -d postgres -c "CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\";"
docker exec -i wiki-prod-db pg_restore -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges < "$dump"

echo "restore: starting everything again"
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
echo "restore: done. Re-index from Admin > Storage > AI Assistant Index."
