# Claude Persist

Persistent Claude Code sessions that survive window reloads. The conversation
runs in a background process on the server — a daemon — rather than inside your
editor window, so refreshing the page, closing the tab, losing the connection or
switching to your phone does not stop it.

[Install from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jaga.claude-persist-vscode)
or [Open VSX](https://open-vsx.org/extension/jaga/claude-persist-vscode)
(code-server, VSCodium). Not affiliated with Anthropic.

![Claude Persist: sessions in the sidebar, a chat with tool cards, and the composer](https://raw.githubusercontent.com/jagajaga/claude-persist/main/extension/media/screenshot.png)

## Features

### Sessions

- **Reload-proof.** Turns keep running with no window attached. Reload
  mid-answer and the tab replays everything it missed, tool calls included.
- **Native editor tabs**, reopened after a reload, plus a sidebar listing every
  session grouped by folder with running/idle state and unread markers.
- **Any session, from any window.** One daemon per user, not per window.
- **Survives its own upgrades.** A turn in flight when the daemon restarts is
  queued and resumed, not lost.
- **Recovers from a stuck turn.** Twenty minutes of silence from Claude counts
  as a stall: the message is held and re-sent automatically, up to five
  attempts, instead of leaving you staring at a spinner.
- **Import your existing Claude Code conversations** and carry on with their
  full context.
- **Rename and delete** sessions. Long histories load a window at a time.

### The chat

- Streaming markdown, collapsible tool cards with IN/OUT, inline diffs for Edit
  and Write, todo checklists, and clickable file paths that open in the editor.
- **Permissions** — Allow/Deny cards that survive a reload, plus a
  bypass-permissions toggle you can flip mid-turn.
- **Questions** — when Claude asks you to choose, you get option cards, single
  or multi-select, with a free-text alternative.
- **Pinned prompts.** An unanswered question or permission request stays beside
  the composer while the conversation keeps scrolling, so you cannot miss it.
- **Prompt bar.** A sticky header names the exchange you are reading and
  follows you as you scroll. Tap it for a list of every message in the loaded
  history, and jump to one.
- **Context ring** — how full the context window is, against the model's real
  size. Click it to have Claude summarise the conversation so far and free the
  space back up.
- **Model and reasoning-effort picker**, per session, from the model pill —
  the button showing the current model at the bottom of the chat.
- **Interrupt** a running turn from the working row, which also shows how long
  the turn has been going. Finished turns show their duration and token count.
- **Git branch and worktrees** beside the composer: the branch name when there
  is one place, a count when subagents have taken worktrees of their own. Tap it
  for the list -- the worktrees this conversation's agents are working in, the
  branch each sits on, and which one the session itself is in.
- **Connection loss is visible.** A heartbeat runs between the tab and the
  daemon; when it stops answering, a border pulses around the chat until it
  recovers.

### Attachments

- **Images** are sent to Claude as images. PNG, JPEG, GIF and WebP up to 5 MB;
  anything larger or of another type is attached as a file path instead.
- **Add files** by dragging them in, pasting from the clipboard, or from the
  `+` menu, which can also browse files on the server. Uploads from the browser
  are chunked, show progress, and are capped at 10 MB.
- **Inline previews** with a full-size lightbox, including for image paths you
  type or that a tool returns.

### Accounts and rate limits

- **Several accounts**, switched from the model pill, each showing the limit
  that will bite it first — `5h 12%`, `7d 88%` — so you can see which has room
  before switching. Only the account in use has a live reading; the others carry
  theirs with its age, since usage can only be read from a running session.
- **Sign in inside the editor** — a link to open and a box for the code. No
  terminal, and it works over code-server, where a callback to `localhost`
  cannot.
- **Rate limits in the status bar**, with the reset time in the tooltip.
- **Automatic rotation.** Hit a limit and your message is held, the next
  account with room is activated, and the conversation resumes on its own. If every
  account is spent it waits for the soonest reset and resumes then. Accounts
  sharing one login count as one, since they share the quota.
- **Transcripts follow you** between accounts, so switching mid-conversation
  continues rather than starting over.
- **One set of rules.** Your `CLAUDE.md` and skills apply to every account.

### Subagents

- **A live count** beside the composer while subagents are working. Open it for
  the list, and stop any one of them.
- **Every message is badged** with the subagent that wrote it. Colours are
  assigned in order of appearance and stay put across a reload, so parallel
  agents writing into one transcript stay legible.

### On a phone or tablet

- **Enter makes a new line** on a touch keyboard, where it is the only key that
  can. Cmd/Ctrl+Enter sends. On a hardware keyboard Enter sends, as usual.
- **Swipe** left and right to move between editor tabs.
- The chat resizes itself to whatever the on-screen keyboard leaves visible.
  (Android plus code-server needs a one-line server-side patch as well; see the
  repository README.)

## Getting started

1. **Create a session** — the Claude Persist icon in the activity bar, or
   **Claude Persist: New Session** in the Command Palette. Pick the folder to
   work in.
2. **Sign in**, if you have never used Claude Code on this machine. Run
   **Claude Persist: Add Account (Sign In)**, or open the model pill at the
   bottom of the chat and choose *Log in to another account…* — despite the
   name, that is also how you add your first. You get a link and a box to paste
   the code into. An existing Claude Code login is picked up automatically.
3. **Type a message.**

There is also a **Get Started with Claude Persist** walkthrough in VS Code's
Welcome page.

## Requirements

- **VS Code 1.85 or newer**, or a code-server built on it.
- **A Claude account**, or `ANTHROPIC_API_KEY`. On Claude Pro or Max there are
  no API charges.
- **Claude Code itself** — but only on platforms without a bundled build:

  | Platform | What you need |
  | --- | --- |
  | Linux x64 and arm64, macOS Intel and Apple silicon, Windows x64 | Nothing. The Claude Code runtime is bundled. |
  | Anything else: Alpine, ARM Windows, 32-bit | Install Claude Code from <https://claude.com/download> or with `npm i -g @anthropic-ai/claude-code`, then reload the window. |

- **A folder you trust.** The extension runs Claude against your files, so it
  stays disabled in Restricted Mode, and in virtual workspaces where there is
  no real working directory.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `claudePersist.switchAccountOnLimit` | `true` | On a rate limit, move to the next account and resume. Applies to every session at once, and the new account starts with a cold prompt cache. |
| `claudePersist.defaultModel` | *(empty)* | Model new and imported sessions start with. |
| `claudePersist.extraModels` | `[]` | Extra model ids to offer in the picker, beyond the ones the SDK reports. |
| `claudePersist.connectionIndicator` | `true` | Pulse a border around the chat when it loses contact with the server. |
| `claudePersist.daemonEntry` | *(empty)* | Path to a daemon build, for developing this extension. Leave empty otherwise. |

## Commands

All under the **Claude Persist** category in the Command Palette:
New Session, Open Session, Add Account (Sign In), Import Claude Code Session,
Rename Session, Delete Session, Refresh Sessions.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| The extension does not appear at all | The folder is untrusted. Trust it, or open a different folder. |
| "Claude Code was not found on this machine" | Install it (see Requirements) and reload the window. |
| Messages fail and the account menu says "not signed in" | Run **Claude Persist: Add Account (Sign In)**. |
| "Could not start claude-persist daemon" | Look at `~/.claude-persist/daemon.log`, and open an issue with what it says. |
| "An outdated daemon is running" | The message names the process id. Stop it and reload the window. |

Sessions, logs and uploads live in `~/.claude-persist/`; removing it discards
your conversations. Logins live in `~/.claude` and `~/.claude-accounts` and are
not touched by that.

Chat transcripts are stored unencrypted, so treat anything you paste into a
conversation as written to disk.

Source, architecture notes and issues:
<https://github.com/jagajaga/claude-persist>
