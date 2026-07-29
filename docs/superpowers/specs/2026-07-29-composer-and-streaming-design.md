# Composer & Streaming Improvements — Design

Date: 2026-07-29
Status: approved

Five independent changes to the chat panel, the daemon's context accounting, and
the new-session flow. They share no state; each can ship alone.

1. Branch chip — show the git branch (and whether it's a worktree) for the
   session's own directory, live.
2. Streaming markdown — render markdown while text is still arriving.
3. Context accuracy — ignore subagent usage when computing context size.
4. New-session name prefill — seed the title box with `<folder>-`.
5. Merged model+effort control — one pill replacing two dropdowns.

---

## 1. Branch chip

### Why

A session is pinned to a `cwd`. That directory may be the main checkout or a
worktree, and its branch is not necessarily the branch the VS Code window is
showing. Nothing in the panel says which.

### Where the work happens

Entirely in the extension host. `PanelEntry.cwd` is already populated in
`chatPanel.ts` `attach()` from `result.info.cwd`, so no daemon call, no new
protocol message, no `PROTOCOL_VERSION` bump for this feature.

### Resolution — read git's files, don't shell out

A subprocess per panel per branch switch is wasteful and adds a failure mode
(git missing from PATH). Everything needed is on disk:

- Walk up from `cwd` until an entry named `.git` exists.
  - **Directory** → main checkout; `gitDir` is that directory.
  - **File** → worktree; its contents are `gitdir: <absolute path>`. That path
    is the worktree's own git dir, e.g. `<repo>/.git/worktrees/feature-x`.
  - Reaching the filesystem root with no `.git` → not a repo.
- Read `<gitDir>/HEAD`:
  - `ref: refs/heads/<name>` → on branch `<name>`.
  - 40-hex SHA → detached; display the first 8 characters.
  - Anything else → unreadable; treat as "no branch".

### Module boundary

New file `extension/src/gitBranch.ts`, no `vscode` import, two layers:

**Pure (unit-tested):**

```ts
export type HeadState =
  | { kind: 'branch'; name: string }
  | { kind: 'detached'; sha: string }
  | { kind: 'unknown' };

export function parseHead(contents: string): HeadState;
/** `gitdir: /path/to/.git/worktrees/x` -> `/path/to/.git/worktrees/x`; else null. */
export function parseGitFile(contents: string): string | null;
/** Display text for the chip: 'main', 'a1b2c3d4'. */
export function formatBranch(head: HeadState): string | null;
```

**I/O (thin, not unit-tested):**

```ts
export interface GitInfo { gitDir: string; headFile: string; isWorktree: boolean }
export function findGitDir(startDir: string): GitInfo | null;
export function readBranch(info: GitInfo): HeadState;
```

`findGitDir` stops at the filesystem root and at 64 levels, so a pathological
path cannot spin.

### Watching

`chatPanel.ts` gains one watcher per panel, created after `attach()` sets
`entry.cwd`:

- `fs.watch(headFile)` — the HEAD file of *that* git dir, so a worktree tracks
  its own branch rather than the main repo's.
- On any event, re-read and post to the webview only if the display text
  changed. `fs.watch` fires more than once per write; posting unconditionally
  would spam the channel.
- Some editors and git operations replace HEAD rather than writing in place,
  which kills the watch. On a `rename` event, re-establish the watcher.
- Disposed in `panel.onDidDispose`, and replaced (never stacked) if `attach()`
  runs again after a reconnect.

Failure to watch is non-fatal: the chip still shows the branch read at attach
time, it just stops updating.

### UI

New element in `#composer-row`, before `.flex-spacer`:

```html
<span id="branch-chip" class="branch-chip" hidden></span>
```

- Text is the branch name, prefixed with the glyph `⎇` (U+2387) — a text
  symbol, not an emoji, consistent with the `⧗`/`▣`/`▤`/`⚠︎` set already in use.
- Worktree: the chip gets class `wt` and a trailing `·wt` marker, so it is
  distinguishable without color alone.
- `title` carries the full path of the session's `cwd` plus, for a worktree,
  the word "worktree".
- Not a button — nothing to click. It is an indicator.
- Hidden entirely when `cwd` is not in a repo, so non-git sessions look exactly
  as they do today.
- On narrow viewports the existing `#composer-row { flex-wrap: wrap }` rule
  handles it; the chip's text is `text-overflow: ellipsis` capped at 12em so a
  long branch name cannot push the send button off-screen.

### Message

Host → webview only: `{ type: 'branch', name: string | null, worktree: boolean }`.
`name: null` hides the chip. This is a webview message, not a daemon protocol
message; it needs no version bump.

---

## 2. Streaming markdown — stable prefix, raw tail

### Why

Deltas are written as raw `textContent`, so `##` and `**` are visible until the
authoritative `assistant_text` arrives at the end of the block.

### The rule

Split the accumulated buffer in two at the last point where markdown structure
is unambiguously complete, render that prefix, and leave the rest raw.

- The boundary is the last blank line (`\n\n`) in the buffer.
- Unless that boundary is inside an open fenced code block, in which case it
  moves back to the start of the line that opened the fence, so a half-written
  fence stays raw rather than rendering as prose.
- Fence tracking follows CommonMark closely enough to be right about the cases
  assistants actually produce: a fence closes only on the *same* marker
  character, at least as long as the opener, with nothing after it. Counting
  fence-looking lines by parity is not enough — a `~~~` line inside a ` ``` `
  block is content, and treating it as a closer renders a half-written code
  block as prose.
- No blank line, or the whole buffer is one open fence → the prefix is empty and
  everything stays raw. Behaviour is then exactly today's.

The consequence that matters: **once a block renders, it never re-renders.**
Adding text to the tail cannot reflow a paragraph, list, or table that already
settled, so there is no flicker.

### Module boundary

New file `extension/media/streamingMarkdown.js` — plain script, dual-target:

```js
(function (root) {
  function splitStreamingMarkdown(text) { /* ... */ }   // -> { stable, tail }
  root.splitStreamingMarkdown = splitStreamingMarkdown;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { splitStreamingMarkdown };
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
```

In the webview it is inlined ahead of `chat.js` by `chatPanel.html()` (added to
the existing `inlineJs` array — CSS/JS must stay inlined, never linked; the file
must therefore never contain the literal `</script>`). In Node
it is `require`d directly by `extension/src/streamingMarkdown.test.ts`, which is
how the split gets unit tests despite the webview having no test harness.

The function is pure: string in, `{ stable, tail }` out, and
`stable + tail === text` for every input. That identity is itself a test.

### Preview element structure

A preview node becomes two children instead of one text node:

```html
<div class="assistant streaming">
  <div class="stable"><!-- rendered markdown --></div>
  <div class="tail"><!-- raw text, white-space: pre-wrap --></div>
</div>
```

- `chat.js` keeps the raw buffer in a `WeakMap` keyed by the preview element —
  the single source of truth. `textContent` is no longer usable for that once
  part of the node is rendered HTML, and a growing multi-KB string does not
  belong in a DOM attribute.
- Re-render is coalesced with `requestAnimationFrame`: a burst of deltas costs
  one `marked.parse`, which matters on phones.
- `.tail` is `white-space: pre-wrap` so raw text keeps its line breaks and does
  not visually jump when it later renders.

### Interaction with the v0.7.10 preview machinery

Unchanged in contract:

- `dropPreviews()` on `assistant_text` — the authoritative block still supersedes
  every preview. The final DOM after a turn is identical to a replay of the
  stored events, which is what keeps reload and live view consistent.
- `settlePreviews()` on interrupt/error/result — now reads `dataset.raw` instead
  of `textContent`, and renders the whole buffer as markdown.
- A pending animation frame is cancelled by both, so a queued render cannot
  resurrect a dropped node.

---

## 3. Context size must ignore subagents

`daemon/src/session.ts:350` assigns `lastCallUsage` from every `assistant`
message. Subagent messages (Agent tool) carry `parent_tool_use_id` and report
the *subagent's* context, not the main thread's. In practice the main thread
speaks last and overwrites the bad value before `result`, so the ring is
usually right — but the guard is one condition:

```ts
if (message?.usage && msg.parent_tool_use_id == null) this.lastCallUsage = message.usage;
```

Everything else about the ring is correct and stays: the formula
(`input + cache_read + cache_creation + output` of the final call), the
SDK-reported `contextWindow`, and updating only on `result`.

This changes daemon behaviour, so `PROTOCOL_VERSION` (shared) and
`EXPECTED_PROTOCOL` (`daemonClient.ts`) go 9 → 10, per repo convention — that is
what makes an installed extension replace a daemon still running the old code.

---

## 4. New-session name prefill

`claudePersist.newSession` currently seeds the title box with `basename(cwd)`.
Change to `` `${basename(cwd)}-` `` with `valueSelection: [len, len]`, putting
the caret after the dash with nothing selected, so typing appends instead of
replacing.

Trailing `-` and whitespace are trimmed before the session is created, so
accepting the prefix unchanged yields `claude-persist`, not `claude-persist-`.
If trimming leaves an empty string, fall back to `basename(cwd)`.

The trim rule is a pure function, `sessionTitleFromInput(raw, fallback)`, in
`extension/src/sessionTitle.ts`, unit-tested.

Dismissing the box (Escape) currently still creates a session, because the
`undefined` return collapses into the "no title" branch. With a prefilled value
that is clearly wrong: cancelling now aborts creation.

Only `newSession` is touched. Import keeps its own naming.

---

## 5. One pill for model + effort

### Why

`#composer-row` holds attach, model select, effort select, context ring,
bypass toggle, and send. Adding the branch chip makes seven. On a phone the row
already wraps. Two dropdowns for one decision is the cheapest thing to merge.

### Shape

Replace `#model-select` and `#effort-select` with:

```html
<button id="model-pill" class="pill" title="Model and reasoning effort">
  <span id="model-pill-label">default</span>
</button>
```

- Label reads `<model> · <effort>`, e.g. `opus-5 · high`. Effort omitted when
  unset: `opus-5`. Both unset: `default`.
- Clicking opens a popover above the composer, reusing the existing
  `.attach-menu` / `.menu-item` styles and its outside-click-to-close handler —
  same visual language, no new popover system.
- The popover has two labelled sections: **Model** (from the SDK-probed list,
  plus `default`) and **Effort** (the selected model's `effortLevels`, or the
  full list, plus `default`). The current choice in each carries a `✓` prefix.
- Choosing a model re-renders the effort section immediately (effort levels are
  model-dependent) and leaves the popover open; choosing an effort closes it.
  Model-then-effort is the common two-step, and this makes it two taps without a
  reopen.
- On narrow viewports the label truncates to the model name only.

### State and messages

Unchanged: `{ type: 'setOptions', model }` and `{ type: 'setOptions', effort }`
are posted exactly as the two `change` handlers do today. `chatPanel.ts` changes
only its `html()` markup (two `<select>`s out, one `<button>` in); its message
handling and the daemon are untouched. Current values live in two module
variables (`currentModel`, `currentEffort`) instead of being read off DOM
`select.value`; `rebuildModelOptions`/`rebuildEffortOptions` become
`setModelState`/`renderPill`.

The "keep a persisted value visible even if the SDK doesn't list it" behaviour
survives: an unlisted current model is shown in the label and appears as a
checked entry in the popover.

---

## Testing

| Change | Covered by |
|---|---|
| Branch chip | `gitBranch.test.ts` — `parseHead` (branch / detached / junk / trailing newline / `refs/heads/` with slashes), `parseGitFile` (valid / absent prefix / whitespace), `formatBranch` (8-char SHA truncation) |
| Streaming markdown | `streamingMarkdown.test.ts` — no blank line; one complete paragraph; two paragraphs; open fence swallows a blank line; closed fence then blank line; `stable + tail === input` on every case |
| New-session name | `sessionTitle.test.ts` — trailing dash, trailing spaces, dash-only input, normal input |
| Context guard | No unit test — the daemon has no harness and the change is a one-token condition. Verified by build + reading the SDK message shape. Stated as a gap, not hidden. |
| Merged pill | No unit test — webview DOM. Verified by `node --check`, build, and manual use. Same standing gap as the rest of `chat.js`. |

Every task ends with `npm run build` (all three workspaces),
`node --test extension/dist/*.test.js`, and — for any task touching
`extension/media/*.js` — `node --check` on the changed file, which is
non-negotiable after the v0.5.1 blank-webview incident.

## Non-goals

- No status-bar branch display; the chip is per-session, and the status bar is
  per-window.
- No branch switching from the panel. It is an indicator.
- No incremental markdown parser. The stable prefix is re-parsed from the start
  each frame; at assistant-message scale this is far below a frame budget.
- No change to how the ring's percentage is computed, or to when it updates.
