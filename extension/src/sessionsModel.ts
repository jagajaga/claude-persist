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
