/**
 * Every account's plan limits, read directly, not only the active one's.
 *
 * Limits used to come only from a running chat, so only the account in use
 * ever had a reading -- and the code that kept it per account had lost its
 * caller, so Settings showed nothing for any of them. Claude Code's own
 * `/usage` asks Anthropic with the account's OAuth token; this does the same
 * for each account, read-only: it never refreshes or writes a token.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { RateLimits } from '@claude-persist/shared';
import { applyUsageResponse } from './usage.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ status: number; json(): Promise<unknown> }>;

/** The account's Claude access token, or null when it has none (never signed in). */
export function accessTokenOf(configDir: string | null, homeDir = os.homedir()): string | null {
  const dir = configDir ?? path.join(homeDir, '.claude');
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8')) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    const token = creds.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token ? token : null;
  } catch {
    return null;
  }
}

/** The usage response as windows (percent and reset time), or null when it could not be read. */
export async function fetchAccountLimits(token: string, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<RateLimits | null> {
  try {
    const r = await fetchImpl(USAGE_URL, {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' },
    });
    if (r.status !== 200) return null;
    const body = (await r.json()) as Record<string, unknown>;
    return applyUsageResponse({ windows: {}, subscriptionType: null, available: true }, { rate_limits: body }).windows;
  } catch {
    return null;
  }
}
