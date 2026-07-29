/**
 * The new-session box is seeded with "<folder>-" so the caret lands after the
 * dash and you type straight into it. Accepting that seed untouched should not
 * produce a session literally named "my-project-".
 */
export function sessionTitleFromInput(raw: string, fallback: string): string {
  const trimmed = raw.trim().replace(/[-\s]+$/, '');
  return trimmed || fallback;
}
