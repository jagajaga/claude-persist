# Workspace-Grouped Sidebar with Unread Dots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the flat sessions tree in the activity bar into a two-level tree — workspace groups (by session `cwd`) with sessions sorted by last activity — plus a theme-red unread dot on sessions whose turn completed while the user wasn't looking, and replace all emoji glyphs with monochrome symbols.

**Architecture:** Pure grouping/unread logic lives in a new vscode-free module `sessionsModel.ts` (unit-tested with node's built-in test runner). `sessionsView.ts` becomes a two-level `TreeDataProvider` over a `WorkspaceGroup | SessionInfo` union. A `FileDecorationProvider` on a custom `claude-persist:` URI scheme paints the red dot. `chatPanel.ts` reports "user viewed this session" via a callback so the dot clears. No daemon/protocol/webview-protocol changes.

**Tech Stack:** TypeScript 5, VS Code extension API (TreeDataProvider, FileDecorationProvider, Memento), `node:test` for unit tests.

## Global Constraints

- No daemon or protocol changes → do NOT bump `PROTOCOL_VERSION` / `EXPECTED_PROTOCOL`.
- No emoji anywhere in UI strings — monochrome glyphs only (`⧗`, `▣`, `▤`, `⚠︎`, `●`).
- Commit subjects follow the user's naming-commits format `type(scope): lowercase imperative`; NEVER add any AI co-author trailer.
- After touching `extension/media/chat.js`, run `node --check extension/media/chat.js` (a SyntaxError blanks the webview).
- Build command: `npm run build` from the repo root (`/home/jaga/code-workspace/claude-persist`) builds shared → daemon → extension. All commands below run from the repo root.
- Unread rule (from spec): unread ⇔ `status !== 'running' && lastActivityAt > seenActivityAt`. Sessions never seen before are initialized as seen.

---

### Task 1: Pure sessions model (grouping + unread) with unit tests

**Files:**
- Create: `extension/src/sessionsModel.ts`
- Test: `extension/src/sessionsModel.test.ts` (compiled to `extension/dist/sessionsModel.test.js`, run with `node --test`)

**Interfaces:**
- Consumes: `SessionInfo` from `@claude-persist/shared` (`{ id, title, cwd, status: 'idle'|'running'|'error', permissionMode, createdAt, lastActivityAt, eventCount }`).
- Produces (used by Tasks 3):
  - `interface WorkspaceGroup { kind: 'workspace'; cwd: string; sessions: SessionInfo[]; isCurrent: boolean; hasUnread: boolean }`
  - `type TreeNode = WorkspaceGroup | SessionInfo`
  - `type SeenMap = Record<string, number>`
  - `isWorkspaceGroup(node: TreeNode): node is WorkspaceGroup`
  - `isUnread(session: SessionInfo, seen: SeenMap): boolean`
  - `reconcileSeen(sessions: SessionInfo[], seen: SeenMap): SeenMap | null` (null = no change)
  - `groupSessions(sessions: SessionInfo[], workspaceFolders: string[], seen: SeenMap): WorkspaceGroup[]`

- [ ] **Step 1: Write the failing test**

Create `extension/src/sessionsModel.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionInfo } from '@claude-persist/shared';
import { groupSessions, isUnread, reconcileSeen } from './sessionsModel';

const session = (over: Partial<SessionInfo>): SessionInfo => ({
  id: 'id',
  title: 't',
  cwd: '/w/a',
  status: 'idle',
  permissionMode: 'default',
  createdAt: 0,
  lastActivityAt: 0,
  eventCount: 0,
  ...over,
});

test('isUnread: completed session with newer activity than seen', () => {
  const s = session({ id: 's1', lastActivityAt: 100 });
  assert.equal(isUnread(s, { s1: 50 }), true);
  assert.equal(isUnread(s, { s1: 100 }), false);
});

test('isUnread: errored turns count as completed', () => {
  const s = session({ id: 's1', status: 'error', lastActivityAt: 100 });
  assert.equal(isUnread(s, { s1: 50 }), true);
});

test('isUnread: running sessions never count', () => {
  const s = session({ id: 's1', status: 'running', lastActivityAt: 100 });
  assert.equal(isUnread(s, { s1: 50 }), false);
});

test('isUnread: unknown sessions are treated as seen', () => {
  assert.equal(isUnread(session({ id: 's1', lastActivityAt: 100 }), {}), false);
});

test('reconcileSeen: initializes new sessions as seen, prunes deleted', () => {
  const sessions = [
    session({ id: 'a', lastActivityAt: 10 }),
    session({ id: 'b', lastActivityAt: 20 }),
  ];
  assert.deepEqual(reconcileSeen(sessions, { a: 5, gone: 1 }), { a: 5, b: 20 });
});

test('reconcileSeen: returns null when nothing changed', () => {
  assert.equal(reconcileSeen([session({ id: 'a' })], { a: 5 }), null);
});

test('groupSessions: groups by cwd (trailing slash normalized), sessions newest-first', () => {
  const groups = groupSessions(
    [
      session({ id: '1', cwd: '/w/a', lastActivityAt: 10 }),
      session({ id: '2', cwd: '/w/b', lastActivityAt: 30 }),
      session({ id: '3', cwd: '/w/a/', lastActivityAt: 20 }),
    ],
    [],
    {},
  );
  assert.deepEqual(groups.map((g) => g.cwd), ['/w/b', '/w/a']);
  assert.deepEqual(groups[1].sessions.map((s) => s.id), ['3', '1']);
});

test('groupSessions: current workspace pinned first despite older activity', () => {
  const groups = groupSessions(
    [
      session({ id: '1', cwd: '/w/old', lastActivityAt: 10 }),
      session({ id: '2', cwd: '/w/new', lastActivityAt: 99 }),
    ],
    ['/w/old'],
    {},
  );
  assert.deepEqual(groups.map((g) => g.cwd), ['/w/old', '/w/new']);
  assert.equal(groups[0].isCurrent, true);
  assert.equal(groups[1].isCurrent, false);
});

test('groupSessions: hasUnread set when any session in the group is unread', () => {
  const groups = groupSessions(
    [
      session({ id: '1', cwd: '/w/a', lastActivityAt: 100 }),
      session({ id: '2', cwd: '/w/a', lastActivityAt: 5 }),
    ],
    [],
    { 1: 50, 2: 5 },
  );
  assert.equal(groups[0].hasUnread, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build -w shared && npm run build -w extension`
Expected: FAIL — `error TS2307: Cannot find module './sessionsModel'`

- [ ] **Step 3: Write the implementation**

Create `extension/src/sessionsModel.ts`:

```typescript
import type { SessionInfo } from '@claude-persist/shared';

/** Root-level tree node: one per distinct session cwd. */
export interface WorkspaceGroup {
  kind: 'workspace';
  cwd: string;
  /** Sorted by lastActivityAt desc. */
  sessions: SessionInfo[];
  /** True when cwd matches an open VS Code workspace folder. */
  isCurrent: boolean;
  hasUnread: boolean;
}

export type TreeNode = WorkspaceGroup | SessionInfo;

/** sessionId -> lastActivityAt the user has seen (persisted in globalState). */
export type SeenMap = Record<string, number>;

export function isWorkspaceGroup(node: TreeNode): node is WorkspaceGroup {
  return (node as WorkspaceGroup).kind === 'workspace';
}

const normalize = (p: string): string => p.replace(/\/+$/, '') || '/';

/** A finished turn the user hasn't looked at. Running sessions never count. */
export function isUnread(session: SessionInfo, seen: SeenMap): boolean {
  const seenAt = seen[session.id];
  return (
    seenAt !== undefined &&
    session.status !== 'running' &&
    session.lastActivityAt > seenAt
  );
}

/**
 * Ensure every listed session has a seen entry (new/imported sessions start
 * as "seen" so an upgrade doesn't light the whole sidebar red) and drop
 * entries for deleted sessions. Returns null when nothing changed.
 */
export function reconcileSeen(sessions: SessionInfo[], seen: SeenMap): SeenMap | null {
  let changed = false;
  const next: SeenMap = {};
  for (const s of sessions) {
    if (seen[s.id] === undefined) {
      next[s.id] = s.lastActivityAt;
      changed = true;
    } else {
      next[s.id] = seen[s.id];
    }
  }
  if (Object.keys(seen).length !== Object.keys(next).length) changed = true;
  return changed ? next : null;
}

/**
 * Group sessions by cwd. Current-workspace groups come first, the rest by
 * newest session activity desc; sessions inside each group newest-first.
 */
export function groupSessions(
  sessions: SessionInfo[],
  workspaceFolders: string[],
  seen: SeenMap,
): WorkspaceGroup[] {
  const folders = new Set(workspaceFolders.map(normalize));
  const byCwd = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const key = normalize(s.cwd);
    const list = byCwd.get(key);
    if (list) list.push(s);
    else byCwd.set(key, [s]);
  }
  const groups: WorkspaceGroup[] = [...byCwd.entries()].map(([cwd, list]) => ({
    kind: 'workspace',
    cwd,
    sessions: [...list].sort((a, b) => b.lastActivityAt - a.lastActivityAt),
    isCurrent: folders.has(cwd),
    hasUnread: list.some((s) => isUnread(s, seen)),
  }));
  groups.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return b.sessions[0].lastActivityAt - a.sessions[0].lastActivityAt;
  });
  return groups;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build -w shared && npm run build -w extension && node --test extension/dist/sessionsModel.test.js`
Expected: PASS — `# pass 9`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add extension/src/sessionsModel.ts extension/src/sessionsModel.test.ts
git commit -m "feat(extension): add workspace-grouping session model with unread state"
```

---

### Task 2: Unread decoration provider (the red dot)

**Files:**
- Create: `extension/src/unreadDecorations.ts`

**Interfaces:**
- Consumes: nothing project-specific (vscode API only).
- Produces (used by Task 3):
  - `DECORATION_SCHEME = 'claude-persist'`
  - `sessionUri(id: string): vscode.Uri` → `claude-persist:/session/<id>`
  - `workspaceUri(cwd: string): vscode.Uri` → `claude-persist:/workspace/<encodeURIComponent(cwd)>`
  - `class UnreadDecorationProvider implements vscode.FileDecorationProvider` with `update(uris: vscode.Uri[]): void`

No unit test — this class is a thin vscode API adapter with no logic beyond a Set lookup; the compile step and manual verification (Task 6) cover it.

- [ ] **Step 1: Write the implementation**

Create `extension/src/unreadDecorations.ts`:

```typescript
import * as vscode from 'vscode';

export const DECORATION_SCHEME = 'claude-persist';

export const sessionUri = (id: string): vscode.Uri =>
  vscode.Uri.from({ scheme: DECORATION_SCHEME, path: `/session/${id}` });

export const workspaceUri = (cwd: string): vscode.Uri =>
  vscode.Uri.from({
    scheme: DECORATION_SCHEME,
    path: `/workspace/${encodeURIComponent(cwd)}`,
  });

/**
 * Paints the red unread dot on sidebar items via their resourceUri.
 * Tree items cannot overlay icons; a FileDecoration badge is the native way.
 */
export class UnreadDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  /** uri.toString() of every item currently carrying the dot. */
  private unread = new Set<string>();

  /** Replace the decorated set and repaint. */
  update(uris: vscode.Uri[]): void {
    this.unread = new Set(uris.map((u) => u.toString()));
    this.emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== DECORATION_SCHEME || !this.unread.has(uri.toString())) {
      return undefined;
    }
    return new vscode.FileDecoration(
      '●',
      'Unread activity',
      new vscode.ThemeColor('charts.red'),
    );
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build -w extension`
Expected: exit 0, no errors

- [ ] **Step 3: Commit**

```bash
git add extension/src/unreadDecorations.ts
git commit -m "feat(extension): add unread red-dot decoration provider"
```

---

### Task 3: Two-level sessions tree

**Files:**
- Modify: `extension/src/sessionsView.ts` (full rewrite, currently 45 lines)
- Modify: `extension/src/extension.ts:108-113` (provider construction + registration)

**Interfaces:**
- Consumes: everything from Tasks 1–2 (`groupSessions`, `isUnread`, `isWorkspaceGroup`, `reconcileSeen`, `TreeNode`, `SeenMap`, `WorkspaceGroup`; `UnreadDecorationProvider`, `sessionUri`, `workspaceUri`), `DaemonClient.listSessions(): Promise<SessionInfo[]>`.
- Produces (used by Task 4):
  - `SessionsProvider` constructor signature: `new SessionsProvider(client: () => DaemonClient | null, state: vscode.Memento)`
  - `SessionsProvider.markSeen(sessionId: string): void`
  - `SessionsProvider.decorations: UnreadDecorationProvider` (public readonly field)

- [ ] **Step 1: Rewrite `extension/src/sessionsView.ts`**

Replace the entire file with:

```typescript
import * as path from 'path';
import * as vscode from 'vscode';
import type { SessionInfo } from '@claude-persist/shared';
import type { DaemonClient } from './daemonClient';
import {
  groupSessions,
  isUnread,
  isWorkspaceGroup,
  reconcileSeen,
} from './sessionsModel';
import type { SeenMap, TreeNode, WorkspaceGroup } from './sessionsModel';
import {
  sessionUri,
  UnreadDecorationProvider,
  workspaceUri,
} from './unreadDecorations';

const SEEN_KEY = 'claudePersist.seenActivity';

/**
 * Activity-bar tree: workspace groups (by session cwd) containing sessions.
 * Current workspace pinned first and expanded; groups and sessions ordered
 * by last activity desc. Unread sessions (turn completed while the tab was
 * not visible) carry a red dot, propagated to their group.
 */
export class SessionsProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  readonly decorations = new UnreadDecorationProvider();
  /** Last listSessions snapshot, for markSeen lookups. */
  private snapshot: SessionInfo[] = [];

  constructor(
    private readonly client: () => DaemonClient | null,
    private readonly state: vscode.Memento,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  /** The user is looking at this session — record it and clear its dot. */
  markSeen(sessionId: string): void {
    const session = this.snapshot.find((s) => s.id === sessionId);
    const seen: SeenMap = { ...this.seen() };
    const wasUnread = session ? isUnread(session, seen) : false;
    seen[sessionId] = Math.max(session?.lastActivityAt ?? 0, Date.now());
    void this.state.update(SEEN_KEY, seen);
    if (wasUnread) this.refresh();
  }

  private seen(): SeenMap {
    return this.state.get<SeenMap>(SEEN_KEY, {});
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    return isWorkspaceGroup(node) ? this.groupItem(node) : this.sessionItem(node);
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (node) return isWorkspaceGroup(node) ? node.sessions : [];
    const client = this.client();
    if (!client?.connected) return [];
    let sessions: SessionInfo[];
    try {
      sessions = await client.listSessions();
    } catch {
      return [];
    }
    this.snapshot = sessions;
    let seen = this.seen();
    const reconciled = reconcileSeen(sessions, seen);
    if (reconciled) {
      seen = reconciled;
      void this.state.update(SEEN_KEY, reconciled);
    }
    const folders = (vscode.workspace.workspaceFolders ?? []).map(
      (f) => f.uri.fsPath,
    );
    const groups = groupSessions(sessions, folders, seen);
    this.decorations.update([
      ...groups.filter((g) => g.hasUnread).map((g) => workspaceUri(g.cwd)),
      ...sessions.filter((s) => isUnread(s, seen)).map((s) => sessionUri(s.id)),
    ]);
    return groups;
  }

  private groupItem(group: WorkspaceGroup): vscode.TreeItem {
    const item = new vscode.TreeItem(
      path.basename(group.cwd) || group.cwd,
      group.isCurrent
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = group.cwd; // stable — VS Code remembers manual expand/collapse
    item.description = String(group.sessions.length);
    item.tooltip = group.cwd;
    item.iconPath = new vscode.ThemeIcon(group.isCurrent ? 'root-folder' : 'folder');
    item.contextValue = 'claudeWorkspaceGroup';
    item.resourceUri = workspaceUri(group.cwd);
    return item;
  }

  private sessionItem(session: SessionInfo): vscode.TreeItem {
    const item = new vscode.TreeItem(session.title, vscode.TreeItemCollapsibleState.None);
    item.id = session.id;
    item.description = session.status === 'running' ? 'running…' : session.status;
    item.tooltip = new vscode.MarkdownString(
      `**${session.title}**\n\n${session.cwd}\n\nLast activity: ${new Date(session.lastActivityAt).toLocaleString()}`,
    );
    item.iconPath = new vscode.ThemeIcon(
      session.status === 'running' ? 'sync~spin' : 'comment-discussion',
    );
    item.contextValue = 'claudeSession';
    item.resourceUri = sessionUri(session.id);
    item.command = {
      command: 'claudePersist.openSessionFromTree',
      title: 'Open Session',
      arguments: [session],
    };
    return item;
  }
}
```

- [ ] **Step 2: Wire it in `extension/src/extension.ts`**

In `activate()`, replace:

```typescript
  panels = new ChatPanelManager(context, () => client, () => ensureClient(context));
  sessionsProvider = new SessionsProvider(() => client);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('claudePersist.sessions', sessionsProvider),
  );
```

with (provider first — Task 4 gives panels a callback into it; decoration provider registered globally):

```typescript
  sessionsProvider = new SessionsProvider(() => client, context.globalState);
  panels = new ChatPanelManager(context, () => client, () => ensureClient(context));
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('claudePersist.sessions', sessionsProvider),
    vscode.window.registerFileDecorationProvider(sessionsProvider.decorations),
  );
