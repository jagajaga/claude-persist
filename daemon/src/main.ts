import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  AccountInfo,
  ModelDescriptor,
  PersistedEvent,
  RateLimits,
  Request,
  ServerMessage,
  SessionInfo,
  UsageSnapshot,
} from '@claude-persist/shared';
import type { HelloResult } from '@claude-persist/shared';
import { PROTOCOL_VERSION } from '@claude-persist/shared';
import { NO_CLAUDE_MESSAGE, claudeExecutable } from './claudeExecutable.js';
import { ensureDirs, socketPath, socketIsFile, lockPath, sessionLogPath, logPath, pendingTurnSessionIds, pendingTurnPath } from './paths.js';
import { releaseLock } from './lock.js';
import { claimOwnership } from './ownership.js';
import { Registry } from './registry.js';
import { DaemonSession } from './session.js';
import { importClaudeSession, listClaudeSessions } from './importer.js';
import { accountIdentity, accountsStore, shareUserConfig } from './accounts.js';
import { LoginManager } from './login.js';
import { applyRateLimitEvent, applyUsageResponse } from './usage.js';
import {
  type IdentityOf,
  type RotationState,
  SWITCH_SETTLE_MS,
  accountForRetry,
  accountKey,
  planAfterLimit,
} from './rotation.js';

/**
 * Group accounts by the login they share. Read fresh rather than cached: these
 * decisions happen only on a rate limit, and a stale identity after a re-login
 * would silently merge or split accounts.
 */
const identityOf: IdentityOf = (account) =>
  accountIdentity(account.configDir) ?? accountKey(account.configDir);

/**
 * Logging comes first and degrades rather than failing, because a crash during
 * module init used to leave no trace anywhere: the uncaughtException handlers
 * were installed at the *bottom* of this file — after ensureDirs() and the log
 * stream had already run — and the extension spawns us with stdio:'ignore', so
 * an unwritable ~/.claude-persist produced a daemon that died silently and an
 * extension that could only report "could not start".
 *
 * The append is synchronous on purpose. A buffered WriteStream drops whatever
 * was written immediately before a process.exit(), which is exactly when this
 * log matters — "daemon already running, exiting" and the server-error path both
 * exit on the next line, and both messages were being lost. This is a
 * lifecycle-only log (a handful of lines per daemon lifetime), so appendFileSync
 * costs nothing next to being able to diagnose a daemon that won't start.
 */
function logLine(text: string): void {
  const line = `${new Date().toISOString()} ${text}\n`;
  try {
    fs.appendFileSync(logPath, line);
  } catch {
    process.stderr.write(line);
  }
}

// Deliberately non-fatal: an uncaught error in one session's callback should
// not take down every other live session with it.
process.on('uncaughtException', (err) => logLine(`uncaught: ${err.stack ?? err.message}`));
process.on('unhandledRejection', (err) => logLine(`unhandled rejection: ${String(err)}`));

try {
  ensureDirs();
} catch (err) {
  logLine(`fatal: cannot create ${logPath}'s directory: ${String(err)}`);
  process.exit(1);
}

/**
 * Events replayed to a freshly attached panel. Chosen so a huge transcript
 * opens instantly; "Load earlier" widens the window on demand.
 */
const DEFAULT_REPLAY_LIMIT = 400;

const registry = new Registry();
const quarantined = registry.load();
if (quarantined) {
  logLine(`registry was unreadable and has been moved to ${quarantined}; starting with no sessions`);
}

const sessions = new Map<string, DaemonSession>();
/** sessionId -> set of client connections subscribed to it */
const subscribers = new Map<string, Set<Client>>();

interface Client {
  socket: net.Socket;
  send(message: ServerMessage): void;
  attached: Set<string>;
}

function broadcast(sessionId: string, message: ServerMessage): void {
  for (const client of subscribers.get(sessionId) ?? []) client.send(message);
}

function broadcastAll(message: ServerMessage): void {
  for (const client of clients) client.send(message);
}

// ---------- model list (learned from the SDK, never hardcoded) --------------

let modelCache: ModelDescriptor[] | null = null;
let modelProbe: Promise<ModelDescriptor[]> | null = null;

