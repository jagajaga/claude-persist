// Logging into an account without putting a terminal in front of the user.
//
// The CLI's `auth login` is interactive, but only its *TTY* path assumes the
// browser is on the same machine — it starts a loopback callback server and
// redirects to localhost, which is simply wrong under code-server, where the
// browser is on the user's laptop and the CLI is on the server.
//
// Driven with piped (non-TTY) stdio it behaves exactly as needed: it prints the
// authorize URL, uses Anthropic's *hosted* callback
// (platform.claude.com/oauth/code/callback), and waits for a pasted code on
// stdin. So the daemon runs it, hands the URL to the extension to open, and
// feeds back the code the user pastes into a normal input box.
import fs from 'node:fs';
import os from 'node:os';
import { NO_CLAUDE_MESSAGE } from './claudeExecutable.js';
import { DEFAULT_ACCOUNT_NAME } from './accounts.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** Give the CLI this long to print its authorize URL before giving up. */
const URL_TIMEOUT_MS = 30_000;
/** After the code is submitted, how long to wait for the CLI to finish. */
const EXCHANGE_TIMEOUT_MS = 60_000;
/** An abandoned login holds a child process; don't keep it forever. */
const ABANDON_TIMEOUT_MS = 15 * 60_000;

/** ANSI escapes make the URL unmatchable; the CLI emits them even when piped. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*[a-zA-Z]/g, '');
}

/** The authorize URL the CLI prints, or null if this chunk doesn't have it yet. */
export function extractAuthUrl(output: string): string | null {
  // Under a terminal (setup-token) the link is a hyperlink escape whose visible
  // text is laid out with cursor moves; the escape's target is the exact URL.
  // eslint-disable-next-line no-control-regex
  const linked = /\x1b\]8;[^;]*;(https:\/\/[^\x07\x1b\s]*\/oauth\/authorize\?[^\x07\x1b\s]+)/.exec(output);
  if (linked) return linked[1];
  const match = /https:\/\/[^\s"']*\/oauth\/authorize\?[^\s"']+/.exec(stripAnsi(output));
  return match ? match[0] : null;
}

/**
 * The code to give Claude, from whatever was pasted: the code itself
 * (`code#state`), or the whole address of the page that showed it -- the
 * easy thing to copy by mistake on a phone. Spaces and line breaks a
 * keyboard adds are dropped.
 */
export function normalizeLoginCode(pasted: string): string {
  const text = pasted.replace(/\s+/g, '');
  if (!/^https?:\/\//i.test(text)) return text;
  try {
    const url = new URL(text);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state') ?? (url.hash.length > 1 ? url.hash.slice(1) : null);
    if (code) return state ? `${code}#${state}` : code;
  } catch {
    // not an address after all
  }
  return text;
}

/** What a pasted code looked like, for the log: never the code itself. */
export function codeShape(pasted: string): string {
  const t = pasted.trim();
  return `${t.length} chars, ${t.includes('#') ? 'with' : 'no'} #, ${/^https?:\/\//i.test(t) ? 'an address' : 'not an address'}${/\s/.test(t) ? ', has spaces' : ''}`;
}

/** The long-lived token `claude setup-token` prints at the end, or null. */
export function extractSetupToken(output: string): string | null {
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  const match = /sk-ant-oat\d\d-[A-Za-z0-9_-]{20,}/.exec(plain);
  return match ? match[0] : null;
}

/**
 * Did the CLI report a successful login?
 *
 * Exit code alone is not trusted: the source of truth is `auth status --json` in
 * the same config dir, checked separately. This only classifies the CLI's own
 * complaint so the user sees why it failed rather than a bare "login failed".
 */
export function loginFailureReason(output: string): string | null {
  // Under a terminal (setup-token) Claude says why in its own words; pass them on.
  // eslint-disable-next-line no-control-regex
  const flat = output.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ' ').replace(/\s+/g, ' ');
  const own = /OAuth error:\s*(.+?)(?:\s*Press Enter to retry|$)/.exec(flat);
  if (own) return own[1].trim();
  const clean = stripAnsi(output);
  if (/invalid.{0,20}code|code.{0,20}(invalid|expired)/i.test(clean)) {
    return 'That code was not accepted — it may have expired. Try signing in again.';
  }
  if (/already logged in/i.test(clean)) return null;
  return null;
}

