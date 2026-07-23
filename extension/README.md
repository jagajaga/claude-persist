# Claude Persist

Persistent Claude Code sessions that survive window reloads — chat tabs backed
by a server-side daemon. Built for code-server (VS Code in the browser), where
a page refresh normally kills any in-flight Claude session.

- **Claude Persist: New Session** — pick a folder, chat in a native editor tab
- **Claude Persist: Open Session** — reopen any session, from any window
- Refresh the page mid-generation: the turn keeps running in the daemon and
  the tab replays everything it missed when it comes back.

The daemon (bundled in this extension) is spawned detached on first use and
keeps sessions alive independently of VS Code. It authenticates the same way
Claude Code does (`claude /login` or `ANTHROPIC_API_KEY`).

Source and architecture notes: see the `claude-persist` repository README.