function toDescriptors(models: unknown[]): ModelDescriptor[] {
  const out: ModelDescriptor[] = [];
  for (const raw of models) {
    const m = raw as Record<string, unknown>;
    if (typeof m.value !== 'string') continue;
    out.push({
      value: m.value,
      displayName: typeof m.displayName === 'string' ? m.displayName : m.value,
      ...(typeof m.description === 'string' ? { description: m.description } : {}),
      ...(Array.isArray(m.supportedEffortLevels)
        ? { effortLevels: m.supportedEffortLevels as ModelDescriptor['effortLevels'] }
        : {}),
    });
  }
  return out;
}

function cacheModels(models: unknown[]): void {
  const descriptors = toDescriptors(models);
  if (descriptors.length === 0) return;
  const changed = JSON.stringify(descriptors) !== JSON.stringify(modelCache);
  modelCache = descriptors;
  if (changed) broadcastAll({ kind: 'models', models: descriptors });
}

/** No session has run yet: launch a throwaway query just for the init handshake. */
function probeModels(): Promise<ModelDescriptor[]> {
  if (modelCache) return Promise.resolve(modelCache);
  if (modelProbe) return modelProbe;
  modelProbe = (async () => {
    const idleInput = (async function* () {
      await new Promise(() => undefined); // never yields; closed via close()
    })() as AsyncIterable<never>;
    const q = query({ prompt: idleInput, options: { cwd: os.homedir() } });
    try {
      const init = await q.initializationResult();
      if (Array.isArray(init.models)) cacheModels(init.models);
      // Same throwaway query also seeds plan usage, so a freshly started daemon
      // can fill the status bar before any session has run a turn.
      await fetchUsageFrom(q);
    } finally {
      try {
        q.close();
      } catch {
        // already closed
      }
      modelProbe = null;
    }
    return modelCache ?? [];
  })();
  return modelProbe;
}

// ---------- accounts -------------------------------------------------------

/**
 * How often to notice an account appearing or being logged into.
 *
 * Polled rather than watched: logging in writes `.credentials.json` *inside* an
 * existing account directory, which a non-recursive fs.watch on the parent never
 * sees, and recursive watch is not dependable across platforms. The scan is a
 * readdir plus one existsSync per account, so at this interval the cost is
 * nothing next to keeping a watcher per directory correct.
 */
const ACCOUNTS_POLL_MS = 5000;

let lastAccountsJson = '';

/** Broadcast the account list, remembering it so the poller only fires on change. */
function broadcastAccounts(accounts: AccountInfo[]): void {
  lastAccountsJson = JSON.stringify(accounts);
  broadcastAll({ kind: 'accounts', accounts });
}

/**
 * Notice accounts added or logged into outside the extension.
 *
 * Without this the daemon only rescanned when asked, so an account you had just
 * logged into via `claude /login` stayed missing from the model menu until the
 * window was reloaded.
 */
function pollAccounts(): void {
  const accounts = accountsStore.list();
  if (JSON.stringify(accounts) === lastAccountsJson) return;
  // A newly logged-in account starts with no memory and no skills; give it the
  // shared ones before it is offered for use.
  const { claudeDir, accountsDir } = accountsStore.dirs;
  shareUserConfig(claudeDir, accountsDir, logLine);
  broadcastAccounts(accounts);
}

/**
 * Preferences pushed from VS Code settings. Defaults match the contributed
 * defaults, so a daemon that never hears from a client still behaves correctly.
 */
const options = { switchAccountOnLimit: true };

const logins = new LoginManager(
  // Null means "nothing to run"; LoginManager says so rather than spawning a
  // bare 'claude' that fails with ENOENT and no explanation.
  claudeExecutable(),
  path.join(os.homedir(), '.claude-accounts'),
  logLine,
  accountsStore.dirs.claudeDir,
);

/** Which accounts are known spent, and when we last rotated. */
const rotation: RotationState = { limited: new Map(), lastSwitchAt: 0 };

/** Activate an account and tear down live queries, as a user switch would. */
function activateAccount(configDir: string | null, reason: string): void {
  const accounts = accountsStore.setActive(configDir);
  rotation.lastSwitchAt = Date.now();
  const name = accounts.find((a) => a.active)?.name ?? String(configDir);
  // Every session shares the account, so a rotation cuts off every live turn --
  // not only the one that was refused. Queue the others before disposing them,
  // or they die here with nothing scheduled and wait for someone to notice.
  const resumeAt = Date.now() + SWITCH_SETTLE_MS;
  let carried = 0;
  for (const session of sessions.values()) {
    if (session.parkForAccountSwitch(resumeAt, name, reason)) carried++;
    session.disposeActiveQuery();
  }
  if (carried > 0) logLine(`carrying ${carried} running turn(s) across the switch to ${name}`);
  broadcastAccounts(accounts);
  broadcastAll({ kind: 'sessions_changed' });
  logLine(`switched to account ${name} (${reason})`);
}

