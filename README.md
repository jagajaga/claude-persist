<p align="center">
  <img src="extension/media/ext-icon.png" width="128" alt="Claude Persist icon">
</p>

<h1 align="center">Claude Persist</h1>

<p align="center">
  Persistent Claude Code sessions for VS Code / code-server.<br>
  Refresh the browser, close the laptop, come back from your phone —<br>
  the session keeps running on the server and the chat picks up where it left off.
</p>

---

## Why

In code-server (VS Code in the browser), a page refresh restarts the extension
host, killing any process an extension started — which is why the official
Claude Code extension loses its live session on refresh
([anthropics/claude-code#36845](https://github.com/anthropics/claude-code/issues/36845)).

Claude Persist copies VS Code's own fix for terminals (the pty host): move the
long-lived state into a **server-lifetime daemon** and make every UI layer
disposable and re-attachable.

```
browser tab            server
┌──────────────┐      ┌───────────────────────────────┐
│ webview tabs  │◄────►│ extension host (thin client)  │
│ (disposable)  │      │        │ unix socket           │
└──────────────┘      │  claude-persist daemon         │  ← owns the sessions
                       │   └─ Claude Agent SDK query()  │     (survives everything
                       └───────────────────────────────┘      except the server)
```

Every chat event is sequence-numbered and appended to
`~/.claude-persist/sessions/<id>.jsonl`. Clients attach with the last seq they
saw and get a replay — including turns that finished, and permission prompts
that are still waiting, while nobody was connected.

## Features

**Sessions**

- **Reload-proof sessions** — turns keep executing with no client attached;
  reconnect replays everything missed, mid-generation refreshes included
- **Multiple sessions as native editor tabs**, restored after window reload,
  plus an activity-bar sidebar grouped by folder with live running/idle status
  and unread markers
- **Survives daemon restarts and upgrades** — a turn in flight is queued and
  resumed rather than lost
- **Import Claude Code sessions** — converts existing `~/.claude` transcripts
  and continues them via SDK resume, with full context
- **Session rename**, delete, and windowed history with "load earlier"

**Chat**

- **Claude Code look and feel** — markdown (marked + DOMPurify), collapsible
  tool cards with IN/OUT, inline diffs for Edit/Write, todo checklists,
  clickable file paths that open in the editor
- **Permissions** — Allow/Deny cards that survive reloads, plus a
  bypass-permissions toggle (switchable mid-turn)
- **Questions** — AskUserQuestion option cards with a free-text fallback
- **Pinned prompts** — an unanswered question or permission stays beside the
  composer while the conversation continues
- **Prompt bar** — a sticky header naming the exchange you are reading; tap for
  a jump list of every message in the loaded window
- **Context ring** — live context usage vs the model's real window; click to
  compact the conversation
- **Model and reasoning-effort picker**, per-turn token counts, cost, duration,
  interrupt/stop, git branch and worktree chip, visible offline/reconnect state

**Attachments**

- Images embed as vision blocks, other files attach as path references
- Drag-and-drop, clipboard paste, or file picker, with chunked upload progress
- Inline thumbnails and a lightbox, including for image paths in message text

**Accounts and rate limits**

- **Multiple accounts** switched from the model pill, with in-editor sign-in —
  a link and a code box, no terminal, and no `localhost` callback
- **Rate limits in the status bar** with reset times
- **Automatic rotation and resume** — on a limit the turn is parked, the next
  account is activated, and the conversation continues on its own; when every
  account is spent it waits for the soonest reset
- **Transcripts sync between accounts**, so switching mid-conversation resumes
  rather than restarting
- **`CLAUDE.md` and skills shared** across every account

**Subagents**

- Live count beside the composer, a list of what is running, and a stop button
  per subagent
- Every message badged with the subagent that wrote it, colour-coded, so
  parallel agents writing into one transcript stay legible

**Mobile**

- Enter makes a new line on touch keyboards (Cmd/Ctrl+Enter sends); Enter sends
  on a desktop keyboard
- Swipe between editor tabs; the composer stays visible above the on-screen
  keyboard

**Auth**

- **Subscription auth** — uses the same login as Claude Code, or
  `ANTHROPIC_API_KEY`; on Claude Pro/Max there are no API charges

## Install

Grab `claude-persist-<version>.vsix` from
[Releases](https://github.com/jagajaga/claude-persist/releases) and:

```bash
code-server --install-extension claude-persist-<version>.vsix
# or in desktop VS Code: Extensions → … → Install from VSIX
```

Reload the window, click the Claude Persist icon in the activity bar, and
create a session. The daemon starts automatically (detached from VS Code) and
self-replaces on extension upgrades.

Search **Claude Persist** in the Extensions view — the extension is on both
registries, [the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jaga.claude-persist-vscode)
(desktop VS Code) and [Open VSX](https://open-vsx.org/extension/jaga/claude-persist-vscode)
(code-server, VSCodium), and your editor picks the build for your machine.

Every release publishes one `.vsix` per platform, each built on that platform:
**linux-x64**, **linux-arm64**, **darwin-x64**, **darwin-arm64** and
**win32-x64** bundle the Claude Agent SDK runtime (~100 MB, nothing to install),
and a **universal** build (~1 MB) carries no runtime and drives whatever Claude
Code is already installed. Marketplaces hand each machine the build that targets
it and everyone else the universal one, so Alpine, ARM Windows and anything else
still works — with Claude Code installed separately.

To build one yourself, `CP_TARGET` selects the target triple and the matching
runtime; leaving it empty produces the universal build:

```sh
CP_TARGET=darwin-arm64 ./scripts/package.sh   # bundles the macOS arm64 runtime
CP_SDK_PLATFORMS=none  ./scripts/package.sh   # universal, no runtime
```

The runtime ships as one npm package per platform and npm installs only the
host's, so a bundled build has to run on the platform it targets — which is what
the release matrix does.

## Build from source

```bash
npm install
npm run build          # tsc for shared + daemon + extension
./scripts/package.sh   # → claude-persist-<version>.vsix
```

Requirements: Node 18+, a Claude Code login on the machine that runs the
daemon.

### Repo layout

| Path | What it is |
|---|---|
| `daemon/` | Session daemon: Agent SDK sessions, unix-socket ndjson protocol, event log, permission bridge, transcript importer |
| `extension/` | VS Code extension: daemon client, chat webview (media/), sidebar tree, panel serializer |
| `shared/` | Wire protocol types shared by both |
| `scripts/package.sh` | Builds and bundles everything into the `.vsix` |

### Mobile (Android) keyboard

Android Chrome overlays the on-screen keyboard over code-server's
fixed-position workbench (`resizes-visual` default), hiding the composer —
and no webview-side code can compensate. Run once on the server (and after
each code-server upgrade):

```bash
./scripts/fix-mobile-keyboard.sh
```

It adds `interactive-widget=resizes-content` to code-server's viewport meta
so the keyboard resizes the whole workbench. Hard-reload the browser after.

### Optional: daemon under systemd

The daemon is self-spawning, but a user unit survives server reboots:

```ini
# ~/.config/systemd/user/claude-persist.service
[Unit]
Description=claude-persist session daemon
[Service]
ExecStart=/usr/bin/node /path/to/claude-persist/daemon/dist/main.js
Restart=on-failure
[Install]
WantedBy=default.target
```

## Roadmap

Slash-command autocomplete · "always allow" permission rules · native
diff-editor integration · AI titles for imported sessions · redaction of
secrets pasted into the chat

## License

[MIT](LICENSE)
