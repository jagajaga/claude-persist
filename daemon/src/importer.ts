// Import existing Claude Code sessions (CLI / official extension) into
// claude-persist. Claude Code stores transcripts as JSONL under
// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl — the same store the
// Agent SDK resumes from, so an imported session can be continued seamlessly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatEvent, ClaudeSessionCandidate, PersistedEvent } from '@claude-persist/shared';
import type { Registry, SessionMeta } from './registry.js';
import { sessionLogPath } from './paths.js';

const projectsDir = path.join(os.homedir(), '.claude', 'projects');

interface TranscriptLine {
  type?: string;
  isMeta?: boolean;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

function firstTextOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
    }
  }
  return null;
}

export function listClaudeSessions(): ClaudeSessionCandidate[] {
  const out: ClaudeSessionCandidate[] = [];
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    const dirPath = path.join(projectsDir, dir);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      const full = path.join(dirPath, file);
      try {
        const stat = fs.statSync(full);
        // Read only the head of the file for metadata — transcripts can be huge.
        const fd = fs.openSync(full, 'r');
        const buf = Buffer.alloc(32768);
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        const headLines = buf.toString('utf8', 0, read).split('\n');
        let cwd: string | undefined;
        let sessionId: string | undefined;
        let title: string | undefined;
        for (const line of headLines) {
          if (!line.trim()) continue;
          let parsed: TranscriptLine;
          try {
            parsed = JSON.parse(line) as TranscriptLine;
          } catch {
            continue; // last line may be cut off by the head read
          }
          cwd ??= parsed.cwd;
          sessionId ??= parsed.sessionId;
          if (!title && !parsed.isMeta && parsed.type === 'user') {
            const text = firstTextOf(parsed.message?.content);
            if (text && !text.startsWith('<')) title = text.slice(0, 60).replace(/\s+/g, ' ');
          }
          if (cwd && sessionId && title) break;
        }
        if (!sessionId) sessionId = path.basename(file, '.jsonl');
        if (!cwd) continue;
        out.push({
          file: full,
          sdkSessionId: sessionId,
          cwd,
          title: title ?? path.basename(cwd),
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        // unreadable file — skip
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, 100);
}

/** Convert a Claude Code transcript into our event log and register it. */
export function importClaudeSession(registry: Registry, file: string): SessionMeta {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const events: ChatEvent[] = [];
  let cwd: string | undefined;
  let sessionId: string | undefined;
  let title: string | undefined;
  const timestamps: number[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    cwd ??= parsed.cwd;
    sessionId ??= parsed.sessionId;
    if (parsed.isMeta) continue;
    const ts = parsed.timestamp ? Date.parse(parsed.timestamp) : Date.now();
    const content = parsed.message?.content;

    if (parsed.type === 'user') {
      if (typeof content === 'string') {
        if (!content.startsWith('<')) {
          events.push({ type: 'user_message', text: content });
          timestamps.push(ts);
          title ??= content.slice(0, 60).replace(/\s+/g, ' ');
        }
        continue;
      }
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'text' && typeof block.text === 'string') {
            if (!block.text.startsWith('<')) {
              events.push({ type: 'user_message', text: block.text });
              timestamps.push(ts);
              title ??= block.text.slice(0, 60).replace(/\s+/g, ' ');
            }
          } else if (block.type === 'tool_result') {
            const summary =
              typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content ?? '');
            events.push({
              type: 'tool_result',
              toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
              summary: summary.length > 1500 ? `${summary.slice(0, 1500)}\n… [truncated]` : summary,
              isError: block.is_error === true,
            });
            timestamps.push(ts);
          }
        }
      }
    } else if (parsed.type === 'assistant' && Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          events.push({ type: 'assistant_text', text: block.text });
          timestamps.push(ts);
        } else if (block.type === 'tool_use') {
          events.push({
            type: 'tool_use',
            toolUseId: typeof block.id === 'string' ? block.id : undefined,
            toolName: String(block.name ?? 'tool'),
            input: block.input,
          });
          timestamps.push(ts);
        }
      }
    }
  }

  if (!cwd) throw new Error('Could not determine the session working directory');
  const meta = registry.create(cwd, title ? `⤵ ${title}` : `Imported ${path.basename(file, '.jsonl')}`);
  meta.sdkSessionId = sessionId ?? path.basename(file, '.jsonl');
  registry.save();

  const persisted: PersistedEvent[] = events.map((event, seq) => ({
    seq,
    ts: timestamps[seq] ?? Date.now(),
    event,
  }));
  fs.writeFileSync(
    sessionLogPath(meta.id),
    persisted.map((p) => JSON.stringify(p)).join('\n') + (persisted.length ? '\n' : ''),
  );
  return meta;
}
