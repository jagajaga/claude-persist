import type { AccountInfo } from '@claude-persist/shared';

/**
 * After a sign-in: make the account just signed in the active one, or leave
 * things as they are?
 *
 * Switching accounts restarts every chat's Claude process, so re-signing in
 * an expired spare account -- from the phone, while chats were working --
 * interrupted all of them. Switch only when the account in use cannot work
 * (none active, never signed in, or its login lapsed): that is the first-run
 * case the switch was written for, where staying put meant every message kept
 * failing. A spare account repaired in the background is simply usable again,
 * for rotation to pick up when it needs it.
 */
export function shouldActivateAfterSignIn(accounts: AccountInfo[], signedIn: string | null): boolean {
  const active = accounts.find((a) => a.active);
  if (!active) return true;
  if (active.configDir === signedIn) return false;
  return !active.signedIn || active.loginExpired;
}