// ---------- plan rate limits (account-wide, learned from the live SDK push) -

let usage: UsageSnapshot = { windows: {}, subscriptionType: null, available: true };

function broadcastUsage(): void {
  broadcastAll({ kind: 'rateLimits', usage });
}

/** Pull plan usage off a live query; swallows everything (experimental API). */
async function fetchUsageFrom(activeQuery: unknown): Promise<void> {
  const probe = activeQuery as {
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;
  } | null;
  const fetchUsage = probe?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (typeof fetchUsage !== 'function') return;
  try {
    const result = await fetchUsage.call(probe);
    if (result && typeof result === 'object') {
      usage = applyUsageResponse(usage, result as Record<string, unknown>);
      broadcastUsage();
    }
  } catch {
    // no usage is the old behaviour, not a failure
  }
}

const callbacks = {
  onModels(models: unknown[]): void {
    cacheModels(models);
  },
  onRateLimit(info: Record<string, unknown>): void {
    const windows = applyRateLimitEvent(usage.windows, info);
    if (windows === usage.windows) return; // a kind we don't model
    usage = { ...usage, windows };
    broadcastUsage();
  },
  onUsage(raw: Record<string, unknown>): void {
    usage = applyUsageResponse(usage, raw);
    broadcastUsage();
  },
  onEvent(sessionId: string, event: PersistedEvent): void {
    broadcast(sessionId, { kind: 'event', sessionId, event });
    // Status flips (idle/running/error) should update every client's session
    // list, not just subscribers of this session — e.g. the sidebar tree.
    if (event.event.type === 'status') broadcastAll({ kind: 'sessions_changed' });
  },
  onDelta(sessionId: string, text: string): void {
    broadcast(sessionId, { kind: 'delta', sessionId, text });
  },
  onAgents(sessionId: string, agents: Array<{ id: string; description: string }>): void {
    broadcast(sessionId, { kind: 'agents', sessionId, agents });
  },
  onMetaChanged(): void {
    registry.save();
  },
  rateLimitWindows(): RateLimits {
    return usage.windows;
  },
  /**
   * The active account was refused. Record it, move to one with room if that is
   * enabled and one exists, and say when the session should try again.
   */
  onLimited(ownResetAt: number): { retryAt: number; switchedTo: string | null; why: string } {
    const now = Date.now();
    const current = accountsStore.active;
    // Key by identity: two directories logged into the same account share one
    // quota, so refusing one means the other is spent too.
    const currentAccount = accountsStore.list().find((a) => a.active);
    rotation.limited.set(
      currentAccount ? identityOf(currentAccount) : accountKey(current),
      ownResetAt,
    );
    const plan = planAfterLimit({
      accounts: accountsStore.list(),
      current,
      state: rotation,
      now,
      ownResetAt,
      enabled: options.switchAccountOnLimit,
      identityOf,
    });
    if (plan.switchTo) {
      activateAccount(plan.switchTo.configDir, 'rate limit on the previous account');
      return { retryAt: plan.retryAt, switchedTo: plan.switchTo.name, why: plan.why };
    }
    // Name the accounts considered, so "every account" can be checked rather
    // than taken on trust.
    const groups = new Set(accountsStore.list().map((a) => identityOf(a)));
    logLine(
      `limit handling: ${plan.why}; ${groups.size} distinct account(s), ` +
        `${rotation.limited.size} marked limited; retry at ${new Date(plan.retryAt).toISOString()}`,
    );
    return { retryAt: plan.retryAt, switchedTo: null, why: plan.why };
  },
  /**
   * A queued retry is about to fire. Decided here rather than at park time so we
   * land on the account whose limit has actually ended.
   */
  beforeRetry(): string | null {
    const now = Date.now();
    for (const [key, until] of rotation.limited) if (until <= now) rotation.limited.delete(key);
    const target = accountForRetry(
      accountsStore.list(),
      accountsStore.active,
      rotation,
      now,
      options.switchAccountOnLimit,
      identityOf,
    );
    if (!target) return null;
    activateAccount(target.configDir, 'its limit has ended');
    return target.name;
  },
  log(message: string): void {
    logLine(message);
  },
};

