// Turning the SDK's failures into something a user can act on.
//
// Every error from a turn was passed through verbatim, which is fine for
// "context low" and useless for the two that a new user actually hits first:
// not being signed in, and not having Claude Code at all. Those arrived as
// `Invalid API key · Please run /login` — advice for a terminal this extension
// exists to avoid — or as a sentence about npm optional dependencies.
//
// The original text is kept: it is the only diagnostic when the guess is wrong.
import { NO_CLAUDE_MESSAGE } from './claudeExecutable.js';

/** Where sign-in actually is, in the two places a user can reach it. */
export const SIGN_IN_HINT =
  'Not signed in to Claude. Run "Claude Persist: Add Account (Sign In)" from the ' +
  'Command Palette, or open the model pill at the bottom of this chat and choose ' +
  '"Log in to another account…".';

const AUTH = [
  /invalid api key/i,
  /please run \/login/i,
  /\bnot logged in\b/i,
  /authentication[_ ]error/i,
  /\bunauthorized\b/i,
  /\boauth\b.*\bexpired\b/i,
  /\blog ?in\b.*\brequired\b/i,
];

const MISSING_BINARY = [
  /native cli binary/i,
  /claude code executable not found/i,
  /spawn .*claude.* enoent/i,
];

/**
 * An actionable version of an error, or the original when nothing is known
 * about it. Never swallows the detail — the hint is prepended, not substituted.
 */
export function friendlyError(message: string): string {
  const text = String(message ?? '');
  if (!text.trim()) return text;
  if (MISSING_BINARY.some((re) => re.test(text))) return `${NO_CLAUDE_MESSAGE}\n\n(${text})`;
  if (AUTH.some((re) => re.test(text))) return `${SIGN_IN_HINT}\n\n(${text})`;
  return text;
}

/** True when this looks like a failure the user has to fix before retrying. */
export function isSetupFailure(message: string): boolean {
  const text = String(message ?? '');
  return [...AUTH, ...MISSING_BINARY].some((re) => re.test(text));
}
