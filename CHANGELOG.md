# Changelog

## 0.3.9
- Kandinsky-style extension icon

## 0.3.8
- Rename sessions (command palette + sidebar pencil icon)
- Result line shows per-turn tokens (fresh input + output) instead of total context

## 0.3.7
- Pinned scrolling: conversation bottom stays visible while typing multiline
  input and through mobile-keyboard viewport resizes; no scroll-yank while
  reading history

## 0.3.6
- Import scanner survives multi-MB transcript lines (base64 attachments);
  prefers Claude Code summary titles

## 0.3.5
- Single inline working indicator (spinner + Working… + Stop) in the
  conversation flow

## 0.3.3–0.3.4
- Live running/idle status in the sidebar, ⏳ tab-title prefix, optimistic
  working indicator on send, inline in-chat spinner

## 0.3.2
- Bypass permissions actually works (sessions launch with the bypass
  capability); mode-switch failures surface in the transcript
- Tokens shown instead of notional dollar cost

## 0.3.1
- Protocol handshake: outdated daemons are killed and respawned automatically
  on extension upgrade
- Context ring uses the model-reported context window (1M default)

## 0.3.0
- Markdown via marked + DOMPurify (GFM tables etc.)
- File/image attachments via the composer + button
- Inline diffs for Edit/Write tool cards; clickable file paths
- Context ring with click-to-compact
- Import existing Claude Code sessions (converted + resumable)

## 0.2.0
- Webview restyled after the official Claude Code extension: document-flow
  layout, tool cards with IN/OUT, todo checklists, permission cards,
  bypass-permissions toggle

## 0.1.1
- Activity-bar sessions view: tree with click-to-open, toolbar, inline delete,
  welcome view

## 0.1.0
- Initial release: session daemon (Agent SDK, unix socket, seq-numbered event
  log with replay), chat webview tabs with reload restore, self-contained
  `.vsix` packaging
