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
   "Claude Persist" item in the status bar, or run
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

### Sessions

- **Reload-proof.** Turns keep executing with no client attached. Reload the
  window mid-generation and the tab replays everything it missed, tool calls
  included.
- **Native editor tabs**, restored after a window reload, plus an activity-bar
  sidebar listing every session grouped by folder, with live running/idle state
  and unread markers.
- **Any session, from any window.** The daemon is per-user, not per-window.
- **Survives its own upgrades.** A turn in flight when the daemon restarts is
  queued and resumed rather than lost.
- **Import existing Claude Code sessions** from `~/.claude` and continue them
  with their full context.
- **Rename and delete** sessions; long histories load a window at a time with
  "load earlier".

### The chat

- **Claude Code look and feel** — streaming markdown, collapsible tool cards
  with IN/OUT, inline diffs for Edit and Write, todo checklists, and clickable
  file paths that open in the editor.
- **Permissions** — Allow/Deny cards that survive a reload, plus a
  bypass-permissions toggle you can flip mid-turn.
- **Questions** — AskUserQuestion renders as option cards with a free-text
  fallback.
- **Nothing gets lost.** An unanswered question or permission request stays
  pinned beside the composer while the conversation keeps scrolling.
- **Jump back through the conversation.** A sticky bar names the exchange you
  are reading and follows you as you scroll; tap it for a list of every message
  in the loaded history and jump to one.
- **Context ring** — live context usage against the model's real window. Click
  to compact the conversation.
- **Model and reasoning-effort picker**, per session.
- **Interrupt** a running turn; per-turn token counts, cost, and duration; a
  live elapsed timer while Claude works.
- **Git branch and worktree** shown beside the composer.
- **Offline is visible**, not silent: the panel dims and reconnects by itself.

### Attachments

- **Images** embed as vision blocks; other files attach as path references.
- **Drag and drop, paste, or pick** — large files upload in chunks with
  progress.
- **Inline previews** with a full-size lightbox, including for image paths you
  simply type or that a tool returns.

### Accounts and rate limits

- **Several accounts**, switched from the model pill.
- **Sign in inside the editor** — a link and a box for the code. No terminal,
  and it works over code-server where a callback to `localhost` cannot.
- **Sign in to the default account or a named one**; accounts with no
  credentials are labelled rather than silently failing.
- **Rate limits in the status bar**, with the reset time in the tooltip.
- **Automatic rotation.** Hit a limit and the turn is parked, the next account
  is activated, and the conversation resumes on its own. If every account is
  spent it waits for the soonest reset and resumes then. You do not have to
  come back and restart it.
- **Transcripts follow you** between accounts, so a switch mid-conversation
  continues rather than starting over.
- **One set of rules.** `CLAUDE.md` and skills are shared across every account.

### Subagents

- **A live count** beside the composer while subagents are working.
- **Click it for the list**, and stop any one of them individually.
- **Every message is badged** with the subagent that wrote it, colour-coded, so
  parallel agents writing into one transcript stay legible.

### On a phone or tablet

- **Enter makes a new line** on a touch keyboard, where it is the only key that
  can; Cmd/Ctrl+Enter sends. On a desktop keyboard Enter sends as usual.
- **Swipe** left and right to move between editor tabs.
- The composer stays in view while the on-screen keyboard is up.

### Commands

`Claude Persist: New Session`, `Open Session`, `Add Account (Sign In)`,
`Import Claude Code Session`, `Rename Session`, `Delete Session`,
`Refresh Sessions` — all under the "Claude Persist" category in the Command
Palette.

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
