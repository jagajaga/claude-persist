// Import existing Claude Code sessions (CLI / official extension) into
// claude-persist. Claude Code stores transcripts as JSONL under
// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl — the same store the
// Agent SDK resumes from, so an imported session can be continued seamlessly.
import fs from 'node:fs';
import path from 'node:path';
import type { ChatEvent, ClaudeSessionCandidate, PersistedEvent } from '@claude-persist/shared';
import type { Registry, SessionMeta } from './registry.js';
import { sessionLogPath } from './paths.js';
import { accountsStore } from './accounts.js';

interface TranscriptLine {
  type?: string;
  isMeta?: boolean;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  summary?: string;
  message?: { role?: string; content?: unknown };
}

const MAX_PARSE_LINE = 200_000; // skip parsing pathological lines (base64 blobs)

interface HeadInfo {
  cwd?: string;
  sessionId?: string;
  summary?: string;
  firstUserText?: string;
}

/**
 * Stream complete lines from the head of a transcript until metadata is
 * found. Oversized lines (e.g. multi-MB base64 attachments) are skipped
 * without parsing instead of aborting the scan — see the needmor bug.
 */
function scanHead(file: string, maxBytes = 16 * 1024 * 1024, maxLines = 400): HeadInfo {
  const info: HeadInfo = {};
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(65536);
    let leftover = '';
    let offset = 0;
    let linesSeen = 0;
    while (offset < maxBytes && linesSeen < maxLines) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (read <= 0) break;
      offset += read;
      leftover += chunk.toString('utf8', 0, read);
      let nl;
      while ((nl = leftover.indexOf('\n')) >= 0) {
        const line = leftover.slice(0, nl);
        leftover = leftover.slice(nl + 1);
        linesSeen++;
        if (!line.trim() || line.length > MAX_PARSE_LINE) continue;
        let parsed: TranscriptLine;
        try {
          parsed = JSON.parse(line) as TranscriptLine;
        } catch {
          continue;
        }
        info.cwd ??= parsed.cwd;
        info.sessionId ??= parsed.sessionId;
        if (!info.summary && parsed.type === 'summary' && typeof parsed.summary === 'string') {
          info.summary = parsed.summary;
        }
        if (!info.firstUserText && !parsed.isMeta && parsed.type === 'user') {
          const text = firstTextOf(parsed.message?.content);
          if (text && !text.startsWith('<')) {
            info.firstUserText = text.slice(0, 60).replace(/\s+/g, ' ');
          }
        }
        if (info.cwd && info.sessionId && (info.summary || info.firstUserText)) return info;
      }
      // Guard: if a single line exceeds the whole budget, drop what we have.
      if (leftover.length > maxBytes) leftover = '';
    }
  } finally {
    fs.closeSync(fd);
  }
  return info;
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

/** Scanned per call, and capped: a long-lived ~/.claude holds thousands. */
const MAX_CANDIDATES = 100;

/**
 * Every importable Claude Code transcript across every known account.
 *
 * This used to read a hardcoded ~/.claude/projects, which was wrong in both
 * directions once accounts existed: with a named account active it listed the
 * default account's sessions and offered to import transcripts the SDK would
 * then fail to resume, and sessions created under a named account were
 * invisible no matter which account was active.
 *
 * The same session can legitimately appear in two config dirs — switching
 * accounts copies it (see ensureSdkTranscript) — so dedupe by sdk session id
 * and keep the newest copy, which is the one that holds every turn.
 */
export function listClaudeSessions(
  configDirs: string[] = accountsStore.allConcreteDirs(),
): ClaudeSessionCandidate[] {
  const bySession = new Map<string, ClaudeSessionCandidate>();
  for (const configDir of configDirs) {
    const projectsDir = path.join(configDir, 'projects');
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(projectsDir);
    } catch {
      continue; // this account has never run a session
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
          const info = scanHead(full);
          if (!info.cwd) continue;
          const sdkSessionId = info.sessionId ?? path.basename(file, '.jsonl');
          const existing = bySession.get(sdkSessionId);
          if (existing && existing.mtimeMs >= stat.mtimeMs) continue;
          bySession.set(sdkSessionId, {
            file: full,
            sdkSessionId,
            cwd: info.cwd,
            title: info.summary ?? info.firstUserText ?? path.basename(info.cwd),
            mtimeMs: stat.mtimeMs,
          });
        } catch {
          // unreadable file — skip
        }
      }
    }
  }
  return [...bySession.values()]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_CANDIDATES);
}

/** Convert a Claude Code transcript into our event log and register it. */
export function importClaudeSession(registry: Registry, file: string): SessionMeta {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const events: ChatEvent[] = [];
  let cwd: string | undefined;
  let sessionId: string | undefined;
  let summaryTitle: string | undefined;
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
    if (parsed.type === 'summary' && typeof parsed.summary === 'string') {
      summaryTitle ??= parsed.summary;
    }
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
  const bestTitle = summaryTitle ?? title;
  const meta = registry.create(
    cwd,
    bestTitle ? `⤵ ${bestTitle}` : `Imported ${path.basename(file, '.jsonl')}`,
  );
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
