import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { registryPath } from './paths.js';

export interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
  /** Claude Agent SDK session id, once known — used to resume after a daemon restart. */
  sdkSessionId?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  createdAt: number;
  lastActivityAt: number;
}

export class Registry {
  private sessions = new Map<string, SessionMeta>();
  private readonly filePath: string;

  constructor(filePath: string = registryPath) {
    this.filePath = filePath;
  }

  /**
   * Returns the path the previous registry was quarantined to if it was
   * unreadable, else null. A missing file is not a failure (first run).
   *
   * Starting empty on a parse error is not survivable on its own: the very next
   * save() — touch() runs on every message — would overwrite the only copy of
   * every session's title, cwd and sdkSessionId. Moving the bad file aside
   * keeps it recoverable and makes the loss visible in the log instead of
   * looking like the sidebar spontaneously forgot everything.
   */
  load(): string | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return null; // first run
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) throw new Error('registry is not an array');
      for (const meta of parsed as SessionMeta[]) {
        // Skip junk entries rather than letting one bad record poison the load.
        if (meta && typeof meta.id === 'string') this.sessions.set(meta.id, meta);
      }
      return null;
    } catch {
      this.sessions.clear();
      const quarantine = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.filePath, quarantine);
      } catch {
        return this.filePath; // couldn't even move it; at least name it
      }
      return quarantine;
    }
  }

  /**
   * Atomic replace. save() runs on every sent message, so a plain
   * writeFileSync interrupted by the SIGTERM of an extension upgrade — exactly
   * when it is most likely to be interrupted — left a truncated JSON file,
   * which load() then treated as "start empty".
   */
  save(): void {
    const payload = JSON.stringify([...this.sessions.values()], null, 2);
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, payload);
      try {
        fs.fsyncSync(fd);
      } catch {
        // some filesystems (and some container overlays) don't support fsync
      }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.filePath);
  }

  list(): SessionMeta[] {
    return [...this.sessions.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  get(id: string): SessionMeta | undefined {
    return this.sessions.get(id);
  }

  create(cwd: string, title?: string): SessionMeta {
    const now = Date.now();
    const meta: SessionMeta = {
      id: randomUUID(),
      title: title ?? `Session ${this.sessions.size + 1}`,
      cwd,
      createdAt: now,
      lastActivityAt: now,
    };
    this.sessions.set(meta.id, meta);
    this.save();
    return meta;
  }

  rename(id: string, title: string): void {
    const meta = this.sessions.get(id);
    if (meta) {
      meta.title = title;
      this.save();
    }
  }

  touch(id: string): void {
    const meta = this.sessions.get(id);
    if (meta) {
      meta.lastActivityAt = Date.now();
      this.save();
    }
  }

  delete(id: string): void {
    this.sessions.delete(id);
    this.save();
  }
}