function getSession(id: string): DaemonSession {
  let session = sessions.get(id);
  if (!session) {
    const meta = registry.get(id);
    if (!meta) throw new Error(`Unknown session: ${id}`);
    session = new DaemonSession(meta, callbacks);
    sessions.set(id, session);
  }
  return session;
}

function sessionInfo(id: string): SessionInfo {
  const meta = registry.get(id)!;
  const live = sessions.get(id);
  return {
    id: meta.id,
    title: meta.title,
    cwd: meta.cwd,
    status: live?.status ?? 'idle',
    permissionMode: meta.permissionMode ?? 'default',
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.effort ? { effort: meta.effort } : {}),
    createdAt: meta.createdAt,
    lastActivityAt: meta.lastActivityAt,
    eventCount: live?.eventCount ?? 0,
    ...(live?.retryAt ? { retryAt: live.retryAt } : {}),
  };
}

function handleRequest(client: Client, req: Request): unknown | Promise<unknown> {
  switch (req.op) {
    case 'hello':
      return {
        protocolVersion: PROTOCOL_VERSION,
        pid: process.pid,
        // Told to us by the extension that spawned us; absent in a dev checkout.
        version: process.env.CLAUDE_PERSIST_VERSION ?? null,
        // process.argv[1] is the daemon entry the extension spawned us with.
        // The client checks it still exists: an upgrade that doesn't change
        // the protocol keeps this daemon alive on purpose, but VS Code has by
        // then deleted the versioned extension directory this file — and the
        // bundled SDK, and its native `claude` binary — was loaded from.
        entry: process.argv[1] ?? '',
      } satisfies HelloResult;
    case 'listSessions':
      return registry.list().map((meta) => sessionInfo(meta.id));
    case 'createSession': {
      const meta = registry.create(req.cwd, req.title);
      broadcastAll({ kind: 'sessions_changed' });
      return sessionInfo(meta.id);
    }
    case 'attach': {
      const session = getSession(req.sessionId);
      client.attached.add(req.sessionId);
      let subs = subscribers.get(req.sessionId);
      if (!subs) subscribers.set(req.sessionId, (subs = new Set()));
      subs.add(client);
      const limit = req.limit && req.limit > 0 ? req.limit : DEFAULT_REPLAY_LIMIT;
      // eventsSince keeps the newest `limit` itself, so a huge transcript is
      // never materialized just to throw most of it away.
      const { events, hasEarlier } = session.eventsSince(req.sinceSeq, limit);
      return {
        info: sessionInfo(req.sessionId),
        events,
        hasEarlier,
      };
    }
    case 'detach': {
      client.attached.delete(req.sessionId);
      subscribers.get(req.sessionId)?.delete(client);
      return null;
    }
    case 'sendMessage': {
      const session = getSession(req.sessionId);
      session.sendMessage(req.text, req.attachments ?? []);
      registry.touch(req.sessionId);
      return null;
    }
    case 'interrupt': {
      void getSession(req.sessionId).interrupt();
      return null;
    }
    case 'permission': {
      getSession(req.sessionId).resolvePermission(req.requestId, req.allow, req.message, req.answers);
      return null;
    }
    case 'setPermissionMode': {
      void getSession(req.sessionId).setPermissionMode(req.mode);
      return null;
    }
    case 'setSessionOptions': {
      void getSession(req.sessionId).setOptions({ model: req.model, effort: req.effort });
      broadcastAll({ kind: 'sessions_changed' });
      return null;
    }
    case 'renameSession': {
      const title = req.title.trim();
      if (!title) throw new Error('Title cannot be empty');
      registry.rename(req.sessionId, title);
      broadcastAll({ kind: 'sessions_changed' });
      return sessionInfo(req.sessionId);
    }
    case 'listModels':
      return modelCache ?? probeModels();
    case 'listRateLimits':
      return usage;
    case 'listClaudeSessions':
      return listClaudeSessions();
    case 'importClaudeSession': {
      const meta = importClaudeSession(registry, req.file);
      broadcastAll({ kind: 'sessions_changed' });
      return sessionInfo(meta.id);
    }
    case 'deleteSession': {
      void sessions.get(req.sessionId)?.dispose(); // never rejects; nothing to await on
      sessions.delete(req.sessionId);
      subscribers.delete(req.sessionId);
      registry.delete(req.sessionId);
      try {
        fs.unlinkSync(sessionLogPath(req.sessionId));
      } catch {
        // already gone
      }
      broadcastAll({ kind: 'sessions_changed' });
      return null;
    }
    case 'setOptions': {
      if (typeof req.switchAccountOnLimit === 'boolean') {
        options.switchAccountOnLimit = req.switchAccountOnLimit;
      }
      return options;
    }
    case 'startLogin':
      return logins.start(req.name);
    case 'submitLoginCode':
      return logins.submitCode(req.loginId, req.code).then((result) => {
        if (!result.ok || !result.configDir) return result;
        // Make the account we just signed into the one in use. Without this the
        // panel reported success and every message went on failing against the
        // unauthenticated default — the single worst first-run experience here.
        pollAccounts();
        // The default account is `null` in the account list, not its path, so a
        // sign-in to ~/.claude has to be translated back or it would activate
        // an "account" nothing in the list matches.
        const signedIn =
          result.configDir === accountsStore.dirs.claudeDir ? null : result.configDir;
        activateAccount(signedIn, 'signed in');
        return result;
      });
    case 'cancelLogin': {
      logins.cancel(req.loginId);
      return null;
    }
    case 'stopAgent':
      return getSession(req.sessionId).stopAgent(req.taskId);
    case 'listAccounts':
      return accountsStore.list();
    case 'setAccount': {
      const accounts = accountsStore.setActive(req.configDir);
      // Live queries were launched with the previous account's env (or none);
      // tear them down so the next message spawns fresh under the new one.
      // Sessions and transcripts are untouched — only the in-flight SDK query.
      for (const session of sessions.values()) session.disposeActiveQuery();
      broadcastAccounts(accounts);
      broadcastAll({ kind: 'sessions_changed' });
      return accounts;
    }
    default:
      throw new Error(`Unknown op: ${(req as { op: string }).op}`);
  }
}

