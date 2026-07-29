#!/usr/bin/env bash
# Publish a built .vsix to Open VSX, the marketplace code-server queries by
# default. CI does this automatically on every release (see
# .github/workflows/auto-release.yml); this script is for publishing by hand —
# a re-publish, or a version built locally.
#
# The token is read from a file rather than the environment or an argument, so
# it never lands in shell history or `ps` output. Create it at
# https://open-vsx.org (Eclipse account + signed Publisher Agreement) and store
# it with:
#
#   install -d -m 700 ~/.config/ovsx
#   printf '%s' 'ovsxat_...' > ~/.config/ovsx/token && chmod 600 ~/.config/ovsx/token
#
# Usage: scripts/publish-ovsx.sh [path/to/extension.vsix]
#        (defaults to the newest claude-persist-*.vsix in the repo root)
set -euo pipefail

TOKEN_FILE="${OVSX_TOKEN_FILE:-$HOME/.config/ovsx/token}"

if [ ! -r "$TOKEN_FILE" ]; then
  echo "No Open VSX token at $TOKEN_FILE" >&2
  echo "See the comment at the top of this script for how to create one." >&2
  exit 1
fi

# A token that is group- or world-readable is a token you should assume leaked.
perms=$(stat -c '%a' "$TOKEN_FILE")
case "$perms" in
  600|400) ;;
  *) echo "Refusing to use $TOKEN_FILE: mode $perms, expected 600." >&2; exit 1 ;;
esac

VSIX="${1:-}"
if [ -z "$VSIX" ]; then
  VSIX=$(ls -t claude-persist-*.vsix 2>/dev/null | head -1 || true)
fi
if [ -z "$VSIX" ] || [ ! -f "$VSIX" ]; then
  echo "No .vsix given and none found in $(pwd)." >&2
  echo "Build one first: ./scripts/package.sh" >&2
  exit 1
fi

echo "Publishing $VSIX to Open VSX…"
# ovsx reads OVSX_PAT from the environment; scoped to this command only.
OVSX_PAT="$(cat "$TOKEN_FILE")" npx --yes ovsx publish "$VSIX"

echo
echo "Published. Open VSX indexes asynchronously — it can take a few minutes to"
echo "appear at https://open-vsx.org/extension/jaga/claude-persist-vscode"
