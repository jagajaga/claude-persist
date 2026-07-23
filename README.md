# claude-persist

Persistent Claude Code sessions for VS Code / code-server. Chat with Claude in
native editor tabs, refresh the browser, close the laptop, come back from your
phone — the session keeps running on the server and the tab picks up where it
left off, including turns that finished while you were gone.

## Why

In code-server (VS Code in the browser), a page refresh restarts the extension
host, killing any process an extension started — which is why the official
Claude Code extension loses its session on refresh
([anthropics/claude-code#36845](https://github.com/anthropics/claude-code/issues/36845)).

This project copies VS Code's own fix for terminals (the pty host): move the
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

- **Daemon** (`daemon/`) — runs Claude sessions via the official
  `@anthropic-ai/claude-agent-sdk` (streaming input, multi-turn). Every chat
  event is sequence-numbered and appended to
  `~/.claude-persist/sessions/<id>.jsonl`. Clients attach with the last seq
  they saw and get a replay. Permission prompts block in the daemon until a
  client answers — reconnect later and the question is still waiting.
- **Extension** (`extension/`) — one webview panel (native editor tab) per
  session. A `WebviewPanelSerializer` restores the tabs after a window reload;
  each restored tab re-attaches and replays its transcript.
- **Shared** (`shared/`) — the ndjson wire protocol types.

Because the daemon is detached from the extension host, "start something and
close the window" works: the turn keeps executing with nobody attached, events
accumulate in the log, and whichever client attaches next replays them.

## Setup

```bash
npm install
npm run build
```

Authentication: the daemon uses the Claude Agent SDK, which picks up the same
credentials as Claude Code (e.g. `claude /login` or `ANTHROPIC_API_KEY`).

### Run the extension (dev / monorepo layout)

Symlink or copy the built extension into your extensions dir, e.g. for
code-server:

```bash
ln -s "$(pwd)/extension" ~/.local/share/code-server/extensions/claude-persist
```

Reload the window. Commands:

- **Claude Persist: New Session** — pick a folder, get a chat tab
- **Claude Persist: Open Session** — reopen any existing session
- **Claude Persist: Delete Session** — remove a session and its history

The extension auto-spawns the daemon on first use (detached, survives the
extension host). It finds the daemon at `../daemon/dist/main.js` relative to
the extension folder; override with the `claudePersist.daemonEntry` setting.

### Optional: run the daemon under systemd

The daemon is self-spawning, but a user unit makes it survive server reboots:

```ini
# ~/.config/systemd/user/claude-persist.service
[Unit]
Description=claude-persist session daemon

[Service]
ExecStart=/usr/bin/node %h/code-workspace/claude-persist/daemon/dist/main.js
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now claude-persist
```

## Status / roadmap

Working MVP: multi-session chat tabs, streaming text, tool-use cards,
permission prompts, interrupt, replay-on-reload, resume across daemon
restarts (via the SDK's `resume`).

Not yet: markdown rendering, permission "always allow" rules, session rename,
mobile-tuned layout, packaging as a `.vsix` with the daemon bundled.

## License

MIT
