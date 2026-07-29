# Composer & Streaming Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-session git branch chip, render markdown while text streams, fix context accounting for subagents, prefill new-session names, and merge the model and effort dropdowns into one pill.

**Architecture:** Five independent changes. Pure logic goes in its own module with `node:test` unit tests (`extension/src/*.ts`, plus one dual-target plain script in `extension/media/`); the webview and extension host consume those modules. Only one change (the subagent guard) touches the daemon.

**Tech Stack:** TypeScript (CommonJS, `tsc -p .` per workspace), plain-JS webview client, `node:test`, VS Code extension API, Node `fs`.

Spec: `docs/superpowers/specs/2026-07-29-composer-and-streaming-design.md`

## Global Constraints

- **No emoji anywhere.** Monochrome text glyphs only. The set in use is `⧗ ▣ ▤ ⚠︎ ✓ ●`; this plan adds `⎇` (U+2387).
- **All webview CSS/JS stays inlined** into the panel HTML by `chatPanel.html()`. Never add an external webview resource — code-server's service worker 404s them.
- **No file added to `inlineJs` may contain the literal `</script>`.**
- **`node --check <file>` is mandatory** after editing any file under `extension/media/`. A SyntaxError blanks the entire webview (v0.5.1 incident).
- **Commits:** subject per the `naming-commits` skill — `type(scope): lowercase imperative`. Never add a `Co-Authored-By: Claude` trailer or any AI co-author trailer.
- **Build command:** `npm run build` at the repo root (builds shared → daemon → extension).
- **Test command:** `node --test extension/dist/*.test.js`.
- Do not hand-bump `extension/package.json` `version` — CI does it on push to main.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `extension/src/gitBranch.ts` | create | Parse git `HEAD`/`.git` files; locate the git dir for a directory. No `vscode` import. |
| `extension/src/gitBranch.test.ts` | create | Unit tests for the above. |
| `extension/media/streamingMarkdown.js` | create | `splitStreamingMarkdown(text) -> {stable, tail}`. Dual-target (webview global + CommonJS). |
| `extension/src/streamingMarkdown.test.ts` | create | Unit tests for the split. |
| `extension/src/sessionTitle.ts` | create | `sessionTitleFromInput(raw, fallback)`. |
| `extension/src/sessionTitle.test.ts` | create | Unit tests for the above. |
| `extension/src/chatPanel.ts` | modify | Branch watcher + `branch` message; composer markup; inline the new media script. |
| `extension/media/chat.js` | modify | Branch chip; stable-prefix streaming; model+effort pill and popover. |
| `extension/media/chat.css` | modify | Styles for the chip, the tail, and the popover sections. |
| `extension/src/extension.ts` | modify | New-session title prefill. |
| `daemon/src/session.ts` | modify | Ignore subagent usage for context size. |
| `shared/src/protocol.ts` | modify | `PROTOCOL_VERSION` 9 → 10. |
| `extension/src/daemonClient.ts` | modify | `EXPECTED_PROTOCOL` 9 → 10. |

---

### Task 1: Git branch reader

**Files:**
- Create: `extension/src/gitBranch.ts`
- Test: `extension/src/gitBranch.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `HeadState`, `parseHead(contents: string): HeadState`, `parseGitFile(contents: string): string | null`, `formatBranch(head: HeadState): string | null`, `GitInfo { gitDir: string; headFile: string; isWorktree: boolean }`, `findGitDir(startDir: string): GitInfo | null`, `readBranch(info: GitInfo): HeadState`. Task 2 consumes `findGitDir`, `readBranch`, `formatBranch`, `GitInfo`.

- [ ] **Step 1: Write the failing tests**

Create `extension/src/gitBranch.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseHead, parseGitFile, formatBranch, findGitDir, readBranch } from './gitBranch';

test('parseHead: symbolic ref to a branch', () => {
  assert.deepEqual(parseHead('ref: refs/heads/main\n'), { kind: 'branch', name: 'main' });
});

test('parseHead: branch name containing slashes', () => {
  assert.deepEqual(parseHead('ref: refs/heads/feature/new-ui\n'), {
    kind: 'branch',
    name: 'feature/new-ui',
  });
});

test('parseHead: detached head is a raw sha', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  assert.deepEqual(parseHead(`${sha}\n`), { kind: 'detached', sha });
});

test('parseHead: junk and empty are unknown', () => {
  assert.deepEqual(parseHead(''), { kind: 'unknown' });
  assert.deepEqual(parseHead('not a head file'), { kind: 'unknown' });
  assert.deepEqual(parseHead('ref: '), { kind: 'unknown' });
});

test('parseGitFile: reads the gitdir pointer of a worktree', () => {
  assert.equal(parseGitFile('gitdir: /repo/.git/worktrees/x\n'), '/repo/.git/worktrees/x');
});

test('parseGitFile: anything else is null', () => {
  assert.equal(parseGitFile(''), null);
  assert.equal(parseGitFile('ref: refs/heads/main'), null);
  assert.equal(parseGitFile('gitdir:   '), null);
});

test('formatBranch: branch verbatim, sha truncated to 8, unknown null', () => {
  assert.equal(formatBranch({ kind: 'branch', name: 'main' }), 'main');
  assert.equal(
    formatBranch({ kind: 'detached', sha: '0123456789abcdef0123456789abcdef01234567' }),
    '01234567',
  );
  assert.equal(formatBranch({ kind: 'unknown' }), null);
});