interface PendingLogin {
  id: string;
  name: string;
  /** login: sign this account in. token: `claude setup-token`, a long-lived token for other programs. */
  purpose: LoginPurpose;
  configDir: string;
  child: ChildProcessWithoutNullStreams;
  output: string;
  abandonTimer: NodeJS.Timeout;
}

export type LoginPurpose = 'login' | 'token';

export interface LoginStarted {
  loginId: string;
  url: string;
  configDir: string;
}

export class LoginManager {
  private readonly pending = new Map<string, PendingLogin>();

  constructor(
    /** null when this machine has no Claude Code to run — see claudeExecutable. */
    private readonly claudeBin: string | null,
    private readonly accountsDir: string,
    private readonly log: (message: string) => void = () => undefined,
    /** ~/.claude, so the default account can be signed in to as well. */
    private readonly claudeDir: string = path.join(os.homedir(), '.claude'),
  ) {}

  /**
   * Where a login writes its credentials.
   *
   * Sign-in could only ever create a *named* account, so on a machine with no
   * Claude Code login the one account the UI lists first could never be filled
   * in — the user had to make up a name for what was really their only login.
   */
  private configDirFor(name: string): string {
    return name === DEFAULT_ACCOUNT_NAME ? this.claudeDir : path.join(this.accountsDir, name);
  }

