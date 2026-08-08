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
  const match = /https:\/\/[^\s"']*\/oauth\/authorize\?[^\s"']+/.exec(stripAnsi(output));
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
  configDir: string;
  child: ChildProcessWithoutNullStreams;
  output: string;
  abandonTimer: NodeJS.Timeout;
}

export interface LoginStarted {
  loginId: string;
  url: string;
  configDir: string;
}

export class LoginManager {
  private readonly pending = new Map<string, PendingLogin>();

  constructor(
    private readonly claudeBin: string,
    private readonly accountsDir: string,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  /**
   * Start a login and resolve once the CLI has printed its authorize URL.
   *
   * The child is left running with its stdin open: it is waiting for the code,
   * which arrives later via submitCode.
   */
  start(name: string): Promise<LoginStarted> {
    if (!/^[a-z0-9-]+$/.test(name)) {
      return Promise.reject(new Error('Account name may use lowercase letters, digits and hyphens only'));
    }
    const configDir = path.join(this.accountsDir, name);
    fs.mkdirSync(configDir, { recursive: true });

    const child = spawn(this.claudeBin, ['auth', 'login', '--claudeai'], {
      // Piped stdio is what selects the hosted-callback, paste-a-code flow.
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, BROWSER: 'true' },
    }) as ChildProcessWithoutNullStreams;

    const id = randomUUID();
    const entry: PendingLogin = {
      id,
      name,
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
  async submitCode(loginId: string, code: string): Promise<{ ok: boolean; error?: string }> {
    const entry = this.pending.get(loginId);
    if (!entry) return { ok: false, error: 'That sign-in is no longer active — start again.' };
    const trimmed = code.trim();
    if (!trimmed) return { ok: false, error: 'No code was entered.' };

    const exited = new Promise<void>((resolve) => {
      const done = (): void => resolve();
      entry.child.once('exit', done);
      setTimeout(done, EXCHANGE_TIMEOUT_MS).unref();
    });
    try {
      entry.child.stdin.write(`${trimmed}\n`);
    } catch {
      return { ok: false, error: 'The sign-in process is no longer accepting input.' };
    }
    await exited;
    clearTimeout(entry.abandonTimer);
    this.pending.delete(loginId);

    const loggedIn = await this.isLoggedIn(entry.configDir);
    if (loggedIn) {
      this.log(`login ${entry.name}: succeeded`);
      return { ok: true };
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

  /** Ask the CLI, rather than inferring from files whose shape may change. */
  private isLoggedIn(configDir: string): Promise<boolean> {
    return new Promise((resolve) => {
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
      probe.once('error', () => resolve(false));
      setTimeout(() => {
        probe.kill();
        finish();
      }, 15_000).unref();
    });
  }
}
