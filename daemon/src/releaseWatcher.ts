import * as https from 'https';
import { parseRelease, type ReleaseInfo } from '@claude-persist/shared';

const LATEST_URL = 'https://api.github.com/repos/jagajaga/claude-persist/releases/latest';
const POLL_MS = 60_000;
/** GitHub's unauthenticated limit is 60/hour per IP; one poll a minute fits. */
const MAX_REDIRECTS = 3;

function fetchJson(url: string, redirects = 0): Promise<unknown> {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        { headers: { 'User-Agent': 'claude-persist', Accept: 'application/vnd.github+json' } },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.headers.location) {
            res.resume(); // drain, or the socket is held open
            if (redirects >= MAX_REDIRECTS) {
              reject(new Error('too many redirects'));
              return;
            }
            fetchJson(res.headers.location, redirects + 1).then(resolve, reject);
            return;
          }
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch (err) {
              reject(err);
            }
          });
        },
      )
      .on('error', reject);
  });
}

/**
 * Polls GitHub for the newest release and reports it once per new tag.
 *
 * This lives in the daemon rather than the extension because the daemon is a
 * single process shared by every window: one poll covers all of them, so update
 * latency stops depending on a window happening to reload, and the request rate
 * doesn't multiply with the number of open windows.
 */
export class ReleaseWatcher {
  private timer: NodeJS.Timeout | undefined;
  private latest: ReleaseInfo | null = null;
  private polling = false;

  constructor(
    private readonly hasClients: () => boolean,
    private readonly onRelease: (release: ReleaseInfo) => void,
  ) {}

  /** Newest release seen so far, for pushing to a client that just connected. */
  get current(): ReleaseInfo | null {
    return this.latest;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    // Never hold the process open on our own account.
    this.timer.unref?.();
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(): Promise<void> {
    // No windows are listening, so spending a request would be pure waste.
    if (!this.hasClients() || this.polling) return;
    this.polling = true;
    try {
      const release = parseRelease(await fetchJson(LATEST_URL));
      // Same tag as last time, or an unusable reply (rate limit, error body):
      // either way there is nothing new to tell anyone.
      if (!release || release.tagName === this.latest?.tagName) return;
      this.latest = release;
      this.onRelease(release);
    } catch {
      // Offline, DNS failure, GitHub down — try again next tick.
    } finally {
      this.polling = false;
    }
  }
}