```

- [ ] **Step 3: Build and run tests**

Run: `npm run build && node --test extension/dist/sessionsModel.test.js`
Expected: build exit 0; tests `# pass 9`, `# fail 0`

- [ ] **Step 4: Commit**

```bash
git add extension/src/sessionsView.ts extension/src/extension.ts
git commit -m "feat(extension): group sidebar sessions by workspace"
```

---

### Task 4: Clear the dot when a chat tab is viewed

**Files:**
- Modify: `extension/src/chatPanel.ts:47-77` (constructor + `handleEvent`), `extension/src/chatPanel.ts:106-120` (`bindPanel`)
- Modify: `extension/src/extension.ts` (`ChatPanelManager` construction from Task 3 Step 2)

**Interfaces:**
- Consumes: `SessionsProvider.markSeen(sessionId: string): void` from Task 3.
- Produces: `ChatPanelManager` constructor gains a 4th optional param `onViewed?: (sessionId: string) => void`.

- [ ] **Step 1: Add the `onViewed` callback to `ChatPanelManager`**

In `extension/src/chatPanel.ts`, change the constructor:

```typescript
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: () => DaemonClient | null,
    /** Connects (or reconnects) to the daemon; used when client() is null. */
    private readonly ensure?: () => Promise<DaemonClient>,
    /** Called whenever the user is looking at a session's chat tab. */
    private readonly onViewed?: (sessionId: string) => void,
  ) {}
```

