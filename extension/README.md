# Claude Persist

Persistent Claude Code sessions that survive window reloads — chat tabs backed
by a server-side daemon. Built for code-server (VS Code in the browser), where
a page refresh normally kills any in-flight Claude session.

Refresh the page mid-generation and the turn keeps running in the daemon; the
tab replays everything it missed when it comes back.

[**Install from the VS Code Marketplace**](https://marketplace.visualstudio.com/items?itemName=jaga.claude-persist-vscode)
· [**Open VSX**](https://open-vsx.org/extension/jaga/claude-persist-vscode) (code-server, VSCodium)

## Getting started

1. **Nothing to install first**, on Linux, macOS or Windows — the runtime is
   bundled. On other platforms see Requirements below.
2. **Open the panel.** Click the Claude Persist icon in the activity bar, or the
   `✨ Claude Persist` item in the status bar, or run
   **Claude Persist: New Session** from the Command Palette.
3. **Pick a folder** when asked. That is the working directory for the session.
4. **Sign in**, if you have never used Claude Code on this machine: open the
   model pill at the bottom of the chat and choose *Log in to another account…*.
   The panel walks you through it — no terminal needed. If you already use
   Claude Code here, your existing login is picked up automatically.
5. **Type a message.** The session now survives reloads, disconnects, and
   closing the tab.

## Requirements

- **VS Code 1.85+**, or any code-server built on it.
- **A Claude account**, or `ANTHROPIC_API_KEY`.
- **Claude Code — only on platforms without a bundled build.** Builds for
  Linux (x64, arm64), macOS (Intel, Apple silicon) and Windows (x64) carry the
  Claude Code runtime and need nothing installed; your marketplace picks the
  right one automatically. Anywhere else — Alpine, ARM Windows, 32-bit — you get
  the universal build, which drives the Claude Code you already have. Install it
  from <https://claude.com/download> or with `npm i -g @anthropic-ai/claude-code`,
  then reload the window.
- **A trusted folder.** The extension runs Claude against your files, so it
  stays disabled in Restricted Mode.

## Features

- **Sessions that outlive the window.** The daemon runs detached; tabs are just
  views onto it. Reload, disconnect, or close the tab — the turn keeps going.
- **Every session, from any window.** *Claude Persist: Open Session* lists them
  all, grouped by folder, with unread markers.
- **Multiple accounts.** Sign in to several and switch from the model pill. When
  one hits its limit the daemon moves to the next and resumes on its own; when
  every account is spent it waits for the soonest reset and picks up from there.
  Turn it off with `claudePersist.switchAccountOnLimit`.
- **Subagent attribution.** When several subagents work at once, each message is
  badged with the one that wrote it.
- **Images, files, and drag-and-drop** into the chat, with inline previews.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| "Claude Code was not found on this machine" | Install Claude Code (see Requirements) and reload the window. |
| "Could not start claude-persist daemon" | Check `~/.claude-persist/daemon.log`. |
| The panel is empty and messages fail | You are probably not signed in — use *Log in to another account…* in the model pill. |
| An outdated daemon is running | The message names the pid; `kill` it and reload the window. |

Sessions and logs live in `~/.claude-persist/`. Removing that directory resets
everything.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `claudePersist.switchAccountOnLimit` | `true` | On a rate limit, rotate to the next account and resume automatically. |
| `claudePersist.defaultModel` | *(empty)* | Model new sessions start with. |
| `claudePersist.extraModels` | `[]` | Extra model ids to offer in the picker. |
| `claudePersist.connectionIndicator` | `true` | Show daemon connection state in the status bar. |
| `claudePersist.daemonEntry` | *(empty)* | Override the daemon entry point. Leave empty. |

Source, architecture notes, and issues:
<https://github.com/jagajaga/claude-persist>
