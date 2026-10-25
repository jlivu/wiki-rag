#!/bin/bash
# Build the two production images from the current checkout.
#
#   deploy/build.sh              # build both, tag :latest and a dated tag
#   deploy/build.sh wiki         # just Wiki.js
#   deploy/build.sh ai           # just the assistant
#
# Both are built for this Mac's own architecture (arm64). Each build is
# also tagged with the date and the commit, so rolling back to the
# previous build is a matter of pointing .env.prod at that tag.
set -euo pipefail

cd "$(dirname "$0")/.."

# The upstream tag this branch is based on. Admin > System Info shows it.
# See CLAUDE.md: 2.5.316 and 2.5.317 are not tagged upstream and add no
# database changes.
WIKI_VERSION="${WIKI_VERSION:-2.5.315}"

commit="$(git rev-parse --short HEAD)"
dirty=""
if ! git diff --quiet || ! git diff --cached --quiet; then dirty="-dirty"; fi
tag="$(date +%Y%m%d)-${commit}${dirty}"
what="${1:-all}"

echo "building ${what} as ${tag} (wiki version ${WIKI_VERSION}, $(uname -m))"
[ -n "$dirty" ] && echo "  note: the working tree has uncommitted changes"

if [ "$what" = "all" ] || [ "$what" = "wiki" ]; then
  echo "── Wiki.js ───────────────────────────────────────────────"
  docker build \
    -f deploy/Dockerfile.wiki \
    --build-arg "WIKI_VERSION=${WIKI_VERSION}" \
    --build-arg "WIKI_BUILD=${commit}${dirty}" \
    -t "wiki-rag/wiki:${tag}" \
    -t "wiki-rag/wiki:latest" \
    .
fi

if [ "$what" = "all" ] || [ "$what" = "ai" ]; then
  echo "── the assistant ─────────────────────────────────────────"
  docker build \
    -f deploy/Dockerfile.ai \
    --build-arg "AI_BUILD=${commit}${dirty}" \
    -t "wiki-rag/ai:${tag}" \
    -t "wiki-rag/ai:latest" \
    .
fi

echo
echo "built:"
docker images --filter 'reference=wiki-rag/*' --format '  {{.Repository}}:{{.Tag}}  {{.Size}}  {{.CreatedSince}}' | head -6
echo
echo "to roll back to this build later, put these in deploy/.env.prod:"
echo "  WIKI_IMAGE=wiki-rag/wiki:${tag}"
echo "  AI_IMAGE=wiki-rag/ai:${tag}"
printf '%s  %s  wiki=%s ai=%s\n' "$(date -Iseconds)" "$tag" "wiki-rag/wiki:${tag}" "wiki-rag/ai:${tag}" >> deploy/build.log
