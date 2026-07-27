# Workspace-grouped sessions sidebar with unread dots

**Date:** 2026-07-27
**Component:** `extension/src/sessionsView.ts` (+ small additions in `extension.ts`, `chatPanel.ts`)
**Scope:** presentation only — no daemon, protocol, or webview changes; no `PROTOCOL_VERSION` bump.

## Goal

The activity-bar sessions tree currently shows a flat list of sessions. Change it to a
two-level tree: workspace groups (one per distinct session `cwd`) containing that
workspace's sessions, plus a red unread dot for sessions whose turn completed while
the user wasn't looking.

## Tree structure

- **Element type** becomes a union `WorkspaceGroup | SessionInfo`, where
  `WorkspaceGroup = { cwd: string; sessions: SessionInfo[] }`, built client-side from
  `listSessions()` (the daemon already returns sessions sorted by `lastActivityAt` desc).
- **Root level:** one group node per distinct `cwd`.
- **Group ordering:** the group whose `cwd` matches a `vscode.workspace.workspaceFolders`
  path is pinned first; remaining groups sort by their newest session's
  `lastActivityAt` desc.
- **Group node:** label = folder basename; description = session count;
  tooltip = full path; icon = `root-folder` for the current workspace, `folder` otherwise;
  `id = cwd` (stable, so VS Code remembers manual expand/collapse within the window);
  `contextValue = 'claudeWorkspaceGroup'`.
- **Expand state:** current-workspace group starts `Expanded`; all others `Collapsed`.
- **Session nodes:** unchanged from today (same label, status description, icons,
  `openSessionFromTree` command), nested under their group, sorted by
  `lastActivityAt` desc.

## Unread dot

- **Definition ("completed turns only"):** a session is unread when
  `status !== 'running'` and `lastActivityAt > seenActivityAt` (an errored turn
  counts as completed). A running session never
  shows a dot; the dot appears when a turn finishes that the user hasn't viewed,
  including turns that completed while the window was closed.
- **State:** per-session `seenActivityAt` timestamps stored in `context.globalState`
  (survive window reloads). Entries for deleted sessions are pruned on refresh.
- **Clearing:** when a session's chat tab becomes visible/focused — and on
  turn-boundary (status) events received while visible — `seenActivityAt` is
  bumped past the session's current `lastActivityAt`; the tree and decorations
  refresh. (Status events only, so streaming doesn't refresh the tree per token.)
- **Rendering:** a `vscode.FileDecorationProvider` registered for a custom
  `claude-persist:` URI scheme. Session items get
  `resourceUri = claude-persist:/session/<id>`; group items
  `claude-persist:/workspace/<encoded cwd>`. Unread sessions receive badge `●`
  colored `ThemeColor('charts.red')`. A group is decorated with the same dot when any
  of its sessions is unread, so collapsed (non-current) workspaces still surface
  unread activity.
- **Refresh triggers:** the existing `sessions_changed` push → `sessionsProvider.refresh()`
  already fires on every status transition; the decoration provider fires its
  `onDidChangeFileDecorations` alongside tree refreshes.

## Edge cases

- Two workspaces with the same basename: both render; tooltip (full path)
  disambiguates.
- A single workspace still renders as a group, for consistency.
- Sessions listed before `globalState` has a `seenActivityAt` entry (fresh install /
  imported sessions) are treated as seen (`seenActivityAt` initialized to
  `lastActivityAt` on first sight) so the sidebar doesn't light up all-red on upgrade.

## Testing

- Extension type-check/build (`npm run compile` / package script).
- Manual in code-server: multiple workspaces; current-workspace pinning and expand
  state; running vs idle icons; dot appears when a turn completes in a hidden tab,
  propagates to a collapsed group, clears on focus; state survives a window reload.
