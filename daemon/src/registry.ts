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
  createdAt: number;
  lastActivityAt: number;
}

export class Registry {
  private sessions = new Map<string, SessionMeta>();

  load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as SessionMeta[];
      for (const meta of raw) this.sessions.set(meta.id, meta);
    } catch {
      // first run or corrupt registry — start empty
    }
  }

  save(): void {
    fs.writeFileSync(registryPath, JSON.stringify([...this.sessions.values()], null, 2));
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
