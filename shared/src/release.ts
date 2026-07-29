// Release metadata shared by the daemon (which polls GitHub) and the extension
// (which decides whether to offer the update). Kept out of protocol.ts so the
// wire-format file stays a description of the wire format.

export interface ReleaseInfo {
  /** Git tag, e.g. "v0.7.12". */
  tagName: string;
  htmlUrl: string;
  /** Direct download for the packaged extension, when the release has one. */
  vsixUrl?: string;
  vsixName?: string;
}

/**
 * Read GitHub's `releases/latest` payload. Returns null for anything unusable —
 * an error body, a rate-limit response, a release with no tag — so a bad reply
 * is indistinguishable from "no news" to every caller.
 */
export function parseRelease(raw: unknown): ReleaseInfo | null {
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
 * True when `remote` is a strictly newer x.y.z than `local`. A leading "v" on
 * either side is tolerated, because tags carry it and package.json does not.
 */
export function isNewerVersion(remote: string, local: string): boolean {
  const parts = (v: string): number[] =>
    v.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const r = parts(remote);
  const l = parts(local);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}
