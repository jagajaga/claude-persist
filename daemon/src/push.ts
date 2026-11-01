/**
 * Notifications to the phone through Google (Firebase Cloud Messaging).
 *
 * Without this the phone had to hold a socket open in the background to hear
 * anything, which Android kills and which costs a permanent "following your
 * chats" notification. Here the daemon decides what is worth a buzz -- the
 * same rules the app used: Claude waiting on you is loud, a finished turn is
 * quiet, nothing else -- and hands it to Google, which wakes the app.
 *
 * Data messages only: the app builds the notification itself, so it can skip
 * the chat you are looking at, honour its own switches, and take down a "needs
 * you" notice once the request is answered anywhere.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PersistedEvent } from '@claude-persist/shared';

export interface PushNotice {
  /** attention: Claude waits on you; done: a turn finished; resolved: take the attention notice down. */
  kind: 'attention' | 'done' | 'resolved';
  sessionId: string;
  title: string;
  text: string;
  requestId?: string;
}

/** What a tool call is about, in a few words: its command, file, address or pattern. */
export function toolDetail(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'query', 'description', 'prompt']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return v.trim().replace(/\s+/g, ' ').slice(0, 140);
  }
  return '';
}

/** The notice an event deserves, if any. */
export function noticeFor(sessionId: string, chatTitle: string, stored: PersistedEvent): PushNotice | null {
  const title = chatTitle.trim() || 'Claude';
  const e = stored.event;
  switch (e.type) {
    case 'permission_request': {
      const detail = toolDetail(e.input);
      return { kind: 'attention', sessionId, title, text: `Allow ${e.toolName}?` + (detail ? ` ${detail}` : ''), requestId: e.requestId };
    }
    case 'question_request':
      return { kind: 'attention', sessionId, title, text: e.questions[0]?.question || 'Claude asked you a question', requestId: e.requestId };
    case 'permission_resolved':
      return { kind: 'resolved', sessionId, title, text: '', requestId: e.requestId };
    case 'result': {
      const line = e.summary?.split('\n').find((l) => l.trim())?.slice(0, 200);
      return { kind: 'done', sessionId, title, text: line || 'Finished' };
    }
    default:
      return null;
  }
}

/** The phones to notify: their FCM tokens, kept on disk. */
export class PushTokens {
  private tokens = new Set<string>();

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      if (Array.isArray(raw)) for (const t of raw) if (typeof t === 'string' && t) this.tokens.add(t);
    } catch {
      // None yet, or unreadable: phones register again on their next connect.
    }
  }

  list(): string[] {
    return [...this.tokens];
  }

  add(token: string): boolean {
    if (!token || this.tokens.has(token)) return false;
    this.tokens.add(token);
    this.save();
    return true;
  }

  remove(token: string): boolean {
    if (!this.tokens.delete(token)) return false;
    this.save();
    return true;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.list()), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export type SendResult = 'sent' | 'gone' | 'failed';

/** Google's HTTP v1 send, signed in as the service account. */
export class FcmSender {
  private access: { token: string; until: number } | null = null;

  constructor(
    private readonly account: ServiceAccount,
    private readonly fetchImpl: Fetch = fetch as unknown as Fetch,
    private readonly now: () => number = Date.now,
  ) {}

  static fromFile(file: string, fetchImpl?: Fetch): FcmSender | null {
    try {
      const a = JSON.parse(fs.readFileSync(file, 'utf8')) as ServiceAccount;
      if (!a.project_id || !a.client_email || !a.private_key) return null;
      return new FcmSender(a, fetchImpl);
    } catch {
      return null;
    }
  }

  /** A short-lived OAuth token from a self-signed JWT, reused until a minute before it ends. */
  private async accessToken(): Promise<string> {
    const now = this.now();
    if (this.access && this.access.until > now + 60_000) return this.access.token;
    const tokenUri = this.account.token_uri || 'https://oauth2.googleapis.com/token';
    const iat = Math.floor(now / 1000);
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: this.account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: tokenUri,
      iat,
      exp: iat + 3600,
    })}`;
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(this.account.private_key).toString('base64url');
    const r = await this.fetchImpl(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString(),
    });
    const text = await r.text();
    if (r.status !== 200) throw new Error(`google sign-in answered ${r.status}: ${text.slice(0, 200)}`);
    const body = JSON.parse(text) as { access_token: string; expires_in?: number };
    this.access = { token: body.access_token, until: now + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  async send(token: string, notice: PushNotice): Promise<SendResult> {
    const access = await this.accessToken();
    const data: Record<string, string> = { kind: notice.kind, sessionId: notice.sessionId, title: notice.title, text: notice.text };
    if (notice.requestId) data.requestId = notice.requestId;
    const message = {
      token,
      data,
      android: {
        // High wakes a dozing phone; a finished turn can wait for its next window.
        priority: notice.kind === 'done' ? 'NORMAL' : 'HIGH',
        ttl: notice.kind === 'done' ? '1800s' : '86400s',
        collapse_key: `${notice.sessionId}:${notice.kind === 'resolved' ? 'attention' : notice.kind}`,
      },
    };
    const r = await this.fetchImpl(`https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (r.status === 200) return 'sent';
    const text = await r.text();
    // The app was uninstalled or its token replaced: stop sending to it.
    if (r.status === 404 || /UNREGISTERED|registration-token-not-registered|not a valid FCM registration token/.test(text)) return 'gone';
    if (r.status === 401) this.access = null;
    throw new Error(`push answered ${r.status}: ${text.slice(0, 200)}`);
  }
}

/** Every registered phone hears every notice; a phone that is gone is forgotten. */
export function createPush(opts: { sender: FcmSender | null; tokens: PushTokens; log: (m: string) => void }) {
  const { sender, tokens, log } = opts;
  return {
    enabled: sender !== null,
    register(token: string): { enabled: boolean } {
      if (tokens.add(token)) log(`push: a phone registered (${tokens.list().length} in all)`);
      return { enabled: sender !== null };
    },
    unregister(token: string): void {
      if (tokens.remove(token)) log(`push: a phone unregistered`);
    },
    async onEvent(sessionId: string, chatTitle: string, stored: PersistedEvent): Promise<void> {
      if (!sender) return;
      const notice = noticeFor(sessionId, chatTitle, stored);
      if (!notice) return;
      await Promise.all(
        tokens.list().map(async (token) => {
          try {
            if ((await sender.send(token, notice)) === 'gone') {
              tokens.remove(token);
              log('push: dropped a phone Google no longer knows');
            }
          } catch (err) {
            log(`push ${notice.kind} for ${sessionId} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }),
      );
    },
  };
}
