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
# The daemon's compiled tests are dead weight in a release: never loaded, and
# .vscodeignore cannot reach them (its node_modules/** rule matches only the
# extension root, which is also why the bundled runtime survives packaging).
rm -f extension/daemon/dist/*.test.js extension/daemon/dist/*.test.d.ts \
      extension/daemon/dist/*.test.js.map
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

# Agent SDK, and optionally the native runtime it spawns.
#
# Each platform package carries a ~300 MB native `claude`, and the SDK ships one
# per platform. Bundling all of them would mean a ~2 GB download for everyone to
# use one; bundling only the build host's meant every macOS, Windows and ARM
# user downloaded 105 MB of a Linux binary and then failed on their first turn.
#
# So there are two kinds of build:
#
#   CP_SDK_PLATFORMS=none   lean, no native binary. Runs against the Claude Code
#                           the user already has (see daemon/src/claudeExecutable.ts).
#                           This is the universal vsix — every platform can install
#                           it, and it is ~1 MB rather than ~105 MB.
#
#   CP_SDK_PLATFORMS=<pkg>  bundles that platform package, for a vsix published
#                           with a matching --target. A user on that platform
#                           needs nothing installed at all.
#
# Marketplaces hand a platform-specific build to the platforms it targets and
# the universal one to everybody else, so publishing both covers every machine
# without multiplying the download.
cp -r node_modules/@anthropic-ai/claude-agent-sdk \
      extension/daemon/node_modules/@anthropic-ai/
# The SDK package that matches CP_TARGET. Derived rather than passed in, so
# the target triple is stated once and cannot disagree with the binary inside.
sdk_package_for() {
  case "$1" in
    linux-x64)     echo claude-agent-sdk-linux-x64 ;;
    linux-arm64)   echo claude-agent-sdk-linux-arm64 ;;
    alpine-x64)    echo claude-agent-sdk-linux-x64-musl ;;
    alpine-arm64)  echo claude-agent-sdk-linux-arm64-musl ;;
    darwin-x64)    echo claude-agent-sdk-darwin-x64 ;;
    darwin-arm64)  echo claude-agent-sdk-darwin-arm64 ;;
    win32-x64)     echo claude-agent-sdk-win32-x64 ;;
    "")            echo none ;;
    *)             echo "error: no SDK runtime known for target '$1'" >&2; exit 1 ;;
  esac
}
platforms="${CP_SDK_PLATFORMS:-$(sdk_package_for "${CP_TARGET:-}")}"
if [ "$platforms" = "none" ]; then
  echo "Packaging without a native runtime (uses the user's Claude Code install)"
else
  for name in $platforms; do
    src="node_modules/@anthropic-ai/${name}"
    if [ ! -d "$src" ]; then
      echo "error: platform package not installed: $src" >&2
      echo "hint: npm install --force --no-save @anthropic-ai/${name}@\$(node -p \
        \"require('./package.json').dependencies['@anthropic-ai/claude-agent-sdk'].replace(/[^0-9.]/g,'')\")" >&2
      exit 1
    fi
    cp -r "$src" extension/daemon/node_modules/@anthropic-ai/
    # vsce's zip does not always carry the unix mode through, and a claude
    # without +x fails with EACCES from a daemon whose stdio is discarded --
    # invisible except in ~/.claude-persist/daemon.log.
    chmod +x "extension/daemon/node_modules/@anthropic-ai/${name}"/claude* 2>/dev/null || true
  done
fi

version=$(node -p "require('./extension/package.json').version")
# CP_TARGET is a vsce/Open VSX target triple (linux-x64, darwin-arm64, win32-x64,
# alpine-x64 ...). Empty means the universal build, which every platform can install.
target="${CP_TARGET:-}"
if [ -n "$target" ]; then
  out="claude-persist-${version}-${target}.vsix"
  set -- --target "$target"
else
  out="claude-persist-${version}.vsix"
  set --
fi
(cd extension && npx --yes @vscode/vsce package --no-dependencies "$@" -o "../${out}")

# The native binary is useless without +x, and a claude that cannot be executed
# fails with EACCES from a daemon whose stdio is discarded -- invisible except
# in ~/.claude-persist/daemon.log. Cheaper to catch here than in a bug report.
if [ "$platforms" != "none" ]; then
  for name in $platforms; do
    case "$name" in
      *win32*) continue ;;  # Windows has no mode bit to lose
    esac
    if ! unzip -Z "$out" "extension/daemon/node_modules/@anthropic-ai/${name}/claude" \
         2>/dev/null | grep -q '^-rwx'; then
      echo "error: bundled ${name}/claude is not executable inside ${out}" >&2
      exit 1
    fi
  done
fi

echo
echo "Packaged: ${out}"
du -h "${out}"