test('findGitDir: finds a plain checkout from a nested directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-git-'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const nested = path.join(root, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });

  const info = findGitDir(nested);
  assert.ok(info);
  assert.equal(info.isWorktree, false);
  assert.equal(info.headFile, path.join(root, '.git', 'HEAD'));
  assert.deepEqual(readBranch(info), { kind: 'branch', name: 'main' });
  fs.rmSync(root, { recursive: true, force: true });
});

test('findGitDir: follows a worktree .git file to its own HEAD', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-git-'));
  const gitDir = path.join(root, '.git', 'worktrees', 'wt');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/side\n');
  const wt = path.join(root, 'wt');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`);

  const info = findGitDir(wt);
  assert.ok(info);
  assert.equal(info.isWorktree, true);
  assert.equal(info.gitDir, gitDir);
  assert.deepEqual(readBranch(info), { kind: 'branch', name: 'side' });
  fs.rmSync(root, { recursive: true, force: true });
});

test('findGitDir: returns null outside a repo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-nogit-'));
  assert.equal(findGitDir(root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('readBranch: missing HEAD file is unknown, not a throw', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-git-'));
  const info = { gitDir: root, headFile: path.join(root, 'HEAD'), isWorktree: false };
  assert.deepEqual(readBranch(info), { kind: 'unknown' });
  fs.rmSync(root, { recursive: true, force: true });
});
```

Note: `findGitDir` walks up from a temp dir. If the OS temp directory happens to
sit inside a git repository the "outside a repo" test would find that repo — in
practice `/tmp` is not a repo, and the test asserts the documented contract.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run build -w extension
```
Expected: FAIL — `error TS2307: Cannot find module './gitBranch'`.

- [ ] **Step 3: Implement**

Create `extension/src/gitBranch.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';

/**
 * Reads a repository's current branch straight off disk. No subprocess: git may
 * not be on PATH in a code-server container, and spawning per panel per branch
 * switch is wasteful when the answer is two small files.
 */
export type HeadState =
  | { kind: 'branch'; name: string }
  | { kind: 'detached'; sha: string }
  | { kind: 'unknown' };

export interface GitInfo {
  gitDir: string;
  headFile: string;
  /** True when the directory is a linked worktree with its own HEAD. */
  isWorktree: boolean;
}

const SHA_RE = /^[0-9a-f]{40}$/i;
const REFS_HEADS = 'refs/heads/';
/** Depth guard: a symlink loop must not spin the walk forever. */
const MAX_DEPTH = 64;

export function parseHead(contents: string): HeadState {
  const line = contents.trim();
  if (!line) return { kind: 'unknown' };
  if (line.startsWith('ref:')) {
    const ref = line.slice(4).trim();
    const name = ref.startsWith(REFS_HEADS) ? ref.slice(REFS_HEADS.length) : ref;
    return name ? { kind: 'branch', name } : { kind: 'unknown' };
  }
  if (SHA_RE.test(line)) return { kind: 'detached', sha: line.toLowerCase() };
  return { kind: 'unknown' };
}

/** `gitdir: <path>` — how a linked worktree points at its own git directory. */
export function parseGitFile(contents: string): string | null {
  const line = contents.trim();
  if (!line.startsWith('gitdir:')) return null;
  const dir = line.slice('gitdir:'.length).trim();
  return dir || null;
}

/** Chip text for a head state; null means "show nothing". */
export function formatBranch(head: HeadState): string | null {
  if (head.kind === 'branch') return head.name;
  if (head.kind === 'detached') return head.sha.slice(0, 8);
  return null;
}

export function findGitDir(startDir: string): GitInfo | null {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const candidate = path.join(dir, '.git');
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(candidate);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) {
      return {
        gitDir: candidate,
        headFile: path.join(candidate, 'HEAD'),
        isWorktree: false,
      };
    }
    if (stat?.isFile()) {
      let target: string | null = null;
      try {
        target = parseGitFile(fs.readFileSync(candidate, 'utf8'));
      } catch {
        target = null;
      }
      if (!target) return null;
      const gitDir = path.isAbsolute(target) ? target : path.resolve(dir, target);
      return { gitDir, headFile: path.join(gitDir, 'HEAD'), isWorktree: true };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function readBranch(info: GitInfo): HeadState {
  try {
    return parseHead(fs.readFileSync(info.headFile, 'utf8'));
  } catch {
    return { kind: 'unknown' };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm run build -w extension && node --test extension/dist/*.test.js
```
Expected: PASS, 24 tests total (13 existing + 11 new).

- [ ] **Step 5: Commit**

```bash
git add extension/src/gitBranch.ts extension/src/gitBranch.test.ts
git commit -m "feat(extension): read git branch and worktree state from disk"
```

---

### Task 2: Branch chip in the composer

**Files:**
- Modify: `extension/src/chatPanel.ts`
- Modify: `extension/media/chat.js`
- Modify: `extension/media/chat.css`

**Interfaces:**
- Consumes: `findGitDir`, `readBranch`, `formatBranch`, `GitInfo` from Task 1.
- Produces: webview message `{ type: 'branch', name: string | null, worktree: boolean, path: string }`. No later task depends on it.

There are no unit tests here: this is a `vscode`-importing host file plus webview DOM, and the repo has no harness for either. Verification is build + `node --check` + the manual check in Step 6.

- [ ] **Step 1: Add the watcher state to `PanelEntry`**

In `extension/src/chatPanel.ts`, add the import:

```ts
import { findGitDir, formatBranch, readBranch } from './gitBranch';
```

and two fields to `interface PanelEntry` (after `cwd?: string;`):

```ts
  /** Watches this session's own .git/HEAD so the branch chip tracks its cwd. */
  branchWatcher?: fs.FSWatcher;
  /** Last value pushed to the webview, so repeated fs events post once. */
  branchKey?: string;
```

- [ ] **Step 2: Add the update and watch methods**

Add both methods to `ChatPanelManager`, immediately before `private post(`:

```ts
  /** Push this session's branch to its webview, but only when it changed. */
  private updateBranch(entry: PanelEntry): void {
    const cwd = entry.cwd;
    if (!cwd) return;
    const info = findGitDir(cwd);
    const name = info ? formatBranch(readBranch(info)) : null;
    const worktree = info?.isWorktree ?? false;
    // fs.watch fires several times per write; posting unconditionally spams
    // the channel and re-renders the composer for nothing.
    const key = `${name ?? ''}|${worktree}`;
    if (entry.branchKey === key) return;
    entry.branchKey = key;
    this.post(entry, { type: 'branch', name, worktree, path: cwd });
  }

  /**
   * Watch the HEAD of the session's *own* git dir — a worktree has its own, so
   * the chip follows that directory rather than the window's repository.
   */
  private watchBranch(entry: PanelEntry): void {
    entry.branchWatcher?.close();
    entry.branchWatcher = undefined;
    if (!entry.cwd) return;
    const info = findGitDir(entry.cwd);
    if (!info) return;
    try {
      const watcher = fs.watch(info.headFile, (eventType) => {
        if (this.panels.get(entry.sessionId) !== entry) return; // panel is gone
        this.updateBranch(entry);
        // git often replaces HEAD instead of writing in place, which kills the
        // watch; re-establish it so the chip keeps updating.
        if (eventType === 'rename') {
          setTimeout(() => {
            if (this.panels.get(entry.sessionId) === entry) this.watchBranch(entry);
          }, 50);
        }
      });
      watcher.on('error', () => undefined); // non-fatal: chip just stops updating
      entry.branchWatcher = watcher;
    } catch {
      // Same: the chip keeps its attach-time value.
    }
  }
```

- [ ] **Step 3: Wire attach and dispose**

In `private async attach(entry: PanelEntry)`, immediately after the existing line
`entry.cwd = result.info.cwd;`, insert:

```ts
    // A reattach means the webview was re-created and lost its chip; force a
    // fresh post by clearing the dedupe key.
    entry.branchKey = undefined;
    this.watchBranch(entry);
    this.updateBranch(entry);
```

In `bindPanel`, replace the existing dispose handler:

```ts
    panel.onDidDispose(() => {
      this.panels.delete(sessionId);
      void this.client()?.detach(sessionId).catch(() => undefined);
    });
```

with:

```ts
    panel.onDidDispose(() => {
      this.panels.get(sessionId)?.branchWatcher?.close();
      this.panels.delete(sessionId);
      void this.client()?.detach(sessionId).catch(() => undefined);
    });
```

- [ ] **Step 4: Add the chip to the composer markup**

In `private html(...)`, inside `<div id="composer-row">`, insert this line
immediately before `<span class="flex-spacer"></span>`:

```html
        <span id="branch-chip" class="branch-chip" hidden></span>
```

- [ ] **Step 5: Render the chip in the webview**

In `extension/media/chat.js`, add to the element lookups near the top (after
the `promptBar` line):

```js
  const branchChip = document.getElementById('branch-chip');
```

Add this function just above `function renderChips(items) {`:

```js
  // Per-session branch indicator: this session's cwd, not the window's repo.
  function renderBranch(name, worktree, dir) {
    if (!name) {
      branchChip.hidden = true;
      return;
    }
    branchChip.textContent = `⎇ ${name}${worktree ? ' ·wt' : ''}`;
    branchChip.classList.toggle('wt', !!worktree);
    branchChip.title = worktree ? `${dir} (worktree)` : dir;
    branchChip.hidden = false;
  }
```

Add a case to the `window.addEventListener('message', ...)` switch, next to
`case 'models':`:

```js
      case 'branch':
        renderBranch(msg.name, msg.worktree, msg.path);
        break;
```

- [ ] **Step 6: Style the chip**

In `extension/media/chat.css`, append after the `.ring-btn.hot .ring-fg` rule:

```css
/* ---------- branch chip ----------------------------------------------------- */

.branch-chip {
  display: inline-flex;
  align-items: center;
  font-size: 0.85em;
  font-variant-numeric: tabular-nums;
  color: var(--vscode-descriptionForeground);
  border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
  border-radius: 999px;
  padding: 3px 10px;
  max-width: 12em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Dashed edge marks a worktree without relying on colour alone. */
.branch-chip.wt { border-style: dashed; }
```

- [ ] **Step 7: Verify**

```bash
node --check extension/media/chat.js
npm run build && node --test extension/dist/*.test.js
grep -c 'branch-chip' extension/media/chat.css extension/media/chat.js extension/src/chatPanel.ts
```
Expected: `node --check` silent; build clean; 24 tests pass; each grep count ≥ 1.

- [ ] **Step 8: Commit**

```bash
git add extension/src/chatPanel.ts extension/media/chat.js extension/media/chat.css
git commit -m "feat(chat): show the session's git branch in the composer"
```

---

### Task 3: Streaming markdown split function

**Files:**
- Create: `extension/media/streamingMarkdown.js`
- Test: `extension/src/streamingMarkdown.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `splitStreamingMarkdown(text): { stable: string, tail: string }`, exposed both as a global (webview) and via `module.exports` (Node). Task 4 consumes the global.

- [ ] **Step 1: Write the failing tests**

Create `extension/src/streamingMarkdown.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Plain script, loaded the same way the webview loads it. Path is relative to
// the compiled test in extension/dist/.
const { splitStreamingMarkdown } = require('../media/streamingMarkdown.js') as {
  splitStreamingMarkdown: (text: string) => { stable: string; tail: string };
};

test('no blank line yet: everything is tail', () => {
  assert.deepEqual(splitStreamingMarkdown('## Head\nsome tex'), {
    stable: '',
    tail: '## Head\nsome tex',
  });
});

test('one finished paragraph settles, the next stays raw', () => {
  assert.deepEqual(splitStreamingMarkdown('para one\n\npara tw'), {
    stable: 'para one\n\n',
    tail: 'para tw',
  });
});

test('splits at the LAST blank line, not the first', () => {
  const { stable, tail } = splitStreamingMarkdown('a\n\nb\n\nc');
  assert.equal(stable, 'a\n\nb\n\n');
  assert.equal(tail, 'c');
});

test('an open fence keeps its blank line raw', () => {
  const input = 'intro\n\n```js\nconst a = 1;\n\nconst b = 2;';
  assert.deepEqual(splitStreamingMarkdown(input), {
    stable: 'intro\n\n',
    tail: '```js\nconst a = 1;\n\nconst b = 2;',
  });
});

test('a closed fence settles with everything before it', () => {
  const input = '```js\ncode\n```\n\nafter';
  assert.deepEqual(splitStreamingMarkdown(input), {
    stable: '```js\ncode\n```\n\n',
    tail: 'after',
  });
});

test('a buffer that is nothing but an open fence stays entirely raw', () => {
  const input = '```js\nline\n\nline2';
  assert.deepEqual(splitStreamingMarkdown(input), { stable: '', tail: input });
});

test('tilde fences count too', () => {
  const input = 'x\n\n~~~\ncode\n\nmore';
  assert.deepEqual(splitStreamingMarkdown(input), {
    stable: 'x\n\n',
    tail: '~~~\ncode\n\nmore',
  });
});

test('empty and nullish inputs are safe', () => {
  assert.deepEqual(splitStreamingMarkdown(''), { stable: '', tail: '' });
  assert.deepEqual(
    splitStreamingMarkdown(undefined as unknown as string),
    { stable: '', tail: '' },
  );
});

test('stable + tail always reconstructs the input exactly', () => {
  const cases = [
    '',
    'a',
    'a\n\nb',
    'a\n\n\n\nb',
    '\n\nstart',
    '```\nx\n```\n\ny\n\n```\nz',
    'list:\n\n- one\n- two\n\ntail',
  ];
  for (const input of cases) {
    const { stable, tail } = splitStreamingMarkdown(input);
    assert.equal(stable + tail, input, `roundtrip failed for ${JSON.stringify(input)}`);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run build -w extension && node --test extension/dist/streamingMarkdown.test.js
```
Expected: FAIL — `Cannot find module '../media/streamingMarkdown.js'`.

- [ ] **Step 3: Implement**

Create `extension/media/streamingMarkdown.js`:

```js
// Splits a partially-received assistant message into the part whose markdown
// structure is already unambiguous ("stable") and the part still arriving
// ("tail"). The webview renders the stable prefix as markdown and leaves the
// tail as plain text, so finished blocks never re-flow as more text arrives.
//
// Dual-target on purpose: a global for the inlined webview, module.exports for
// the node:test suite. The webview has no test harness, so the only way this
// logic gets tested is by being reachable from Node.
(function (root) {
  var FENCE_RE = /^\s{0,3}(```|~~~)/;

  /** Start offsets of every line that opens or closes a fenced code block. */
  function fenceLineStarts(text) {
    var starts = [];
    var pos = 0;
    for (;;) {
      var nl = text.indexOf('\n', pos);
      var end = nl === -1 ? text.length : nl;
      if (FENCE_RE.test(text.slice(pos, end))) starts.push(pos);
      if (nl === -1) break;
      pos = nl + 1;
    }
    return starts;
  }

  function splitStreamingMarkdown(text) {
    var src = text == null ? '' : String(text);
    // A blank line is the one boundary markdown treats as unambiguous: no
    // later text can change how the block before it parses.
    var idx = src.lastIndexOf('\n\n');
    if (idx === -1) return { stable: '', tail: src };
    var boundary = idx + 2;
    // ...unless the boundary sits inside an unclosed fence, where a blank line
    // is just code. Back up to where that fence opened.
    var starts = fenceLineStarts(src.slice(0, boundary));
    if (starts.length % 2 === 1) boundary = starts[starts.length - 1];
    if (boundary <= 0) return { stable: '', tail: src };
    return { stable: src.slice(0, boundary), tail: src.slice(boundary) };
  }

  root.splitStreamingMarkdown = splitStreamingMarkdown;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { splitStreamingMarkdown: splitStreamingMarkdown };
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --check extension/media/streamingMarkdown.js
npm run build -w extension && node --test extension/dist/*.test.js
```
Expected: `node --check` silent; PASS, 33 tests total (24 + 9 new).

- [ ] **Step 5: Commit**

```bash
git add extension/media/streamingMarkdown.js extension/src/streamingMarkdown.test.ts
git commit -m "feat(chat): add stable-prefix split for streaming markdown"
```

---

### Task 4: Render markdown while streaming

**Files:**
- Modify: `extension/src/chatPanel.ts` (inline the new script)
- Modify: `extension/media/chat.js`
- Modify: `extension/media/chat.css`

**Interfaces:**
- Consumes: the `splitStreamingMarkdown` global from Task 3.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Inline the script ahead of chat.js**

In `extension/src/chatPanel.ts` `html()`, replace:

```ts
    const inlineJs = [media('vendor', 'marked.js'), media('vendor', 'purify.min.js'), media('chat.js')];
```

with:

```ts
    const inlineJs = [
      media('vendor', 'marked.js'),
      media('vendor', 'purify.min.js'),
      media('streamingMarkdown.js'),
      media('chat.js'),
    ];
```

- [ ] **Step 2: Replace the preview machinery in chat.js**

In `extension/media/chat.js`, replace this whole block (the `previewEls`
declaration through the end of `settlePreviews`, currently lines 187–215):

```js
  let previewEls = [];

  function endStreaming() {
    if (streamingEl) {
      streamingEl.classList.remove('streaming');
      streamingEl = null;
    }
  }

  /** Drop preview fragments superseded by an authoritative assistant_text. */
  function dropPreviews() {
    for (const node of previewEls) node.remove();
    previewEls = [];
    streamingEl = null;
  }

  /**
   * Turn ended without an authoritative assistant_text (interrupt, error).
   * Render what streamed rather than discarding the user's text.
   */
  function settlePreviews() {
    for (const node of previewEls) {
      const text = node.textContent;
      if (text && text.trim()) node.replaceChildren(renderMarkdown(text));
      else node.remove();
    }
    previewEls = [];
    streamingEl = null;
  }
```

with:

```js
  let previewEls = [];
  // The raw buffer is the source of truth: once part of a preview is rendered
  // HTML, its textContent no longer round-trips. A WeakMap keeps a growing
  // multi-KB string out of the DOM.
  const previewRaw = new WeakMap();  // node -> accumulated raw text
  const previewStable = new WeakMap(); // node -> length of prefix already rendered
  let renderFrame = 0;

  function makePreview() {
    const node = el('div', 'assistant streaming');
    node.appendChild(el('div', 'stable'));
    node.appendChild(el('div', 'tail'));
    previewRaw.set(node, '');
    previewStable.set(node, -1);
    return node;
  }

  function appendPreviewText(node, text) {
    previewRaw.set(node, (previewRaw.get(node) || '') + text);
    scheduleRender();
  }

  function scheduleRender() {
    // Coalesce a burst of deltas into one parse — this is what keeps the
    // markdown re-render off the critical path on phones.
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(renderPreviews);
  }

  function cancelRender() {
    if (renderFrame) {
      cancelAnimationFrame(renderFrame);
      renderFrame = 0;
    }
  }

  function renderPreviews() {
    renderFrame = 0;
    for (const node of previewEls) {
      const raw = previewRaw.get(node) || '';
      const split = splitStreamingMarkdown(raw);
      const stableEl = node.firstChild;
      const tailEl = node.lastChild;
      // The stable prefix only ever grows, so equal length means equal text —
      // and re-parsing settled markdown is exactly the flicker we're avoiding.
      if (previewStable.get(node) !== split.stable.length) {
        if (split.stable) stableEl.replaceChildren(renderMarkdown(split.stable));
        else stableEl.replaceChildren();
        previewStable.set(node, split.stable.length);
      }
      tailEl.textContent = split.tail;
    }
    keepWorkingLast();
    if (pinned) scrollToBottom();
  }

  function endStreaming() {
    if (streamingEl) {
      streamingEl.classList.remove('streaming');
      streamingEl = null;
    }
  }

  /** Drop preview fragments superseded by an authoritative assistant_text. */
  function dropPreviews() {
    cancelRender();
    for (const node of previewEls) node.remove();
    previewEls = [];
    streamingEl = null;
  }

  /**
   * Turn ended without an authoritative assistant_text (interrupt, error).
   * Render what streamed rather than discarding the user's text.
   */
  function settlePreviews() {
    cancelRender();
    for (const node of previewEls) {
      const raw = previewRaw.get(node) || '';
      if (raw.trim()) {
        node.classList.remove('streaming');
        node.replaceChildren(renderMarkdown(raw));
      } else {
        node.remove();
      }
    }
    previewEls = [];
    streamingEl = null;
  }
```

- [ ] **Step 3: Feed deltas through the buffer**

Replace the `case 'delta':` block:

```js
      case 'delta': {
        if (!streamingEl) {
          streamingEl = el('div', 'assistant streaming', '');
          threadEl.appendChild(streamingEl);
          previewEls.push(streamingEl);
          setRunning(true);
        }
        streamingEl.textContent += msg.text;
        keepWorkingLast();
        if (pinned) scrollToBottom();
        break;
      }
```

with:

```js
      case 'delta': {
        if (!streamingEl) {
          streamingEl = makePreview();
          threadEl.appendChild(streamingEl);
          previewEls.push(streamingEl);
          setRunning(true);
        }
        // Scrolling and the working-row reorder happen in renderPreviews, on
        // the animation frame, so they run once per frame rather than per chunk.
        appendPreviewText(streamingEl, msg.text);
        break;
      }
```

- [ ] **Step 4: Move the streaming caret onto the tail**

In `extension/media/chat.css`, replace:

```css
.assistant.streaming::after {
  content: '▍';
  animation: blink 1s step-start infinite;
  opacity: 0.6;
}
```

with:

```css
/* The caret rides the raw tail, so it stays on the last streamed line rather
   than dropping below the block-level preview children. */
.assistant.streaming .tail::after {
  content: '▍';
  animation: blink 1s step-start infinite;
  opacity: 0.6;
}
/* Raw text keeps its line breaks, so nothing jumps when it later renders. */
.assistant .tail { white-space: pre-wrap; }
.assistant .stable:empty, .assistant .tail:empty { display: none; }
```

- [ ] **Step 5: Verify**

```bash
node --check extension/media/chat.js
npm run build && node --test extension/dist/*.test.js
grep -c 'splitStreamingMarkdown' extension/media/chat.js
```
Expected: `node --check` silent; build clean; 33 tests pass; grep prints `1`.

- [ ] **Step 6: Commit**

```bash
git add extension/src/chatPanel.ts extension/media/chat.js extension/media/chat.css
git commit -m "feat(chat): render markdown as text streams in"
```

---

### Task 5: Exclude subagent usage from context size

**Files:**
- Modify: `daemon/src/session.ts:350`
- Modify: `shared/src/protocol.ts:9`
- Modify: `extension/src/daemonClient.ts:23`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks.

The daemon has no test harness; this is a one-condition change verified by build and by the surrounding comment. Do not add a harness as part of this task.

- [ ] **Step 1: Add the guard**

In `daemon/src/session.ts`, inside `case 'assistant':`, replace:

```ts
        if (message?.usage) this.lastCallUsage = message.usage;
```

with:

```ts
        // Subagent (Agent tool) messages carry parent_tool_use_id and report
        // the SUBAGENT's context, not this conversation's — counting them would
        // make the context ring show someone else's window.
        if (message?.usage && msg.parent_tool_use_id == null) {
          this.lastCallUsage = message.usage;
        }
```

- [ ] **Step 2: Bump the protocol**

In `shared/src/protocol.ts`, change `export const PROTOCOL_VERSION = 9;` to `= 10`.

In `extension/src/daemonClient.ts`, change `const EXPECTED_PROTOCOL = 9;` to `= 10`.

This is the repo convention for any daemon behaviour change: the mismatch is what makes an installed extension replace a daemon still running the old code.

- [ ] **Step 3: Verify**

```bash
npm run build
grep -n 'PROTOCOL_VERSION = 10' shared/src/protocol.ts
grep -n 'EXPECTED_PROTOCOL = 10' extension/src/daemonClient.ts
grep -n 'parent_tool_use_id' daemon/src/session.ts
```
Expected: build clean; all three greps print a line.

- [ ] **Step 4: Commit**

```bash
git add daemon/src/session.ts shared/src/protocol.ts extension/src/daemonClient.ts
git commit -m "fix(daemon): exclude subagent usage from context size"
```

---

### Task 6: New-session title prefill

**Files:**
- Create: `extension/src/sessionTitle.ts`
- Test: `extension/src/sessionTitle.test.ts`
- Modify: `extension/src/extension.ts` (the `claudePersist.newSession` command)

**Interfaces:**
- Consumes: nothing.
- Produces: `sessionTitleFromInput(raw: string, fallback: string): string`.

- [ ] **Step 1: Write the failing tests**

Create `extension/src/sessionTitle.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionTitleFromInput } from './sessionTitle';

test('keeps a title the user actually typed', () => {
  assert.equal(sessionTitleFromInput('claude-persist-branch chip', 'claude-persist'), 'claude-persist-branch chip');
});

test('drops the seed dash when the prefix is accepted unchanged', () => {
  assert.equal(sessionTitleFromInput('claude-persist-', 'claude-persist'), 'claude-persist');
});

test('drops trailing dashes and whitespace together', () => {
  assert.equal(sessionTitleFromInput('  work -  ', 'fallback'), 'work');
  assert.equal(sessionTitleFromInput('work--', 'fallback'), 'work');
});

test('falls back when nothing is left', () => {
  assert.equal(sessionTitleFromInput('', 'fallback'), 'fallback');
  assert.equal(sessionTitleFromInput('   ', 'fallback'), 'fallback');
  assert.equal(sessionTitleFromInput('-', 'fallback'), 'fallback');
});

test('leaves internal dashes alone', () => {
  assert.equal(sessionTitleFromInput('a-b-c', 'fallback'), 'a-b-c');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run build -w extension
```
Expected: FAIL — `error TS2307: Cannot find module './sessionTitle'`.

- [ ] **Step 3: Implement the helper**

Create `extension/src/sessionTitle.ts`:

```ts
/**
 * The new-session box is seeded with "<folder>-" so the caret lands after the
 * dash and you type straight into it. Accepting that seed untouched should not
 * produce a session literally named "my-project-".
 */
export function sessionTitleFromInput(raw: string, fallback: string): string {
  const trimmed = raw.trim().replace(/[-\s]+$/, '');
  return trimmed || fallback;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm run build -w extension && node --test extension/dist/*.test.js
```
Expected: PASS, 38 tests total (33 + 5 new).

- [ ] **Step 5: Wire it into the command**

In `extension/src/extension.ts`, add the import next to the others:

```ts
import { sessionTitleFromInput } from './sessionTitle';
```

In the `claudePersist.newSession` command, replace:

```ts
        const title = await vscode.window.showInputBox({
          title: 'Session title',
          value: path.basename(cwd),
        });
        const info = await applyDefaultModel(c, await c.createSession(cwd, title || undefined));
```

with:

```ts
        const base = path.basename(cwd);
        const seed = `${base}-`;
        const raw = await vscode.window.showInputBox({
          title: 'Session title',
          value: seed,
          // Caret after the dash, nothing selected — so typing appends.
          valueSelection: [seed.length, seed.length],
        });
        // With a prefilled value, dismissing the box means "cancel", not
        // "use the default name".
        if (raw === undefined) return;
        const info = await applyDefaultModel(
          c,
          await c.createSession(cwd, sessionTitleFromInput(raw, base)),
        );
```

- [ ] **Step 6: Verify**

```bash
npm run build && node --test extension/dist/*.test.js
```
Expected: build clean; 38 tests pass.

- [ ] **Step 7: Commit**

```bash
git add extension/src/sessionTitle.ts extension/src/sessionTitle.test.ts extension/src/extension.ts
git commit -m "feat(extension): seed new session titles with the folder name"
```

---

### Task 7: Merge model and effort into one pill

**Files:**
- Modify: `extension/src/chatPanel.ts` (composer markup only)
- Modify: `extension/media/chat.js`
- Modify: `extension/media/chat.css`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks.

Messages to the host are unchanged: `{ type: 'setOptions', model }` and
`{ type: 'setOptions', effort }`. `chatPanel.ts` message handling and the daemon
are untouched.

- [ ] **Step 1: Replace the two selects in the markup**

In `extension/src/chatPanel.ts` `html()`, replace:

```html
        <select id="model-select" class="select-pill" title="Model">
          <option value="">model: default</option>
        </select>
        <select id="effort-select" class="select-pill" title="Reasoning effort — how smart / how long it thinks">
          <option value="">effort: default</option>
        </select>
```

with:

```html
        <button id="model-pill" class="pill" title="Model and reasoning effort">
          <span id="model-pill-label">default</span>
        </button>
```

- [ ] **Step 2: Replace the element lookups in chat.js**

Replace:

```js
  const modelSelect = document.getElementById('model-select');
  const effortSelect = document.getElementById('effort-select');
```

with:

```js
  const modelPill = document.getElementById('model-pill');
  const modelPillLabel = document.getElementById('model-pill-label');
```

- [ ] **Step 3: Replace the option-building block**

Replace this entire section (from the `ALL_EFFORTS` line through the end of
`rebuildEffortOptions`, currently lines 606–659):

```js
  const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  let modelInfos = [];

  function setOptionList(select, defaultLabel, entries, current) {
    ...
  }

  function rebuildModelOptions(current) {
    ...
  }

  function rebuildEffortOptions(current) {
    ...
  }
```

with:

```js
  const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  let modelInfos = [];
  let currentModel = '';
  let currentEffort = '';

  const modelMenu = el('div', 'attach-menu model-menu');
  modelMenu.hidden = true;
  document.getElementById('composer').appendChild(modelMenu);

  function modelLabel(value) {
    if (!value) return 'default';
    const info = modelInfos.find((m) => m.value === value);
    return (info && info.displayName) || value;
  }

  /** Effort levels the selected model supports; the full set when unknown. */
  function effortLevels() {
    const info = modelInfos.find((m) => m.value === currentModel);
    return info && Array.isArray(info.effortLevels) && info.effortLevels.length
      ? info.effortLevels
      : ALL_EFFORTS;
  }

  function renderPill() {
    const parts = [modelLabel(currentModel)];
    if (currentEffort) parts.push(currentEffort);
    modelPillLabel.textContent = parts.join(' · ');
    modelPill.title = `Model: ${modelLabel(currentModel)} — Effort: ${currentEffort || 'default'}`;
  }

  function menuChoice(label, selected, onPick) {
    const btn = el('button', 'menu-item');
    btn.appendChild(el('span', 'menu-check', selected ? '✓' : ''));
    btn.appendChild(el('span', null, label));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onPick();
    });
    return btn;
  }

  function renderModelMenu() {
    modelMenu.replaceChildren();
    modelMenu.appendChild(el('div', 'menu-title', 'Model'));
    const models = [{ value: '', label: 'default' }].concat(
      modelInfos
        .filter((m) => m.value !== 'default') // our '' entry already means default
        .map((m) => ({ value: m.value, label: m.displayName || m.value })),
    );
    // A persisted model the SDK doesn't list must stay visible and selected.
    if (currentModel && !models.some((m) => m.value === currentModel)) {
      models.push({ value: currentModel, label: currentModel });
    }
    for (const entry of models) {
      modelMenu.appendChild(
        menuChoice(entry.label, entry.value === currentModel, () => {
          currentModel = entry.value;
          vscode.postMessage({ type: 'setOptions', model: currentModel });
          renderPill();
          // Effort levels depend on the model, so redraw and stay open: model
          // then effort is the common two-step.
          renderModelMenu();
        }),
      );
    }
    modelMenu.appendChild(el('div', 'menu-title', 'Effort'));
    const levels = effortLevels().slice();
    if (currentEffort && !levels.includes(currentEffort)) levels.push(currentEffort);
    const efforts = [{ value: '', label: 'default' }].concat(
      levels.map((l) => ({ value: l, label: l })),
    );
    for (const entry of efforts) {
      modelMenu.appendChild(
        menuChoice(entry.label, entry.value === currentEffort, () => {
          currentEffort = entry.value;
          vscode.postMessage({ type: 'setOptions', effort: currentEffort });
          renderPill();
          modelMenu.hidden = true;
        }),
      );
    }
  }
```

- [ ] **Step 4: Update the two call sites**

In the `case 'replay':` handler, replace:

```js
          rebuildModelOptions(msg.info.model || '');
          rebuildEffortOptions(msg.info.effort || '');
```

with:

```js
          currentModel = msg.info.model || '';
          currentEffort = msg.info.effort || '';
          renderPill();
```

In the `case 'models':` handler, replace:

```js
      case 'models':
        modelInfos = msg.models ?? [];
        rebuildModelOptions();
        rebuildEffortOptions();
        break;
```

with:

```js
      case 'models':
        modelInfos = msg.models ?? [];
        renderPill(); // display names may only now be known
        if (!modelMenu.hidden) renderModelMenu();
        break;
```

- [ ] **Step 5: Replace the change listeners with the pill toggle**

Replace:

```js
  modelSelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'setOptions', model: modelSelect.value });
    // Effort choices depend on the selected model.
    rebuildEffortOptions();
  });
  effortSelect.addEventListener('change', () =>
    vscode.postMessage({ type: 'setOptions', effort: effortSelect.value }));
```

with:

```js
  modelPill.addEventListener('click', (e) => {
    e.stopPropagation();
    if (modelMenu.hidden) renderModelMenu();
    modelMenu.hidden = !modelMenu.hidden;
  });
```

- [ ] **Step 6: Close the popover on outside clicks**

Replace the existing outside-click handler:

```js
  document.addEventListener('click', (e) => {
    if (!attachMenu.hidden && !attachMenu.contains(e.target) && e.target !== attachBtn) hideMenu();
  });
```

with:

```js
  document.addEventListener('click', (e) => {
    if (!attachMenu.hidden && !attachMenu.contains(e.target) && e.target !== attachBtn) hideMenu();
    if (!modelMenu.hidden && !modelMenu.contains(e.target) && !modelPill.contains(e.target)) {
      modelMenu.hidden = true;
    }
  });
```

- [ ] **Step 7: Style the popover sections**

In `extension/media/chat.css`, replace the entire section that starts at the
heading `/* ---------- model / effort selects ---- */` and ends just before
`/* ---------- sticky last-prompt bar ---- */` — that is, the heading, the
`.select-pill`, `.select-pill:hover`, `.select-pill:focus`, `.select-pill option`
rules, and their `@media (max-width: 520px)` block — with:

```css
/* ---------- model + effort pill ------------------------------------------- */

#model-pill { font-size: 0.85em; max-width: 16em; }
#model-pill-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.model-menu { max-height: 60vh; overflow-y: auto; min-width: 12em; }
.menu-title {
  padding: 6px 14px 3px;
  font-size: 0.8em;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--vscode-descriptionForeground);
}
.menu-check {
  width: 1em;
  flex: none;
  color: var(--vscode-descriptionForeground);
}

@media (max-width: 640px) {
  /* Model name only — effort still reads from the popover. */
  #model-pill { max-width: 9em; }
}
```

Leave every other section of the file untouched.

- [ ] **Step 8: Verify**

```bash
node --check extension/media/chat.js
npm run build && node --test extension/dist/*.test.js
grep -n 'select-pill\|modelSelect\|effortSelect\|rebuildModelOptions\|rebuildEffortOptions\|setOptionList' extension/media/chat.js extension/media/chat.css extension/src/chatPanel.ts
```
Expected: `node --check` silent; build clean; 38 tests pass; the final grep
prints **nothing** — every trace of the old two-select UI is gone.

- [ ] **Step 9: Commit**

```bash
git add extension/src/chatPanel.ts extension/media/chat.js extension/media/chat.css
git commit -m "feat(chat): merge model and effort into one composer pill"
```

---

## Final verification

After all seven tasks:

```bash
npm run build
node --test extension/dist/*.test.js
node --check extension/media/chat.js
node --check extension/media/streamingMarkdown.js
grep -c '</script>' extension/media/streamingMarkdown.js || true
```

Expected: build clean, 38 tests pass, both `node --check` silent, and the last
grep prints `0` (inlining safety).

Then run `./scripts/package.sh` and confirm the built `.vsix` contains
`media/streamingMarkdown.js`.