- [ ] **Step 2: Report views on status events and visibility changes**

In `handleEvent`, extend the existing status branch (turn boundaries only — not
every streamed event — so the tree isn't refreshed on each token):

```typescript
    if (event.event.type === 'status') {
      entry.panel.title =
        (event.event.status === 'running' ? '⏳ ' : '') + entry.baseTitle;
      if (entry.panel.visible) this.onViewed?.(sessionId);
    }
```

In `bindPanel`, after `this.panels.set(sessionId, entry);` add:

```typescript
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) this.onViewed?.(sessionId);
    });
    if (panel.visible) this.onViewed?.(sessionId);
```

- [ ] **Step 3: Wire the callback in `extension/src/extension.ts`**

Change the `ChatPanelManager` construction (from Task 3 Step 2) to:

```typescript
  panels = new ChatPanelManager(
    context,
    () => client,
    () => ensureClient(context),
    (sessionId) => sessionsProvider.markSeen(sessionId),
  );
```

- [ ] **Step 4: Build**

Run: `npm run build -w extension`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add extension/src/chatPanel.ts extension/src/extension.ts
git commit -m "feat(extension): clear unread dot when chat tab is viewed"
```

---

### Task 5: Monochrome glyphs — no emoji anywhere

**Files:**
- Modify: `extension/src/chatPanel.ts:74,298,300,326` (`⏳` → `⧗`)
- Modify: `extension/media/chat.js:474,548,640` (chip and error glyphs)

**Interfaces:**
- Consumes/Produces: nothing — string literals only. Note `⧗` is U+29D7 (mono hourglass); `⚠︎` is U+26A0 + U+FE0E (variation selector forcing text presentation).

- [ ] **Step 1: Replace the tab-title hourglass in `extension/src/chatPanel.ts`**

Four occurrences of the emoji hourglass become the monochrome `⧗`:

```typescript
      entry.panel.title =
        (event.event.status === 'running' ? '⧗ ' : '') + entry.baseTitle;
```

```typescript
    const running = entry.panel.title.startsWith('⧗');
    entry.baseTitle = title;
    entry.panel.title = (running ? '⧗ ' : '') + title;
```

```typescript
    entry.panel.title =
      (result.info.status === 'running' ? '⧗ ' : '') + result.info.title;
```

(Also update the `handleEvent` occurrence edited in Task 4 Step 2 — after this task it reads `'⧗ '`.)

- [ ] **Step 2: Replace webview chip/error glyphs in `extension/media/chat.js`**

Line 474: `` `🖼 ${a.label}` `` → `` `▣ ${a.label}` ``

Line 548: `` `⚠ ${event.detail || 'error'}` `` → `` `⚠︎ ${event.detail || 'error'}` ``

Line 640: `` `${item.kind === 'image' ? '🖼 ' : '📄 '}${item.label}` `` → `` `${item.kind === 'image' ? '▣ ' : '▤ '}${item.label}` ``

- [ ] **Step 3: Syntax-check the webview script and build**

Run: `node --check extension/media/chat.js && npm run build -w extension`
Expected: both exit 0

- [ ] **Step 4: Verify no emoji remain**

Run: `grep -rnP '[\x{1F300}-\x{1FAFF}\x{2700}-\x{27BF}\x{FE0F}\x{231A}-\x{23FF}]' extension/src extension/media/chat.js extension/media/chat.css`
Expected: no output (exit 1)

- [ ] **Step 5: Commit**

```bash
git add extension/src/chatPanel.ts extension/media/chat.js
git commit -m "fix(extension): monochrome glyphs instead of emoji in titles and chips"
```

---

### Task 6: Full build, tests, and manual verification

**Files:**
- No new files — verification only.

- [ ] **Step 1: Full build + unit tests from clean state**

Run: `npm run build && node --test extension/dist/sessionsModel.test.js`
Expected: build exit 0; `# pass 9`, `# fail 0`

- [ ] **Step 2: Manual verification in code-server** (walk the user through it — needs a live window)

1. Reload the window with the dev extension; open the Claude Persist sidebar.
2. Sessions appear under workspace groups; current workspace first and expanded, others collapsed with a `folder` icon and session-count description.
3. Send a message in a session, switch to another editor tab; when the turn completes, the session and its group show a red `●`.
4. Focus the session's tab — the dot clears; reload the window — seen state survives.
5. Running sessions show `⧗` in the tab title (monochrome), no emoji anywhere.

- [ ] **Step 3: Done — report back**

No version bump or packaging in this plan; ship (`extension/package.json` version bump + `./scripts/package.sh`) happens in the release flow when the user asks.
