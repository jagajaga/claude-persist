import * as https from 'https';
import type { ReleaseInfo } from '@claude-persist/shared';

const LATEST_URL = 'https://api.github.com/repos/jagajaga/claude-persist/releases/latest';
/**
 * GitHub's unauthenticated limit is 60/hour per IP. Every window also runs its
 * own fallback check at activation, and a code-server host often shares an
 * egress IP, so polling every 2 minutes (30/hour) leaves real headroom instead
 * of sitting exactly at the cap.
 */
const POLL_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * Floor between connect-triggered polls, so reconnect storms cost one request.
 * Shared with the interval, so this — not POLL_MS — sets the true ceiling:
 * 60s means at most 60 requests/hour even if a crash-looping daemon reconnects
 * continuously.
 */
const REFRESH_THROTTLE_MS = 60_000;
const MAX_REDIRECTS = 3;

function fetchJson(url: string, redirects = 0): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(
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
        // Decode as a stream: a multi-byte character split across two chunks
        // would otherwise become replacement characters.
        res.setEncoding('utf8');
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
    );
    // Node sets no default timeout. Without this, a connection that is accepted
    // and then silently dropped never fires 'error' or 'end', the promise never
    // settles, and the poller wedges for the daemon's whole lifetime.
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('release poll timed out')));
    req.on('error', reject);
  });
}

/**
 * Read GitHub's `releases/latest` payload. Null for anything unusable — an
 * error body, a rate-limit response, a release with no tag — so a bad reply is
 * indistinguishable from "no news".
 *
 * Duplicated in extension/src/release.ts, deliberately. The daemon could import
 * this from shared — it is ESM and shared ships beside it — but the extension
 * host cannot: it is CommonJS, and a require() of shared does not resolve in
 * the packaged VSIX. Keeping shared type-only is what makes that hazard
 * impossible to reintroduce, and the cost is this one duplicated function.
 */
function parseRelease(raw: unknown): ReleaseInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  const tagName = typeof body.tag_name === 'string' ? body.tag_name.trim() : '';
  if (!tagName) return null;
  const htmlUrl = typeof body.html_url === 'string' ? body.html_url : '';
  const assets = Array.isArray(body.assets) ? body.assets : [];
  const vsix = assets
    .map((a) => a as Record<string, unknown>)
    .find((a) => typeof a.name === 'string' && a.name.endsWith('.vsix'));
  return {
    tagName,
    htmlUrl,
    ...(vsix && typeof vsix.browser_download_url === 'string'
      ? { vsixUrl: vsix.browser_download_url, vsixName: vsix.name as string }
      : {}),
  };
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
  private lastPollAt = 0;

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
  }

  /**
   * Poll now, unless we just did. Called when a window connects: the daemon is
   * spawned *by* the first window, so at start() there are no clients and the
   * poll is skipped, leaving nothing cached to hand that window on `hello`.
   * Throttled because reconnect storms (a flaky link, several windows coming
   * back at once) must not turn into a request each.
   */
  refresh(): void {
    if (Date.now() - this.lastPollAt < REFRESH_THROTTLE_MS) return;
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
    this.lastPollAt = Date.now();
    try {
      const release = parseRelease(await fetchJson(LATEST_URL));
      // Same tag as last time, or an unusable reply (rate limit, error body):
      // either way there is nothing new to tell anyone.
      if (!release || release.tagName === this.latest?.tagName) return;
      // Record only after a successful notify, so a throw can't mark a tag as
      // delivered and suppress it forever.
      this.onRelease(release);
      this.latest = release;
    } catch {
      // Offline, DNS failure, GitHub down — try again next tick.
    } finally {
      this.polling = false;
    }
  }
}