const clients = new Set<Client>();

function onConnection(socket: net.Socket): void {
  const client: Client = {
    socket,
    attached: new Set(),
    send(message: ServerMessage): void {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
    },
  };
  clients.add(client);

  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let req: Request;
      try {
        req = JSON.parse(line) as Request;
      } catch {
        continue;
      }
      try {
        Promise.resolve(handleRequest(client, req)).then(
          (result) => client.send({ kind: 'response', id: req.id, ok: true, result }),
          (err) =>
            client.send({
              kind: 'response',
              id: req.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
        );
      } catch (err) {
        client.send({
          kind: 'response',
          id: req.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  const cleanup = (): void => {
    clients.delete(client);
    for (const sessionId of client.attached) subscribers.get(sessionId)?.delete(client);
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

/** How long SDK query teardown gets before we exit anyway. */
const SHUTDOWN_GRACE_MS = 2000;
/** How often to confirm the socket we bound is still the one at socketPath. */
const SOCKET_WATCH_MS = 5000;

/** Set once teardown begins, so the socket watcher stops second-guessing it. */
let shuttingDown = false;

async function start(): Promise<void> {
  if (!(await claimOwnership({ lockFile: lockPath, socketPath, log: logLine }))) {
    process.exit(0);
  }
  // The lock is ours, so any socket file still sitting here is stale by
  // definition — no live daemon could have been holding it. A Windows named
  // pipe has no file to remove: it disappears with the process that owned it.
  if (socketIsFile) {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // wasn't there
    }
  }

  /** Every server we've bound; kept so shutdown closes them all. */
  const servers: net.Server[] = [];
  /** Identifies the socket file we bound, so shutdown doesn't delete someone else's. */
  let boundIno: number | null = null;

  const onServerError = (err: Error): void => {
    // Previously unhandled: EADDRINUSE was swallowed by the uncaughtException
    // logger and left this process alive with no listener at all — a zombie
    // that the next client's probe would connect to and then hang against,
    // forever, because requests had no timeout either.
    logLine(`server error, exiting: ${String(err)}`);
    releaseLock();
    process.exit(1);
  };

  const bind = (): void => {
    const server = net.createServer(onConnection);
    servers.push(server);
    server.on('error', onServerError);
    server.listen(socketPath, () => {
      // A named pipe is neither chmod-able nor stat-able. Its access is already
      // limited to this session, and with no inode there is nothing for the
      // self-heal watch below to compare — it stands down via boundIno === null.
      if (socketIsFile) {
        fs.chmodSync(socketPath, 0o600);
        try {
          boundIno = fs.statSync(socketPath).ino;
        } catch {
          boundIno = null;
        }
      }
      logLine(`daemon listening on ${socketPath} (pid ${process.pid})`);
    });
  };
  bind();

  /**
   * Self-heal: notice when our socket file stops being ours.
   *
   * Builds up to 0.7.32 unlink socketPath unconditionally on shutdown, so an
   * older daemon exiting during an upgrade silently deletes the socket a newer
   * one is serving on. The newer daemon stayed alive and healthy while being
   * completely unreachable — clients got ENOENT, and because it still held the
   * lock, every replacement they spawned exited as "already running".
   *
   * Rebinding costs one stat every few seconds and turns that permanent wedge
   * into a few seconds of downtime. A fresh server is bound rather than reusing
   * the old one, because close() only completes once existing connections end,
   * and those connections are still perfectly good.
   */
  const socketWatch = setInterval(() => {
    if (shuttingDown || boundIno === null) return;
    let ino: number | null = null;
    try {
      ino = fs.statSync(socketPath).ino;
    } catch {
      ino = null;
    }
    if (ino === boundIno) return;
    if (ino === null) {
      logLine('socket file vanished (an older daemon unlinked it) — rebinding');
      boundIno = null;
      bind();
      return;
    }
    // Someone else bound a new socket at our path. Two servers answering as
    // "the daemon" is worse than none: they would both append to the same
    // session logs and race registry writes. Newest wins; stand down.
    logLine(`socket at ${socketPath} is now owned by another daemon — exiting`);
    releaseLock();
    process.exit(0);
  }, SOCKET_WATCH_MS);
  socketWatch.unref();

  // Re-arm any turn parked by a rate limit before this daemon restarted. These
  // sessions are constructed eagerly (normally they load lazily on attach),
  // because nothing would otherwise touch them until the user came back — which
  // is precisely the waiting-around this feature exists to remove.
  for (const sessionId of pendingTurnSessionIds()) {
    if (!registry.get(sessionId)) {
      try {
        fs.unlinkSync(pendingTurnPath(sessionId));
      } catch {
        // session was deleted; drop its orphaned parked turn
      }
      continue;
    }
    try {
      getSession(sessionId).restorePending();
    } catch (err) {
      logLine(`could not restore queued turn for ${sessionId}: ${String(err)}`);
    }
  }

  // Rules and skills are the same for every account, including any added while
  // this daemon was not running.
  const accountDirs = accountsStore.dirs;
  shareUserConfig(accountDirs.claudeDir, accountDirs.accountsDir, logLine);

  // Seed the cache, then keep watching for logins.
  lastAccountsJson = JSON.stringify(accountsStore.list());
  const accountsTimer = setInterval(pollAccounts, ACCOUNTS_POLL_MS);
  accountsTimer.unref();

  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    process.exit(0);
  };

  const shutdown = (signal: string): void => {
    if (shuttingDown) return; // a second SIGTERM must not re-enter teardown
    shuttingDown = true;
    clearInterval(socketWatch);
    clearInterval(accountsTimer);
    logLine(`daemon shutting down (${signal})`);
    for (const server of servers) server.close();
    // Only remove the socket if it is still the one we bound. Unconditional
    // unlink meant a daemon exiting slowly during an upgrade deleted its own
    // *replacement's* socket on the way out, leaving a healthy daemon that
    // nothing could reach and a client stuck reconnecting to nothing.
    try {
      if (socketIsFile && boundIno !== null && fs.statSync(socketPath).ino === boundIno) {
        fs.unlinkSync(socketPath);
      }
    } catch {
      // already gone
    }
    releaseLock();
    // Queue whatever was mid-turn BEFORE disposing, or closing the query
    // destroys the only evidence that work was in progress.
    let parked = 0;
    for (const session of sessions.values()) if (session.parkForRestart()) parked++;
    if (parked) logLine(`queued ${parked} in-flight turn(s) to continue after restart`);
    // Give SDK teardown a bounded moment: exiting immediately after dispose()
    // skipped it entirely and orphaned `claude` children on every kill cycle.
    void Promise.allSettled([...sessions.values()].map((s) => s.dispose())).then(finish);
    setTimeout(finish, SHUTDOWN_GRACE_MS).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void start();
