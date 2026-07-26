#!/usr/bin/env bash
# Make the Android on-screen keyboard resize code-server instead of covering
# it. Android Chrome defaults to `resizes-visual` (keyboard overlays the
# fixed-position workbench; nothing inside any iframe can compensate). Adding
# `interactive-widget=resizes-content` to the top-level viewport meta makes
# the keyboard shrink the layout viewport, so the whole workbench — editors,
# terminals, and Claude Persist's composer — stays visible above it.
#
# Idempotent. Re-run after every code-server upgrade (the file is replaced).
set -euo pipefail

WB="${1:-/usr/lib/code-server/lib/vscode/out/vs/code/browser/workbench/workbench.html}"

if [ ! -f "$WB" ]; then
  echo "workbench.html not found at $WB — pass the path as an argument" >&2
  exit 1
fi

if grep -q "interactive-widget=resizes-content" "$WB"; then
  echo "already patched: $WB"
  exit 0
fi

SED_EXPR='s/(<meta name="viewport" content="[^"]*)"/\1, interactive-widget=resizes-content"/'
if [ -w "$WB" ]; then
  sed -i -E "$SED_EXPR" "$WB"
else
  sudo sed -i -E "$SED_EXPR" "$WB"
fi

grep -n "viewport" "$WB"
echo "patched — hard-reload the browser tab (the HTML is cached)"
