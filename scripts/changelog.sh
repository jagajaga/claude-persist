#!/usr/bin/env bash
# Generate extension/CHANGELOG.md from git history, so VS Code's Extensions
# view shows a Changelog tab that is always current.
#
# Written rather than hand-maintained because releases are automatic: a manual
# changelog in this repo drifted from 0.3.9 to 0.7.20 without anyone noticing.
#
# Usage: scripts/changelog.sh [version-count]   (default 3)
set -euo pipefail
cd "$(dirname "$0")/.."

count="${1:-3}"
out="extension/CHANGELOG.md"

# Newest first, ordered by version rather than by tag date — a re-tagged or
# back-dated release must not jump the queue.
mapfile -t tags < <(git tag --list 'v*' --sort=-version:refname | head -n "$count")

if [ ${#tags[@]} -eq 0 ]; then
  echo "no v* tags found; leaving $out alone" >&2
  exit 0
fi

{
  echo "# Changelog"
  for i in "${!tags[@]}"; do
    tag="${tags[$i]}"
    date=$(git log -1 --format=%ad --date=short "$tag")
    echo
    echo "## ${tag#v} — $date"
    echo
    # Range starts at the previous tag by version order, which is the tag after
    # this one in our descending list. For the oldest entry we have no previous
    # tag in the window, so fall back to that tag's immediate parent.
    prev=$(git tag --list 'v*' --sort=-version:refname | sed -n "$((i + 2))p")
    range="${prev:+$prev..}$tag"
    [ -z "$prev" ] && range="$tag~1..$tag"
    # Drop the bot's own version-bump commits: they are bookkeeping, not news.
    git log --no-merges --format='- %s' "$range" \
      | grep -v '^- chore(extension): [0-9]' \
      || echo "- no user-visible changes"
  done
  echo
  echo "Older history: https://github.com/jagajaga/claude-persist/releases"
} > "$out"

echo "wrote $out (${#tags[@]} versions)"
