import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAuthUrl, loginFailureReason } from './login.js';

const ESC = '';

/**
 * Captured verbatim from `claude auth login --claudeai` run with piped stdio.
 *
 * The important part is the redirect_uri: driven this way the CLI uses
 * Anthropic's *hosted* callback, not the localhost one its TTY path assumes —
 * which is what made sign-in unusable under code-server, where the browser is on
 * the user's machine and the CLI is on the server.
 */
const REAL_OUTPUT =
  'Opening browser to sign in…\n' +
  "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true" +
  '&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code' +
  '&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback' +
  '&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=rzPSoMvk&code_challenge_method=S256' +
  '&state=X8_zCX3X\n' +
  'Paste code here if prompted > ';

test('extractAuthUrl: finds the authorize URL in the real CLI output', () => {
  const url = extractAuthUrl(REAL_OUTPUT);
  assert.ok(url);
  assert.ok(url.startsWith('https://claude.com/cai/oauth/authorize?'));
  assert.ok(url.includes('code_challenge_method=S256'), 'the whole query must survive');
});

test('extractAuthUrl: the callback is hosted, never localhost', () => {
  const url = extractAuthUrl(REAL_OUTPUT) ?? '';
  assert.ok(
    url.includes('redirect_uri=https%3A%2F%2Fplatform.claude.com'),
    'piped stdio must select the hosted callback',
  );
  assert.doesNotMatch(url, /localhost|127\.0\.0\.1/);
});

/** The CLI emits escapes even when piped; an unstripped URL is unusable. */
test('extractAuthUrl: survives ANSI escapes around the URL', () => {
  const dressed = `${ESC}[2mvisit:${ESC}[0m https://claude.com/cai/oauth/authorize?code=true&state=x${ESC}[0m\n`;
  assert.equal(extractAuthUrl(dressed), 'https://claude.com/cai/oauth/authorize?code=true&state=x');
});

test('extractAuthUrl: null until the URL has actually been printed', () => {
  assert.equal(extractAuthUrl('Opening browser to sign in…\n'), null);
  assert.equal(extractAuthUrl(''), null);
  // A partial chunk must not yield a truncated URL that would 404 in a browser.
  assert.equal(extractAuthUrl('visit: https://claude.com/cai/oauth/auth'), null);
});

test('loginFailureReason: explains a rejected code instead of a bare failure', () => {
  assert.match(loginFailureReason('Error: invalid code provided') ?? '', /not accepted|expired/i);
  assert.match(loginFailureReason('The code has expired') ?? '', /not accepted|expired/i);
});

test('loginFailureReason: null when the output says nothing useful', () => {
  assert.equal(loginFailureReason('Opening browser to sign in…'), null);
  assert.equal(loginFailureReason(''), null);
});
