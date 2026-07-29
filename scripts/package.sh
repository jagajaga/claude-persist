#!/usr/bin/env bash
# Build a self-contained .vsix: extension + daemon + Claude Agent SDK runtime.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build

# Assemble the bundled daemon inside the extension folder. The extension's
# daemon-entry resolution falls back to <extension>/daemon/dist/main.js.
rm -rf extension/daemon
mkdir -p extension/daemon/node_modules/@claude-persist/shared \
         extension/daemon/node_modules/@anthropic-ai

cp -r daemon/dist extension/daemon/dist
cat > extension/daemon/package.json <<'EOF'
{
  "name": "claude-persist-daemon-bundle",
  "private": true,
  "type": "module"
}
EOF

# Shared protocol package (runtime constant + types)
cp shared/package.json extension/daemon/node_modules/@claude-persist/shared/
cp -r shared/dist extension/daemon/node_modules/@claude-persist/shared/dist

# Agent SDK + the platform runtime package it spawns.
#
# Each platform package carries a ~260 MB native `claude` binary, so copying
# every one of them doubled the download for no benefit: a given host runs
# exactly one. Default to glibc linux-x64, which is what code-server's official
# images use. Override for other hosts, e.g. Alpine:
#   CP_SDK_PLATFORMS="claude-agent-sdk-linux-x64-musl" ./scripts/package.sh
cp -r node_modules/@anthropic-ai/claude-agent-sdk \
      extension/daemon/node_modules/@anthropic-ai/
platforms="${CP_SDK_PLATFORMS:-claude-agent-sdk-linux-x64}"
for name in $platforms; do
  src="node_modules/@anthropic-ai/${name}"
  if [ ! -d "$src" ]; then
    echo "error: platform package not installed: $src" >&2
    exit 1
  fi
  cp -r "$src" extension/daemon/node_modules/@anthropic-ai/
done

version=$(node -p "require('./extension/package.json').version")
out="claude-persist-${version}.vsix"
(cd extension && npx --yes @vscode/vsce package --no-dependencies \
  --allow-missing-repository --skip-license -o "../${out}")

echo
echo "Packaged: ${out}"
du -h "${out}"