  /**
   * Start a login and resolve once the CLI has printed its authorize URL.
   *
   * The child is left running with its stdin open: it is waiting for the code,
   * which arrives later via submitCode.
   */
  start(name: string, purpose: LoginPurpose = 'login'): Promise<LoginStarted> {
    // Nothing to sign in with. Saying so beats `spawn claude ENOENT`, which is
    // what a macOS or Windows user hit here: the bundled binary is built for
    // the packaged platform only.
    if (!this.claudeBin) return Promise.reject(new Error(NO_CLAUDE_MESSAGE));
    if (!/^[a-z0-9-]+$/.test(name)) {
      return Promise.reject(new Error('Account name may use lowercase letters, digits and hyphens only'));
    }
    const configDir = this.configDirFor(name);
    fs.mkdirSync(configDir, { recursive: true });

    // A Windows install can be a .cmd shim, which CreateProcess cannot run
    // directly; everything else is spawned without a shell, as before.
    const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, BROWSER: 'true' };
    const child = (
      purpose === 'token'
        ? // setup-token prints nothing without a terminal; `script` gives it one
          // (util-linux). Wide, so the token is never wrapped across lines.
          spawn('script', ['-qfc', `stty cols 1000; exec '${this.claudeBin.replace(/'/g, `'\\''`)}' setup-token`, '/dev/null'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...env, COLUMNS: '1000' },
          })
        : spawn(this.claudeBin, ['auth', 'login', '--claudeai'], {
            shell: /\.(cmd|bat)$/i.test(this.claudeBin),
            // Piped stdio is what selects the hosted-callback, paste-a-code flow.
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
          })
    ) as ChildProcessWithoutNullStreams;

    const id = randomUUID();
    const entry: PendingLogin = {
      id,
      name,
      purpose,
      configDir,
      child,
      output: '',
      abandonTimer: setTimeout(() => this.cancel(id, 'abandoned'), ABANDON_TIMEOUT_MS),
    };
    entry.abandonTimer.unref();
    this.pending.set(id, entry);

    return new Promise<LoginStarted>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.cancel(id, 'no URL');
        reject(new Error('Timed out waiting for the sign-in link'));
      }, URL_TIMEOUT_MS);
      timer.unref();

      const onData = (chunk: Buffer): void => {
        entry.output += chunk.toString('utf8');
        const url = extractAuthUrl(entry.output);
        if (!url || settled) return;
        settled = true;
        clearTimeout(timer);
        this.log(`login ${name}: authorize URL ready`);
        resolve({ loginId: id, url, configDir });
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancel(id, 'spawn failed');
        reject(err);
      });
      child.once('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`Sign-in exited before producing a link (code ${String(code)})`));
      });
    });
  }

  /**
   * Feed the pasted code to a waiting login and report whether it worked.
   *
   * Success is decided by `auth status --json` in the target dir, not by the
   * CLI's exit code — the credentials file existing and reporting loggedIn is
   * the thing that actually matters to everything downstream.
   */
  async submitCode(
    loginId: string,
    code: string,
  ): Promise<{ ok: boolean; error?: string; configDir?: string; token?: string }> {
    const entry = this.pending.get(loginId);
    if (!entry) return { ok: false, error: 'That sign-in is no longer active — start again.' };
    const trimmed = normalizeLoginCode(code);
    if (!trimmed) return { ok: false, error: 'No code was entered.' };
    this.log(`${entry.purpose === 'token' ? 'setup-token' : 'login'} ${entry.name}: code pasted (${codeShape(code)})`);

    const exited = new Promise<void>((resolve) => {
      const done = (): void => resolve();
      entry.child.once('exit', done);
      setTimeout(done, EXCHANGE_TIMEOUT_MS).unref();
      // A token is the whole answer: no need to wait for the CLI to exit.
      if (entry.purpose === 'token') {
        const sentAt = entry.output.length;
        const poll = setInterval(() => {
          // A token, or Claude refusing the code: either way the answer is in.
          if (extractSetupToken(entry.output) || /OAuth error:/.test(entry.output.slice(sentAt))) {
            clearInterval(poll);
            done();
          }
        }, 200);
        poll.unref();
        entry.child.once('exit', () => clearInterval(poll));
      }
    });
    try {
      // A terminal takes Enter as a carriage return.
      entry.child.stdin.write(entry.purpose === 'token' ? `${trimmed}\r` : `${trimmed}\n`);
    } catch {
      return { ok: false, error: 'The sign-in process is no longer accepting input.' };
    }
    await exited;
    clearTimeout(entry.abandonTimer);
    this.pending.delete(loginId);

    if (entry.purpose === 'token') {
      const token = extractSetupToken(entry.output);
      try {
        entry.child.kill('SIGTERM');
      } catch {
        // already gone
      }
      // Never logged, never stored: it goes to the one who asked, once.
      if (token) {
        this.log(`setup-token ${entry.name}: issued`);
        return { ok: true, token };
      }
      this.log(`setup-token ${entry.name}: failed`);
      return { ok: false, error: loginFailureReason(entry.output) ?? 'No token came back. Check the code and try again.' };
    }

    const loggedIn = await this.isLoggedIn(entry.configDir);
    if (loggedIn === 'unknown') {
      return {
        ok: false,
        error:
          'Could not check whether the sign-in worked — Claude Code did not run. ' +
          NO_CLAUDE_MESSAGE,
      };
    }
    if (loggedIn) {
      this.log(`login ${entry.name}: succeeded`);
      // The caller activates this directory. A sign-in that leaves you on the
      // account you could not use is not a sign-in: every message still failed
      // while the panel said "Signed in".
      return { ok: true, configDir: entry.configDir };
    }
    const reason = loginFailureReason(entry.output);
    this.log(`login ${entry.name}: failed`);
    return { ok: false, error: reason ?? 'Sign-in did not complete. Check the code and try again.' };
  }

  cancel(loginId: string, why = 'cancelled'): void {
    const entry = this.pending.get(loginId);
    if (!entry) return;
    clearTimeout(entry.abandonTimer);
    this.pending.delete(loginId);
    try {
      entry.child.kill('SIGTERM');
    } catch {
      // already gone
    }
    this.log(`login ${entry.name}: ${why}`);
  }

  /**
   * Ask the CLI, rather than inferring from files whose shape may change.
   *
   * 'unknown' is not 'no'. The probe failing to run at all used to read as
   * "not logged in", so a machine where the binary could not be spawned told
   * the user their code was wrong and to try again — advice that could never
   * work, for a problem they were never told about.
   */
  private isLoggedIn(configDir: string): Promise<boolean | 'unknown'> {
    return new Promise((resolve) => {
      if (!this.claudeBin) return resolve('unknown');
      const probe = spawn(this.claudeBin, ['auth', 'status', '--json'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      });
      let out = '';
      probe.stdout.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      const finish = (): void => {
        try {
          resolve(JSON.parse(stripAnsi(out)).loggedIn === true);
        } catch {
          resolve(false);
        }
      };
      probe.once('exit', finish);
      probe.once('error', () => resolve('unknown'));
      setTimeout(() => {
        probe.kill();
        finish();
      }, 15_000).unref();
    });
  }
}
