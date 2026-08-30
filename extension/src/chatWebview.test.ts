import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

// jsdom gives the webview client (extension/media/chat.js) a real DOM to run
// against — the only way to exercise its ~1200 lines of branching logic
// outside a live VS Code webview, where every user-visible bug in recent
// releases actually lived. This file is the one place in the compiled
// extension host allowed to require() a bare, dev-only package — see the
// named exception in packaging.test.ts for why that's safe.
const { JSDOM } = require('jsdom') as {
  JSDOM: new (
    html: string,
    options?: Record<string, unknown>,
  ) => { window: JsdomWindow };
};

// Minimal shape of what we touch on the jsdom window; jsdom ships no types
// of its own, this project's tsconfig has no "dom" lib (extension-host code
// has no business referencing browser globals), and this file intentionally
// avoids pulling in @types/jsdom or the dom lib for one test file's sake —
// hence `any`/`DomNode` stand-ins instead of real DOM interfaces below.
type DomNode = any; // eslint-disable-line @typescript-eslint/no-explicit-any

interface JsdomWindow {
  document: DomNode;
  Element: {
    prototype: {
      scrollIntoView: (...args: unknown[]) => void;
      getBoundingClientRect: (...args: unknown[]) => unknown;
    };
  };
  MessageEvent: new (type: string, init: { data: unknown }) => DomNode;
  MouseEvent: new (type: string, init?: Record<string, unknown>) => DomNode;
  KeyboardEvent: new (type: string, init?: Record<string, unknown>) => DomNode;
  setTimeout: (cb: () => void, ms: number) => unknown;
  dispatchEvent: (event: DomNode) => boolean;
  acquireVsCodeApi?: () => unknown;
  IntersectionObserver?: unknown;
  navigator: { onLine: boolean };
  /** Stubbed per harness: chat.js asks it whether this is a touch device. */
  matchMedia: (query: string) => DomNode;
  /** jsdom has no visual viewport; the soft-keyboard fit needs one. */
  visualViewport?: DomNode;
  innerHeight: number;
  EventTarget: new () => DomNode;
  Date: { now: () => number };
  close(): void;
}

/**
 * Every harness holds a live jsdom window, and `pretendToBeVisual` keeps a
 * requestAnimationFrame loop running in each one. Left open they hold the
 * event loop up and node:test never exits, so close them all at the end
 * rather than relying on each test to remember.
 */
const openHarnesses: Array<{ close(): void }> = [];
after(() => {
  for (const harness of openHarnesses) {
    try {
      harness.close();
    } catch {
      // already closed by a test that cleaned up after itself
    }
  }
});

const MEDIA_DIR = path.join(__dirname, '../media');
const CHAT_JS = fs.readFileSync(path.join(MEDIA_DIR, 'chat.js'), 'utf8');
const STREAMING_MARKDOWN_JS = fs.readFileSync(
  path.join(MEDIA_DIR, 'streamingMarkdown.js'),
  'utf8',
);

/**
 * The DOM skeleton chat.js expects, mirroring the ids/structure built by
 * ChatPanelManager.html() in chatPanel.ts (#messages, #thread, #input, #send,
 * #perm-toggle, #attach, #chips, #context-ring [+ its .ring-fg circle],
 * #model-pill, #model-pill-label, #prompt-bar, #branch-chip, #composer,
 * #composer-row). chat.js reads all of these by id at load time, several of
 * them synchronously in top-level addEventListener calls, so a missing id
 * throws before a single event can be dispatched.
 *
 * Real markdown rendering (marked + DOMPurify, vendored) is deliberately NOT
 * loaded here. renderMarkdown() has a documented, already-exercised fallback
 * (plain <pre><code>) for when those globals are absent, and every behaviour
 * this harness checks — replay anchoring/reset, the result meta line,
 * streaming preview supersession, load-earlier — is about *which* text lands
 * *where* in the DOM, never about markdown fidelity. Skipping the vendored
 * libs keeps the jsdom environment smaller and avoids DOMPurify's own DOM-API
 * assumptions becoming a second thing under test.
 */
function domHtml(sessionId: string): string {
  return `<!DOCTYPE html>
<html>
<body data-session-id="${sessionId}">
  <div id="prompt-bar" hidden></div>
  <main id="messages"><div id="thread"></div><div id="pinned" hidden></div></main>
  <footer id="composer">
    <div id="input-box">
      <div id="chips" hidden></div>
      <textarea id="input" rows="1"></textarea>
      <div id="composer-row">
        <button id="attach"></button>
        <button id="model-pill"><span id="model-pill-label">default</span></button>
        <button id="context-ring" hidden>
          <svg viewBox="0 0 20 20" width="18" height="18">
            <circle class="ring-bg" cx="10" cy="10" r="7.5" fill="none" stroke-width="2.5"/>
            <circle class="ring-fg" cx="10" cy="10" r="7.5" fill="none" stroke-width="2.5"
                    stroke-dasharray="47.1" stroke-dashoffset="47.1"/>
          </svg>
        </button>
        <span id="branch-chip" hidden></span>
        <button id="agents-chip" hidden><span id="agents-count">0</span></button><button id="perm-toggle"><span>Bypass permissions</span></button>
        <button id="send"></button>
      </div>
    </div>
  </footer>
</body>
</html>`;
}

interface Harness {
  window: JsdomWindow;
  document: DomNode;
  /** Every vscode.postMessage(...) call the client made, in order. */
  posted: Record<string, unknown>[];
  /** Every element scrollIntoView() was called on, in call order. */
  scrollIntoViewCalls: DomNode[];
  /** Simulates a message posted from the extension host into the webview. */
  send(message: Record<string, unknown>): void;
  /** Lets requestAnimationFrame-scheduled preview rendering run one tick. */
  flush(): Promise<void>;
  /**
   * Tears down the jsdom window. Called for every harness by the global
   * after() hook; a test only needs it directly when it wants the window gone
   * before the suite ends.
   */
  close(): void;
}

let nextSeq = 0;
/** Wraps a raw client event as the persisted-event shape the protocol uses. */
function persisted(event: Record<string, unknown>, ts?: number) {
  return { seq: nextSeq++, ts: ts ?? Date.now(), event };
}
/** The shape a single live 'event' message carries (see handleEvent). */
function liveEvent(event: Record<string, unknown>, ts?: number) {
  return { type: 'event', event: persisted(event, ts) };
}

function createHarness(
  sessionId = 'harness-session',
  opts: { coarsePointer?: boolean } = {},
): Harness {
  const dom = new JSDOM(domHtml(sessionId), {
    runScripts: 'dangerously',
    pretendToBeVisual: true, // polyfills requestAnimationFrame/cancelAnimationFrame
  });
  const { window } = dom;

  const posted: Record<string, unknown>[] = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (msg: Record<string, unknown>) => posted.push(msg),
    setState: () => undefined,
    getState: () => undefined,
  });

  // Two browser APIs jsdom does not implement, needed only because chat.js
  // touches them itself — an IntersectionObserver is constructed at the top
  // level (throws immediately if the constructor is missing), and
  // scrollIntoView is called on the replay anchor element. Neither is part
  // of the behaviour under test; both are stand-ins for "the browser did
  // something here" that we assert on directly where relevant.
  window.IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  // jsdom lays nothing out — every getBoundingClientRect() is all zeros. The
  // prompt bar picks the exchange you are in by comparing box tops against the
  // viewport top, so tests state the geometry via data-top and this reads it
  // back. Elements without one sit at 0, which puts #messages' viewport top at
  // 0 and makes an unpositioned box "at the top" by default.
  window.Element.prototype.getBoundingClientRect = function (this: DomNode) {
    const top = Number(this.dataset?.top ?? 0);
    const height = Number(this.dataset?.height ?? 0);
    return { top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top };
  };
  const scrollIntoViewCalls: DomNode[] = [];
  window.Element.prototype.scrollIntoView = function (this: DomNode): void {
    scrollIntoViewCalls.push(this);
  };

  const runScript = (code: string) => {
    const script = window.document.createElement('script');
    script.textContent = code;
    window.document.body.appendChild(script);
  };
  // jsdom implements no visual viewport, and the soft-keyboard fit is entirely
  // about the difference between it and the frame's own height. An EventTarget
  // with the two numbers on it is all chat.js reads.
  const viewport = new window.EventTarget() as DomNode;
  viewport.height = window.innerHeight;
  viewport.offsetTop = 0;
  window.visualViewport = viewport;

  // chat.js asks '(pointer: coarse)' to tell a phone from a desktop, which
  // decides whether Enter sends or makes a new line. jsdom's matchMedia answers
  // false to everything, so the device has to be stated here.
  window.matchMedia = (query: string) => ({
    matches: opts.coarsePointer === true && query.includes('coarse'),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  });

  runScript(STREAMING_MARKDOWN_JS);
  runScript(CHAT_JS);

  const harness: Harness = {
    window,
    document: window.document,
    posted,
    scrollIntoViewCalls,
    send(message: Record<string, unknown>) {
      window.dispatchEvent(new window.MessageEvent('message', { data: message }));
    },
    flush() {
      return new Promise((resolve) => window.setTimeout(resolve, 20));
    },
    close() {
      dom.window.close();
    },
  };
  openHarnesses.push(harness);
  return harness;
}

// ---------------------------------------------------------------------------
// 1 & 2. Replay: reset clears (no duplication) and anchors on the old top
// message rather than jumping to the newest, when a "load earlier" widens
// the window.
// ---------------------------------------------------------------------------

test('replay: reset=true clears the thread so a re-replay does not duplicate', () => {
  const h = createHarness();
  const events = [
    persisted({ type: 'user_message', text: 'first' }),
    persisted({ type: 'user_message', text: 'second' }),
  ];
  h.send({ type: 'replay', reset: true, hasEarlier: false, events, info: {} });
  assert.equal(h.document.querySelectorAll('#thread > .user-msg').length, 2);

  // A genuine re-replay of the exact same window (e.g. a reconnect) must
  // clear first, not append on top of what's already rendered.
  h.send({ type: 'replay', reset: true, hasEarlier: false, events, info: {} });
  assert.equal(
    h.document.querySelectorAll('#thread > .user-msg').length,
    2,
    'reset replay duplicated the thread instead of clearing it first',
  );
});

test('replay: reset=false appends instead of clearing', () => {
  const h = createHarness();
  const first = [persisted({ type: 'user_message', text: 'first' })];
  h.send({ type: 'replay', reset: true, hasEarlier: false, events: first, info: {} });
  assert.equal(h.document.querySelectorAll('#thread > .user-msg').length, 1);

  const more = [persisted({ type: 'user_message', text: 'second' })];
  h.send({ type: 'replay', reset: false, hasEarlier: false, events: more, info: {} });
  const boxes = h.document.querySelectorAll('#thread > .user-msg');
  assert.equal(boxes.length, 2, 'reset=false must append, not clear');
  assert.equal(boxes[0].textContent, 'first');
  assert.equal(boxes[1].textContent, 'second');
});

test('replay: widening via "load earlier" anchors on the previous top message', () => {
  const h = createHarness();

  // Initial window: three messages, the oldest of which is the current top.
  const initial = [
    persisted({ type: 'user_message', text: 'top of window' }),
    persisted({ type: 'user_message', text: 'middle' }),
    persisted({ type: 'user_message', text: 'newest' }),
  ];
  h.send({ type: 'replay', reset: true, hasEarlier: true, events: initial, info: {} });
  assert.ok(h.document.querySelector('.load-earlier button'), 'expected a load-earlier button');

  // Click "Load earlier messages" — this is what records the anchor
  // (firstRenderedSeq) and asks the host to re-attach with a wider window.
  const loadBtn = h.document.querySelector('.load-earlier button') as DomNode;
  loadBtn.click();
  assert.ok(
    h.posted.some((m) => m.type === 'loadEarlier'),
    'clicking load-earlier must post {type: loadEarlier}',
  );

  // The widened replay re-sends from the top: two new older messages, plus
  // the same three as before (same seq/text) — a real reconnect-and-widen.
  const widened = [
    persisted({ type: 'user_message', text: 'older 2' }),
    persisted({ type: 'user_message', text: 'older 1' }),
    { ...initial[0] }, // same seq as the anchor
    { ...initial[1] },
    { ...initial[2] },
  ];
  h.send({ type: 'replay', reset: true, hasEarlier: false, events: widened, info: {} });

  const boxes = h.document.querySelectorAll('#thread > .user-msg');
  assert.equal(boxes.length, 5, 'widened replay should show all five messages, no duplicates');

  // Observable consequence of anchoring: scrollIntoView must be called
  // exactly once, on the element holding the text that used to be on top —
  // not on the newest message, and not left to the "scroll to bottom"
  // default a plain reset would otherwise take.
  assert.equal(h.scrollIntoViewCalls.length, 1, 'expected exactly one scrollIntoView call');
  assert.equal(h.scrollIntoViewCalls[0].textContent, 'top of window');
});

// ---------------------------------------------------------------------------
// 3. Result meta line: HH:mm · duration · tokens, degrading correctly.
// ---------------------------------------------------------------------------

function expectedClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

test('result meta line: full form is "HH:mm · duration · tokens"', () => {
  const h = createHarness();
  const ts = Date.UTC(2026, 0, 15, 9, 30);
  h.send(liveEvent({ type: 'result', durationMs: 1500, turnTokens: 2500 }, ts));
  const meta = h.document.querySelector('.meta');
  assert.equal(meta?.textContent, `${expectedClock(ts)} · 1.5s · 2.5k tokens`);
});

test('result meta line: missing timestamp renders no time (never 1970)', () => {
  const h = createHarness();
  // Built by hand rather than via liveEvent()/persisted(): those default a
  // missing ts to Date.now(), which is exactly the "always has a real
  // timestamp" case already covered above — this test needs the `ts` key
  // genuinely absent, as a malformed or pre-timestamp event might send it.
  h.send({
    type: 'event',
    event: { seq: nextSeq++, event: { type: 'result', durationMs: 1500, turnTokens: 2500 } },
  });
  const meta = h.document.querySelector('.meta');
  assert.equal(meta?.textContent, '1.5s · 2.5k tokens');
});

test('result meta line: a zero timestamp renders no time (never 1970)', () => {
  const h = createHarness();
  h.send(liveEvent({ type: 'result', durationMs: 1500, turnTokens: 2500 }, 0));
  const meta = h.document.querySelector('.meta');
  assert.equal(meta?.textContent, '1.5s · 2.5k tokens');
});

test('result meta line: missing duration and tokens leaves just the time', () => {
  const h = createHarness();
  const ts = Date.UTC(2026, 0, 15, 14, 5);
  h.send(liveEvent({ type: 'result' }, ts));
  const meta = h.document.querySelector('.meta');
  assert.equal(meta?.textContent, expectedClock(ts));
});

test('result meta line: nothing at all falls back to "done"', () => {
  const h = createHarness();
  h.send(liveEvent({ type: 'result' }, 0));
  const meta = h.document.querySelector('.meta');
  assert.equal(meta?.textContent, 'done');
});

// ---------------------------------------------------------------------------
// 4. Streaming previews: progressive rendering, and assistant_text supersedes
// every preview fragment, including ones stranded above a tool card.
// ---------------------------------------------------------------------------

test('streaming preview: delta text renders progressively', async () => {
  const h = createHarness();
  h.send({ type: 'delta', text: 'Hello ' });
  await h.flush();
  let tail = h.document.querySelector('.assistant.streaming .tail');
  assert.equal(tail?.textContent, 'Hello ');

  h.send({ type: 'delta', text: 'world' });
  await h.flush();
  tail = h.document.querySelector('.assistant.streaming .tail');
  assert.equal(tail?.textContent, 'Hello world');
});

test('streaming preview: assistant_text supersedes every preview, even one stranded above a tool card', async () => {
  const h = createHarness();

  // First streaming burst.
  h.send({ type: 'delta', text: 'Part one ' });
  await h.flush();
  assert.ok(h.document.querySelector('.assistant.streaming'));

  // A tool call arrives mid-turn: this ends the CSS "streaming" state but,
  // per chat.js's own comment, does not itself remove the preview node — it
  // stays in the DOM (and in previewEls) until something supersedes it.
  h.send(liveEvent({ type: 'tool_use', toolName: 'Bash', input: { command: 'ls' }, toolUseId: 't1' }));
  assert.ok(h.document.querySelector('.tool-card'));

  // A second streaming burst starts a brand-new preview node — now there are
  // two preview fragments alive, one of them orphaned above the tool card.
  h.send({ type: 'delta', text: 'Part two' });
  await h.flush();
  assert.equal(h.document.querySelectorAll('.assistant.streaming').length, 1);

  // The authoritative block arrives and must drop BOTH preview fragments,
  // leaving exactly one final assistant block behind.
  h.send(liveEvent({ type: 'assistant_text', text: 'final answer' }));

  assert.equal(
    h.document.querySelectorAll('.streaming').length,
    0,
    'no preview fragment should survive an assistant_text event',
  );
  const finals = h.document.querySelectorAll('#thread > .assistant');
  assert.equal(finals.length, 1, 'expected exactly one final assistant block, nothing stranded');
  assert.equal(finals[0].textContent?.trim(), 'final answer');
});

// ---------------------------------------------------------------------------
// 5. Load earlier: only appears when hasEarlier is true; posts loadEarlier.
// ---------------------------------------------------------------------------

test('load earlier: absent when hasEarlier is false', () => {
  const h = createHarness();
  h.send({
    type: 'replay',
    reset: true,
    hasEarlier: false,
    events: [persisted({ type: 'user_message', text: 'hi' })],
    info: {},
  });
  assert.equal(h.document.querySelector('.load-earlier'), null);
});

test('load earlier: present when hasEarlier is true, and clicking posts loadEarlier', () => {
  const h = createHarness();
  h.send({
    type: 'replay',
    reset: true,
    hasEarlier: true,
    events: [persisted({ type: 'user_message', text: 'hi' })],
    info: {},
  });
  const btn = h.document.querySelector('.load-earlier button') as DomNode;
  assert.ok(btn, 'expected a "Load earlier messages" button');
  assert.equal(btn?.textContent, 'Load earlier messages');

  btn?.click();
  // Not assert.deepEqual: the posted object is a plain object literal
  // created inside chat.js's own execution realm (the jsdom vm sandbox), so
  // it has a different Object.prototype than one built here — structurally
  // identical but not strict-equal, which deepStrictEqual (assert/strict)
  // would reject. Compare the field, not object identity.
  const loadEarlierMessages = h.posted.filter((m) => m.type === 'loadEarlier');
  assert.equal(loadEarlierMessages.length, 1);
  assert.equal(Object.keys(loadEarlierMessages[0]).length, 1);
});

test('working row shows when the running turn started', () => {
  const h = createHarness();
  const startedAt = new Date(2026, 6, 31, 14, 32).getTime();
  h.send({ type: 'replay', reset: true, events: [], info: { status: 'idle', permissionMode: 'default' } });
  h.send(liveEvent({ type: 'status', status: 'running' }, startedAt));

  const since = h.document.querySelector('.working-row .working-since');
  assert.ok(since, 'running turn must show a time readout');
  // Start time first, elapsed after it: "when" then "how long".
  assert.match(since.textContent, new RegExp(`^${expectedClock(startedAt)} · \\d`));
});

test('working row readout disappears once the turn ends', () => {
  const h = createHarness();
  h.send({ type: 'replay', reset: true, events: [], info: { status: 'idle', permissionMode: 'default' } });
  h.send(liveEvent({ type: 'status', status: 'running' }, Date.now()));
  assert.ok(h.document.querySelector('.working-row'), 'row present while running');

  h.send(liveEvent({ type: 'status', status: 'idle' }, Date.now()));
  assert.equal(h.document.querySelector('.working-row'), null, 'row gone once idle');
});

test('a later status event does not restart the elapsed clock', () => {
  const h = createHarness();
  const startedAt = new Date(2026, 6, 31, 9, 5).getTime();
  h.send({ type: 'replay', reset: true, events: [], info: { status: 'idle', permissionMode: 'default' } });
  h.send(liveEvent({ type: 'status', status: 'running' }, startedAt));
  // A second running status mid-turn (detail update) must keep the original
  // start time, or a stuck turn would look like it just began.
  h.send(liveEvent({ type: 'status', status: 'running' }, startedAt + 120000));

  const since = h.document.querySelector('.working-row .working-since');
  assert.match(since.textContent, new RegExp(`^${expectedClock(startedAt)} · `));
});

// ---------------------------------------------------------------------------
// Connection indicator. The webview must decide this itself: if the browser
// loses code-server, no host message can reach it to say so.
// ---------------------------------------------------------------------------

/** Force jsdom's document.visibilityState, which is otherwise read-only. */
function setVisibility(h: Harness, state: 'visible' | 'hidden'): void {
  Object.defineProperty(h.document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

/** Run code inside the jsdom realm, where chat.js lives. */
function evalInWindow(h: Harness, code: string): void {
  const script = h.document.createElement('script');
  script.textContent = code;
  h.document.body.appendChild(script);
}

/** Pin Date.now inside the window so staleness can be reached instantly. */
function freezeClock(h: Harness, at: number): void {
  evalInWindow(h, `Date.now = function () { return ${at}; };`);
}

/** Same for navigator.onLine — a getter, so plain assignment is a no-op. */
function setOnline(h: Harness, online: boolean): void {
  Object.defineProperty(h.window.navigator, 'onLine', {
    configurable: true,
    get: () => online,
  });
}

test('connection: a pong keeps the perimeter hidden', () => {
  const h = createHarness();
  h.send({ type: 'pong', daemon: true, indicator: true });
  const veil = h.document.querySelector('.offline-veil');
  assert.ok(veil, 'the indicator element must exist');
  assert.equal(veil.hidden, true, 'a healthy round trip shows nothing');
  h.close();
});

test('connection: the client probes rather than waiting to be told', () => {
  const h = createHarness();
  // Nothing can reach a webview whose socket died, so it has to ask.
  assert.ok(
    h.posted.some((m) => m.type === 'ping'),
    'client must send its own heartbeat',
  );
  h.close();
});

test('connection: the daemon being down raises the perimeter', () => {
  const h = createHarness();
  h.send({ type: 'pong', daemon: false, indicator: true });
  assert.equal(h.document.querySelector('.offline-veil').hidden, false);
  // ...and recovers on its own once the daemon is back.
  h.send({ type: 'pong', daemon: true, indicator: true });
  assert.equal(h.document.querySelector('.offline-veil').hidden, true);
  h.close();
});

test('connection: going offline raises the perimeter immediately', () => {
  const h = createHarness();
  h.send({ type: 'pong', daemon: true, indicator: true });
  setOnline(h, false);
  h.window.dispatchEvent(new h.window.MessageEvent('offline', { data: null }));
  assert.equal(
    h.document.querySelector('.offline-veil').hidden,
    false,
    'no need to wait out a heartbeat when the browser already knows',
  );
  h.close();
});

test('connection: a hidden tab is never called disconnected', () => {
  const h = createHarness();
  h.send({ type: 'pong', daemon: true, indicator: true });

  // Push the clock well past the staleness window. Without this the test
  // proves nothing: `stale` would be false whatever the visibility guard did.
  // Stub the clock *inside* the window: chat.js runs in jsdom's realm, and
  // assigning h.window.Date.now from out here does not reach it.
  freezeClock(h, Date.now() + 60_000);

  // Backgrounded tabs get their timers throttled, so silence there proves
  // nothing — this is the false positive that makes naive heartbeats useless
  // on a phone.
  setVisibility(h, 'hidden');
  h.document.dispatchEvent(new h.window.MessageEvent('visibilitychange', { data: null }));
  assert.equal(
    h.document.querySelector('.offline-veil').hidden,
    true,
    'a throttled background tab must not be reported as disconnected',
  );

  h.close();
});

test('connection: the setting suppresses the perimeter entirely', () => {
  const h = createHarness();
  h.send({ type: 'connectionIndicator', enabled: false });
  h.send({ type: 'pong', daemon: false, indicator: false });
  assert.equal(
    h.document.querySelector('.offline-veil').hidden,
    true,
    'opting out must win even when genuinely disconnected',
  );
  h.close();
});

// ---------- image previews --------------------------------------------------

/**
 * The host vouches for a path by putting it in `imageUris`; only paths that
 * exist and sit under a permitted localResourceRoot get an entry. So the
 * renderer treats "in the map" as "safe to show" and everything else stays a
 * plain link — these tests pin both halves of that contract.
 */
const SHOT = '/tmp/shot.png';
const SHOT_URI = 'https://file%2B.vscode-resource/tmp/shot.png';

test('image attachment renders a clickable thumbnail, not a text chip', () => {
  const h = createHarness();
  h.send({
    type: 'replay',
    reset: true,
    hasEarlier: false,
    info: {},
    imageUris: { [SHOT]: SHOT_URI },
    events: [
      persisted({
        type: 'user_message',
        text: 'look at this',
        attachments: [{ kind: 'image', label: 'shot.png', path: SHOT, mediaType: 'image/png' }],
      }),
    ],
  });
  const img = h.document.querySelector('#thread .img-thumb img');
  assert.ok(img, 'expected a thumbnail for an image attachment');
  assert.equal(img.getAttribute('src'), SHOT_URI);
});

test('an image path mentioned in message text becomes a thumbnail', () => {
  const h = createHarness();
  h.send({
    type: 'replay',
    reset: true,
    hasEarlier: false,
    info: {},
    imageUris: { [SHOT]: SHOT_URI },
    events: [persisted({ type: 'user_message', text: `look at ${SHOT} please` })],
  });
  const img = h.document.querySelector('#thread .img-thumb img');
  assert.ok(img, 'expected an inline preview for an image path in text');
  assert.equal(img.getAttribute('src'), SHOT_URI);
  // The surrounding words survive; only the path itself is replaced.
  assert.match(h.document.querySelector('#thread .user-msg').textContent, /look at/);
});

/**
 * Deliberate: a path inside a code block is being displayed as text on purpose,
 * and swapping it for an image would mangle the listing. (This harness renders
 * without marked, so all markdown text lands in a <pre> — which is exactly the
 * node type this exclusion targets.)
 */
test('an image path inside a code block is left as text', () => {
  const h = createHarness();
  h.send({
    type: 'replay',
    reset: true,
    hasEarlier: false,
    info: {},
    imageUris: { [SHOT]: SHOT_URI },
    events: [persisted({ type: 'assistant_text', text: `cp ${SHOT} /backup/` })],
  });
  assert.equal(h.document.querySelector('#thread .img-thumb'), null);
  assert.match(h.document.querySelector('#thread pre').textContent, /shot\.png/);
});

test('a path the host did not vouch for stays a plain link', () => {
  const h = createHarness();
  h.send({
    type: 'replay',
    reset: true,
    hasEarlier: false,
    info: {},
    // No imageUris at all: unreadable, too large, or outside a permitted root.
    events: [
      persisted({
        type: 'user_message',
        text: 'x',
        attachments: [{ kind: 'file', label: '/tmp/secret.png', path: '/tmp/secret.png' }],
      }),
    ],
  });
  assert.equal(h.document.querySelector('#thread .img-thumb'), null);
  assert.ok(h.document.querySelector('#thread .chip'), 'expected the usual chip fallback');
});

test('non-image attachments are unaffected', () => {
  const h = createHarness();
  h.send({
    type: 'replay',
    reset: true,
    hasEarlier: false,
    info: {},
    imageUris: { [SHOT]: SHOT_URI },
    events: [
      persisted({
        type: 'user_message',
        text: 'x',
        attachments: [{ kind: 'file', label: '/tmp/notes.txt', path: '/tmp/notes.txt' }],
      }),
    ],
  });
  assert.equal(h.document.querySelector('#thread .img-thumb'), null);
});

test('clicking a thumbnail opens a lightbox, and Escape closes it', () => {
  const h = createHarness();
  h.send({
    type: 'replay',
    reset: true,
    hasEarlier: false,
    info: {},
    imageUris: { [SHOT]: SHOT_URI },
    events: [
      persisted({
        type: 'user_message',
        text: 'x',
        attachments: [{ kind: 'image', label: 'shot.png', path: SHOT, mediaType: 'image/png' }],
      }),
    ],
  });
  const thumb = h.document.querySelector('#thread .img-thumb');
  assert.ok(thumb);
  assert.equal(h.document.querySelector('.lightbox'), null);

  thumb.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  const box = h.document.querySelector('.lightbox');
  assert.ok(box, 'clicking a thumbnail should open the lightbox');
  assert.equal(box.querySelector('img').getAttribute('src'), SHOT_URI);

  h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(h.document.querySelector('.lightbox'), null, 'Escape should dismiss it');
});

// ---------- sign-in card ----------------------------------------------------

/**
 * The code box is in the panel rather than a VS Code input box because Ctrl+V
 * does not paste in those under code-server: VS Code binds it to a command that
 * reads the clipboard through navigator.clipboard.readText(), which Firefox
 * refuses for web pages, so only Ctrl+Shift+V worked. A webview input is handled
 * by the browser itself.
 */
test('loginPrompt: renders a focusable code input in the panel', () => {
  const h = createHarness();
  h.send({ type: 'loginPrompt', loginId: 'abc', name: 'work', url: 'https://claude.com/x' });

  const input = h.document.querySelector('#thread .login-card .login-input');
  assert.ok(input, 'the code is entered in the webview, not a QuickInput');
  assert.equal(input.getAttribute('type'), 'password', 'a credential should be masked');
  assert.equal(h.document.activeElement, input, 'focused so the paste lands in it');
  assert.match(h.document.querySelector('.login-card').textContent, /work/);
});

test('loginPrompt: submitting sends the code to the host', () => {
  const h = createHarness();
  h.send({ type: 'loginPrompt', loginId: 'abc', name: 'work', url: 'https://claude.com/x' });
  const input = h.document.querySelector('.login-input');
  input.value = '  pasted-code  ';
  h.document.querySelector('.login-submit').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));

  const sent = h.posted.find((m) => m.type === 'loginCode');
  assert.ok(sent, 'the host must be told');
  assert.equal(sent.code, 'pasted-code', 'trimmed — a pasted code often carries whitespace');
  assert.equal(sent.loginId, 'abc');
});

test('loginPrompt: Enter submits too', () => {
  const h = createHarness();
  h.send({ type: 'loginPrompt', loginId: 'abc', name: 'work', url: 'https://claude.com/x' });
  const input = h.document.querySelector('.login-input');
  input.value = 'typed-code';
  input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.ok(h.posted.find((m) => m.type === 'loginCode'));
});

test('loginPrompt: an empty code is refused without bothering the daemon', () => {
  const h = createHarness();
  h.send({ type: 'loginPrompt', loginId: 'abc', name: 'work', url: 'https://claude.com/x' });
  h.document.querySelector('.login-submit').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.equal(h.posted.filter((m) => m.type === 'loginCode').length, 0);
  assert.match(h.document.querySelector('.login-status').textContent, /Enter the code/i);
});

test('loginResult: a failure re-enables the box so the code can be retyped', () => {
  const h = createHarness();
  h.send({ type: 'loginPrompt', loginId: 'abc', name: 'work', url: 'https://claude.com/x' });
  const input = h.document.querySelector('.login-input');
  input.value = 'wrong';
  h.document.querySelector('.login-submit').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  h.send({ type: 'loginResult', ok: false, error: 'That code was not accepted' });

  assert.equal(input.disabled, false, 'a rejected code must not strand the user');
  assert.equal(input.value, '', 'and the stale code is cleared');
  assert.match(h.document.querySelector('.login-status').textContent, /not accepted/);
});

test('loginResult: success replaces the card with a confirmation', () => {
  const h = createHarness();
  h.send({ type: 'loginPrompt', loginId: 'abc', name: 'work', url: 'https://claude.com/x' });
  h.send({ type: 'loginResult', ok: true });
  assert.match(h.document.querySelector('.login-card').textContent, /Signed in/);
  assert.equal(h.document.querySelector('.login-input'), null);
});

test('loginPrompt: cancelling tells the host so the child process is stopped', () => {
  const h = createHarness();
  h.send({ type: 'loginPrompt', loginId: 'abc', name: 'work', url: 'https://claude.com/x' });
  h.document.querySelector('.login-cancel').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.ok(h.posted.find((m) => m.type === 'loginCancel' && m.loginId === 'abc'));
  assert.equal(h.document.querySelector('.login-card'), null);
});

// ---------- pinned "waiting for you" bar ------------------------------------

/**
 * A permission or question card sits in the transcript in chronological order,
 * but the conversation keeps scrolling while it waits — so the one thing
 * blocking progress scrolls out of sight and gets missed. The pin keeps it beside
 * the composer until it is answered.
 */
function pending(kind: 'permission' | 'question', requestId: string, seq: number) {
  return kind === 'permission'
    ? persisted({ type: 'permission_request', requestId, toolName: 'Bash', input: {} }, seq)
    : persisted(
        {
          type: 'question_request',
          requestId,
          questions: [{ question: 'Which branch?', header: 'Branch', options: [{ label: 'main' }, { label: 'dev' }] }],
        },
        seq,
      );
}

test('pinned: a permission request is pinned beside the composer', () => {
  const h = createHarness();
  h.send({ type: 'replay', reset: true, hasEarlier: false, info: {}, events: [pending('permission', 'r1', 0)] });

  const bar = h.document.querySelector('#pinned .pinned-bar');
  assert.ok(bar, 'the thing blocking progress must stay visible');
  assert.equal(h.document.getElementById('pinned').hasAttribute('hidden'), false);
  assert.match(bar.textContent, /Allow Bash/);
  // The card itself stays in the transcript, in order.
  assert.ok(h.document.querySelector('#thread .permission[data-request-id="r1"]'));
});

test('pinned: a question shows its text, not a generic label', () => {
  const h = createHarness();
  h.send({ type: 'replay', reset: true, hasEarlier: false, info: {}, events: [pending('question', 'q1', 0)] });
  assert.match(h.document.querySelector('#pinned .pinned-bar').textContent, /Which branch\?/);
});

test('pinned: answering clears it', () => {
  const h = createHarness();
  h.send({ type: 'replay', reset: true, hasEarlier: false, info: {}, events: [pending('permission', 'r1', 0)] });
  h.send(liveEvent({ type: 'permission_resolved', requestId: 'r1', allowed: true }, 0));

  assert.equal(h.document.querySelector('#pinned .pinned-bar'), null);
  assert.equal(h.document.getElementById('pinned').hasAttribute('hidden'), true);
});

/** Answering the oldest usually unblocks the rest; a stack would eat the panel. */
test('pinned: with several outstanding, shows the oldest and counts the rest', () => {
  const h = createHarness();
  h.send({
    type: 'replay',
    reset: true,
    hasEarlier: false,
    info: {},
    events: [pending('permission', 'r1', 0), pending('permission', 'r2', 1), pending('question', 'q1', 2)],
  });
  const bar = h.document.querySelector('#pinned .pinned-bar');
  assert.match(bar.textContent, /Allow Bash/, 'oldest first');
  assert.match(bar.textContent, /\+2 more/);

  // Answering the oldest promotes the next one rather than clearing the bar.
  h.send(liveEvent({ type: 'permission_resolved', requestId: 'r1', allowed: true }, 3));
  assert.match(h.document.querySelector('#pinned .pinned-bar').textContent, /\+1 more/);
});

test('pinned: nothing outstanding means no bar at all', () => {
  const h = createHarness();
  h.send({
    type: 'replay',
    reset: true,
    hasEarlier: false,
    info: {},
    events: [persisted({ type: 'user_message', text: 'hi' }, 0)],
  });
  assert.equal(h.document.getElementById('pinned').hasAttribute('hidden'), true);
});

/** A reset replay rebuilds the thread; a stale pin would point at a removed card. */
test('pinned: a reset replay clears stale pins', () => {
  const h = createHarness();
  h.send({ type: 'replay', reset: true, hasEarlier: false, info: {}, events: [pending('permission', 'r1', 0)] });
  assert.ok(h.document.querySelector('#pinned .pinned-bar'));

  h.send({
    type: 'replay',
    reset: true,
    hasEarlier: false,
    info: {},
    events: [persisted({ type: 'user_message', text: 'fresh' }, 0)],
  });
  assert.equal(h.document.querySelector('#pinned .pinned-bar'), null);
});

test('pinned: Show scrolls the card into view and highlights it', () => {
  const h = createHarness();
  h.send({ type: 'replay', reset: true, hasEarlier: false, info: {}, events: [pending('permission', 'r1', 0)] });
  const card = h.document.querySelector('#thread .permission[data-request-id="r1"]');
  h.document.querySelector('.pinned-show').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.ok(card.classList.contains('flash'), 'the jump should say which card it meant');
});

// ---------- subagent counter ------------------------------------------------

test('agents: the chip is hidden when nothing is fanned out', () => {
  const h = createHarness();
  h.send({ type: 'agents', agents: [] });
  assert.equal(h.document.getElementById('agents-chip').hasAttribute('hidden'), true);
});

test('agents: shows the count, and says the list is a click away', () => {
  const h = createHarness();
  h.send({
    type: 'agents',
    agents: [
      { id: 'a', description: 'Review PR 728' },
      { id: 'b', description: 'Run the migration audit' },
    ],
  });
  const chip = h.document.getElementById('agents-chip');
  assert.equal(chip.hasAttribute('hidden'), false);
  assert.equal(h.document.getElementById('agents-count').textContent, '2');
  assert.match(chip.getAttribute('title'), /2 subagents working/);
  assert.match(chip.getAttribute('title'), /click to list/i);
});

test('agents: one agent reads in the singular', () => {
  const h = createHarness();
  h.send({ type: 'agents', agents: [{ id: 'a', description: 'Solo' }] });
  assert.match(h.document.getElementById('agents-chip').getAttribute('title'), /1 subagent working/);
});

/** Agents finish; the chip has to disappear again rather than stick at the peak. */
test('agents: the chip clears when the last one goes quiet', () => {
  const h = createHarness();
  h.send({ type: 'agents', agents: [{ id: 'a', description: 'x' }, { id: 'b', description: 'y' }] });
  h.send({ type: 'agents', agents: [{ id: 'a', description: 'x' }] });
  assert.equal(h.document.getElementById('agents-count').textContent, '1');
  h.send({ type: 'agents', agents: [] });
  assert.equal(h.document.getElementById('agents-chip').hasAttribute('hidden'), true);
});

test('agents: clicking the chip lists what each one is doing', () => {
  const h = createHarness();
  h.send({
    type: 'agents',
    agents: [
      { id: 'a', description: 'Review PR 728' },
      { id: 'b', description: 'Run the migration audit' },
    ],
  });
  assert.equal(h.document.querySelector('.agents-menu:not([hidden])'), null, 'closed until asked');

  h.document.getElementById('agents-chip').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));

  const menu = h.document.querySelector('.agents-menu');
  assert.equal(menu.hasAttribute('hidden'), false);
  const rows = [...menu.querySelectorAll('.agent-item')].map((r) => r.textContent);
  assert.deepEqual(rows, ['Review PR 728', 'Run the migration audit']);
  assert.match(menu.querySelector('.menu-title').textContent, /2 subagents working/);
});

test('agents: clicking again closes it', () => {
  const h = createHarness();
  h.send({ type: 'agents', agents: [{ id: 'a', description: 'x' }] });
  const chip = h.document.getElementById('agents-chip');
  chip.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  chip.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.equal(h.document.querySelector('.agents-menu').hasAttribute('hidden'), true);
});

/** Agents come and go while you are reading the list. */
test('agents: an open list follows agents appearing and finishing', () => {
  const h = createHarness();
  h.send({ type: 'agents', agents: [{ id: 'a', description: 'first' }] });
  h.document.getElementById('agents-chip').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));

  h.send({ type: 'agents', agents: [{ id: 'a', description: 'first' }, { id: 'b', description: 'second' }] });
  assert.equal(h.document.querySelectorAll('.agents-menu .agent-item').length, 2, 'updates in place');

  // The last one finishing takes the chip away, so the list must go with it.
  h.send({ type: 'agents', agents: [] });
  assert.equal(h.document.querySelector('.agents-menu').hasAttribute('hidden'), true);
  assert.equal(h.document.getElementById('agents-chip').hasAttribute('hidden'), true);
});

test('agents: a stoppable agent gets an ×, and clicking it asks the host to stop that one', () => {
  const h = createHarness();
  h.send({
    type: 'agents',
    agents: [{ id: 't1', taskId: 't1', description: 'Review PR 728', kind: 'agent' }],
  });
  h.document.getElementById('agents-chip').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));

  const stop = h.document.querySelector('.agent-item .agent-stop');
  assert.ok(stop, 'a running agent should be stoppable');
  stop.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));

  const sent = h.posted.find((m) => m.type === 'stopAgent');
  assert.equal(sent?.taskId, 't1');
  assert.equal(stop.disabled, true, 'no double-sending while it takes effect');
});

/**
 * An agent inferred from message activity has no task id, so there is nothing to
 * stop it with. A dead × would be worse than none.
 */
test('agents: an agent with no task id has no × at all', () => {
  const h = createHarness();
  h.send({ type: 'agents', agents: [{ id: 'a', description: 'inferred from activity' }] });
  h.document.getElementById('agents-chip').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));

  assert.ok(h.document.querySelector('.agent-item'), 'it is still listed');
  assert.equal(h.document.querySelector('.agent-item .agent-stop'), null, 'but not stoppable');
});

test('agents: stopping marks the row until the CLI confirms by re-reporting', () => {
  const h = createHarness();
  h.send({ type: 'agents', agents: [{ id: 't1', taskId: 't1', description: 'x' }] });
  h.document.getElementById('agents-chip').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  h.document.querySelector('.agent-stop').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.ok(h.document.querySelector('.agent-item').classList.contains('stopping'));

  // The CLI drops it from the live set; the row goes with it.
  h.send({ type: 'agents', agents: [] });
  assert.equal(h.document.querySelector('.agent-item'), null);
});

// ---------------------------------------------------------------------------
// Enter: sends from a desktop keyboard, makes a new line on a phone
//
// The composer sent on any unshifted Enter. On a phone that is the only key
// that can break a line — Shift lives behind a modifier layer — so writing two
// lines was impossible and a stray Return fired off a half-written message.
// ---------------------------------------------------------------------------

/** Types into the composer and presses Enter with the given modifiers. */
function pressEnter(h: Harness, text: string, init: Record<string, unknown> = {}): void {
  const input = h.document.getElementById('input') as unknown as { value: string; dispatchEvent(e: unknown): boolean };
  input.value = text;
  input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));
}

const sentText = (h: Harness): unknown[] =>
  h.posted.filter((m) => m.type === 'send').map((m) => m.text);

test('composer: plain Enter sends on a desktop keyboard', () => {
  const h = createHarness('enter-desktop');
  pressEnter(h, 'ship it');
  assert.deepEqual(sentText(h), ['ship it']);
});

test('composer: Shift+Enter is a new line, not a send', () => {
  const h = createHarness('enter-shift');
  pressEnter(h, 'first line', { shiftKey: true });
  assert.deepEqual(sentText(h), [], 'the textarea keeps the keystroke');
});

test('composer: on a touch keyboard Enter makes a new line', () => {
  const h = createHarness('enter-phone', { coarsePointer: true });
  pressEnter(h, 'half a thought');
  assert.deepEqual(sentText(h), [], 'a phone Return must not fire the message');
});

/** The escape hatch on a phone with a hardware keyboard attached. */
test('composer: Cmd+Enter and Ctrl+Enter send on a touch keyboard', () => {
  const h = createHarness('enter-phone-modifier', { coarsePointer: true });
  pressEnter(h, 'with cmd', { metaKey: true });
  pressEnter(h, 'with ctrl', { ctrlKey: true });
  assert.deepEqual(sentText(h), ['with cmd', 'with ctrl']);
});

test('composer: Cmd+Enter also sends on a desktop keyboard', () => {
  const h = createHarness('enter-desktop-modifier');
  pressEnter(h, 'either way', { metaKey: true });
  assert.deepEqual(sentText(h), ['either way']);
});

/**
 * Selecting a candidate in an IME (Russian, Chinese, the phone's own
 * autocorrect) ends with Enter. That keystroke belongs to the keyboard, not to
 * the composer. Android reports it as keyCode 229 rather than isComposing.
 */
test('composer: Enter while an IME is composing neither sends nor is swallowed', () => {
  const h = createHarness('enter-ime');
  pressEnter(h, 'привет', { isComposing: true });
  pressEnter(h, 'привет', { keyCode: 229 });
  assert.deepEqual(sentText(h), []);
});

// ---------------------------------------------------------------------------
// The prompt bar: a section header for the exchange you are reading
//
// It used to track only the newest prompt — scroll up past it and the bar kept
// naming a question that was now far below, which is worse than showing
// nothing. And tapping it could only ever jump back to that same newest
// prompt.
// ---------------------------------------------------------------------------

/** Places the loaded prompts at the given viewport tops and scrolls. */
async function layout(h: Harness, tops: number[]): Promise<void> {
  const boxes = [...h.document.querySelectorAll('#thread > .user-msg')] as DomNode[];
  boxes.forEach((box: DomNode, i: number) => {
    box.dataset.top = String(tops[i]);
  });
  h.document.getElementById('messages').dispatchEvent(new h.window.MessageEvent('scroll', { data: null }));
  await h.flush();
}

function threeExchanges(h: Harness): void {
  h.send({
    type: 'replay',
    reset: true,
    hasEarlier: false,
    events: [
      persisted({ type: 'user_message', text: 'add the rate limit bar' }),
      persisted({ type: 'assistant_text', text: 'done' }),
      persisted({ type: 'user_message', text: 'now rotate accounts' }),
      persisted({ type: 'assistant_text', text: 'done' }),
      persisted({ type: 'user_message', text: 'enter should make a new line' }),
    ],
    info: {},
  });
}

const barText = (h: Harness): string => h.document.getElementById('prompt-bar').textContent;
const barHidden = (h: Harness): boolean => h.document.getElementById('prompt-bar').hidden;

test('prompt bar: scrolling up past a prompt falls back to the one before it', async () => {
  const h = createHarness('prompt-bar-scroll');
  threeExchanges(h);

  // Reading the newest exchange: every prompt is above the viewport.
  await layout(h, [-900, -400, -80]);
  assert.equal(barText(h), 'enter should make a new line');

  // Scrolled up so the newest prompt is on screen — the content at the top of
  // the viewport still belongs to the exchange before it.
  await layout(h, [-500, -120, 300]);
  assert.equal(barText(h), 'now rotate accounts');

  await layout(h, [-200, 150, 600]);
  assert.equal(barText(h), 'add the rate limit bar');
});

test('prompt bar: nothing above the first loaded prompt means no bar', async () => {
  const h = createHarness('prompt-bar-top');
  threeExchanges(h);
  await layout(h, [40, 300, 700]);
  assert.equal(barHidden(h), true);
});

test('prompt bar: tapping it lists every prompt in the loaded history, newest first', async () => {
  const h = createHarness('prompt-menu-list');
  threeExchanges(h);
  await layout(h, [-900, -400, -80]);

  h.document.getElementById('prompt-bar').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  const items = [...h.document.querySelectorAll('.prompt-item .prompt-label')] as DomNode[];
  assert.deepEqual(
    items.map((i: DomNode) => i.textContent),
    ['enter should make a new line', 'now rotate accounts', 'add the rate limit bar'],
  );
});

test('prompt bar: the list marks the exchange you are in', async () => {
  const h = createHarness('prompt-menu-check');
  threeExchanges(h);
  await layout(h, [-500, -120, 300]); // reading the middle exchange

  h.document.getElementById('prompt-bar').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  const checked = [...h.document.querySelectorAll('.prompt-item')]
    .filter((item: DomNode) => item.querySelector('.menu-check').textContent === '✓')
    .map((item: DomNode) => item.querySelector('.prompt-label').textContent);
  assert.deepEqual(checked, ['now rotate accounts']);
});

test('prompt bar: picking a message jumps to it and closes the list', async () => {
  const h = createHarness('prompt-menu-jump');
  threeExchanges(h);
  await layout(h, [-900, -400, -80]);

  h.document.getElementById('prompt-bar').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  const oldest = h.document.querySelectorAll('.prompt-item')[2];
  oldest.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));

  const target = h.document.querySelectorAll('#thread > .user-msg')[0];
  assert.equal(h.scrollIntoViewCalls.at(-1), target, 'jumped to the message that was picked');
  assert.equal(h.document.querySelector('.prompt-menu').hidden, true);
});

test('prompt bar: tapping again closes the list', async () => {
  const h = createHarness('prompt-menu-toggle');
  threeExchanges(h);
  await layout(h, [-900, -400, -80]);
  const bar = h.document.getElementById('prompt-bar');

  bar.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.equal(h.document.querySelector('.prompt-menu').hidden, false);
  bar.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.equal(h.document.querySelector('.prompt-menu').hidden, true);
});

/** A switch to another session must not leave the old chat's prompts listed. */
test('prompt bar: a reset replay clears the list', async () => {
  const h = createHarness('prompt-menu-reset');
  threeExchanges(h);
  await layout(h, [-900, -400, -80]);

  h.send({
    type: 'replay',
    reset: true,
    hasEarlier: false,
    events: [persisted({ type: 'user_message', text: 'a different session' })],
    info: {},
  });
  await layout(h, [-100]);

  h.document.getElementById('prompt-bar').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  const items = [...h.document.querySelectorAll('.prompt-item .prompt-label')] as DomNode[];
  assert.deepEqual(items.map((i: DomNode) => i.textContent), ['a different session']);
});

// ---------------------------------------------------------------------------
// Subagent badges
//
// Several subagents write into this one transcript at once and their messages
// arrive interleaved. Unbadged, the chat reads as one confused voice.
// ---------------------------------------------------------------------------

const badges = (h: Harness): string[] =>
  [...h.document.querySelectorAll('.agent-badge')].map((b: DomNode) => b.textContent);

test('agent badge: a subagent message is named', () => {
  const h = createHarness('agent-badge');
  h.send(liveEvent({ type: 'assistant_text', text: 'the socket was stale', agent: 'Check daemon logs' }));
  assert.deepEqual(badges(h), ['Check daemon logs']);
  assert.equal(h.document.querySelector('.assistant.from-agent') !== null, true);
});

test('agent badge: the main thread is left unmarked', () => {
  const h = createHarness('agent-badge-main');
  h.send(liveEvent({ type: 'assistant_text', text: 'answering directly' }));
  assert.deepEqual(badges(h), []);
  assert.equal(h.document.querySelector('.from-agent'), null);
});

/** The colour is the whole point: two agents interleaved, told apart at a glance. */
test('agent badge: each agent keeps one colour, and two agents differ', () => {
  const h = createHarness('agent-badge-tint');
  h.send(liveEvent({ type: 'assistant_text', text: 'a1', agent: 'Audit rotation' }));
  h.send(liveEvent({ type: 'assistant_text', text: 'b1', agent: 'Check daemon logs' }));
  h.send(liveEvent({ type: 'assistant_text', text: 'a2', agent: 'Audit rotation' }));

  const tints = [...h.document.querySelectorAll('.assistant.from-agent')].map(
    (b: DomNode) => b.dataset.tint,
  );
  assert.equal(tints[0], tints[2], 'the same agent must not change colour mid-conversation');
  assert.notEqual(tints[0], tints[1], 'two agents writing at once must not share one');
  assert.ok(tints.every((t: string) => Number(t) >= 0 && Number(t) < 8), `tint out of range: ${tints}`);
});

test("agent badge: a subagent's tool card is badged too", () => {
  const h = createHarness('agent-badge-tool');
  h.send(liveEvent({ type: 'tool_use', toolUseId: 't1', toolName: 'Read', input: {}, agent: 'Audit rotation' }));
  const card = h.document.querySelector('.tool-card.from-agent');
  assert.notEqual(card, null, 'the card carries the rail');
  assert.equal(card.querySelector('.agent-badge').textContent, 'Audit rotation');
  assert.equal(
    card.querySelector('.agent-badge').nextSibling.textContent,
    'Read',
    'the badge reads before the tool name, not after it',
  );
});

test('agent badge: an empty agent name is treated as the main thread', () => {
  const h = createHarness('agent-badge-empty');
  h.send(liveEvent({ type: 'assistant_text', text: 'no name', agent: '' }));
  assert.deepEqual(badges(h), []);
});

// ---------------------------------------------------------------------------
// Empty state
//
// A fresh panel was a bare grey rectangle above the composer — no greeting, no
// state, and for someone who has never signed in, no hint that their first
// message was about to fail for a reason they could not guess.
// ---------------------------------------------------------------------------

test('empty state: a session with no history says what this is', () => {
  const h = createHarness('empty-fresh');
  h.send({ type: 'replay', reset: true, hasEarlier: false, events: [], info: {} });
  const box = h.document.querySelector('.empty-state');
  assert.notEqual(box, null, 'a fresh session must not render a blank rectangle');
  assert.match(box.textContent, /daemon/, 'and should say why this session is different');
});

test('empty state: it offers the way to sign in', () => {
  const h = createHarness('empty-signin');
  h.send({ type: 'replay', reset: true, hasEarlier: false, events: [], info: {} });
  h.document.querySelector('.empty-action').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.ok(
    h.posted.some((m) => m.type === 'addAccount'),
    'the button must reach the host, not just look clickable',
  );
});

test('empty state: any real content replaces it', () => {
  const h = createHarness('empty-then-content');
  h.send({ type: 'replay', reset: true, hasEarlier: false, events: [], info: {} });
  h.send(liveEvent({ type: 'user_message', text: 'hello' }));
  assert.equal(h.document.querySelector('.empty-state'), null);
});

test('empty state: a replay with events never shows it', () => {
  const h = createHarness('empty-with-events');
  h.send({
    type: 'replay',
    reset: true,
    hasEarlier: false,
    events: [persisted({ type: 'user_message', text: 'hi' })],
    info: {},
  });
  assert.equal(h.document.querySelector('.empty-state'), null);
});

/** Scrolled-away history is not an empty session. */
test('empty state: a window with earlier history never shows it', () => {
  const h = createHarness('empty-has-earlier');
  h.send({ type: 'replay', reset: true, hasEarlier: true, events: [], info: {} });
  assert.equal(h.document.querySelector('.empty-state'), null);
});

/**
 * The default account is listed whether or not it has credentials. On a machine
 * that has never run Claude Code it was therefore shown ticked and active while
 * every message failed, with nothing anywhere saying why.
 */
test('account menu: an account with no credentials says so', () => {
  const h = createHarness('account-unauthed');
  h.send({
    type: 'accounts',
    accounts: [
      { name: 'default', configDir: null, active: true, signedIn: false },
      { name: 'work', configDir: '/acc/work', active: false, signedIn: true },
    ],
  });
  h.document.getElementById('model-pill').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));

  const labels = [...h.document.querySelectorAll('.menu-item')].map((i: DomNode) => i.textContent);
  assert.ok(
    labels.some((l: string) => /default — not signed in/.test(l)),
    `the unusable account is not marked: ${labels.join(' | ')}`,
  );
  assert.ok(
    labels.some((l: string) => /(^|\s)work$/.test(l.trim())),
    'a usable account must not be marked',
  );
  assert.equal(h.document.querySelectorAll('.account-unauthed').length, 1);
});

// ---------------------------------------------------------------------------
// Soft keyboard fit
//
// This document is an iframe inside the editor, and visualViewport reports the
// WINDOW's visible height, not this frame's. Sizing the body to it left the
// frame too tall by exactly the chrome above — browser toolbar plus tab bar —
// so the bottom strip of the composer, the row with the send button, stayed
// under the keyboard.
// ---------------------------------------------------------------------------

/** A phone: a 2400px window whose frame starts 200px down, and a keyboard. */
function withViewport(h: Harness, opts: { windowVisible: number; frame: number }): void {
  const vv = h.window.visualViewport as DomNode;
  vv.height = opts.windowVisible;
  Object.defineProperty(h.window, 'innerHeight', { value: opts.frame, configurable: true });
  vv.dispatchEvent(new h.window.MessageEvent('resize', { data: null }));
}

const bodyHeight = (h: Harness): number => parseInt(h.document.body.style.height, 10);

test('keyboard: with no keyboard the body fills the frame', () => {
  const h = createHarness('kbd-rest');
  withViewport(h, { windowVisible: 2400, frame: 2200 }); // 200px of chrome above
  assert.equal(bodyHeight(h), 2200, 'never taller than the frame it lives in');
});

/**
 * The bug: window visible height 1300 with 200px of chrome above means only
 * 1100px of this frame is showing. Using 1300 hid the last 200px — the send
 * button row.
 */
test('keyboard: the body excludes the chrome above the frame', () => {
  const h = createHarness('kbd-up');
  withViewport(h, { windowVisible: 2400, frame: 2200 }); // measure at rest
  withViewport(h, { windowVisible: 1300, frame: 2200 }); // keyboard opens
  assert.equal(bodyHeight(h), 1100, 'was 1300, hiding the composer row');
});

test('keyboard: closing it restores the full frame', () => {
  const h = createHarness('kbd-close');
  withViewport(h, { windowVisible: 2400, frame: 2200 });
  withViewport(h, { windowVisible: 1300, frame: 2200 });
  withViewport(h, { windowVisible: 2400, frame: 2200 });
  assert.equal(bodyHeight(h), 2200);
});

/** A wrong measurement must not collapse the panel to nothing. */
test('keyboard: never collapses below a usable height', () => {
  const h = createHarness('kbd-floor');
  withViewport(h, { windowVisible: 2400, frame: 2200 });
  withViewport(h, { windowVisible: 10, frame: 2200 });
  assert.ok(bodyHeight(h) >= 200, `collapsed to ${bodyHeight(h)}`);
});

/** Rotation changes both numbers; a stale measurement is worse than none. */
test('keyboard: re-measures the chrome when the frame changes at rest', () => {
  const h = createHarness('kbd-rotate');
  withViewport(h, { windowVisible: 2400, frame: 2200 }); // 200 chrome, portrait
  withViewport(h, { windowVisible: 1100, frame: 1000 }); // 100 chrome, landscape
  assert.equal(bodyHeight(h), 1000, 'landscape at rest fills its frame');
  withViewport(h, { windowVisible: 600, frame: 1000 }); // keyboard, landscape
  assert.equal(bodyHeight(h), 500, 'and the new chrome is what gets subtracted');
});

/**
 * "Log in to another account…" is wrong when you have none, which is exactly
 * when someone is hunting for this item: a new user reads it, concludes it is
 * not what they want, and goes looking for a sign-in that does not exist.
 */
test('account menu: the sign-in item does not say "another" when there are none', () => {
  const h = createHarness('signin-wording-none');
  h.send({
    type: 'accounts',
    accounts: [{ name: 'default', configDir: null, active: true, signedIn: false }],
  });
  h.document.getElementById('model-pill').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  const labels = [...h.document.querySelectorAll('.menu-item')].map((i: DomNode) => i.textContent);
  assert.ok(labels.some((l: string) => /Sign in to Claude/.test(l)), labels.join(' | '));
  assert.ok(!labels.some((l: string) => /another account/.test(l)));
});

test('account menu: it does say "another" once one account works', () => {
  const h = createHarness('signin-wording-some');
  h.send({
    type: 'accounts',
    accounts: [{ name: 'work', configDir: '/acc/work', active: true, signedIn: true }],
  });
  h.document.getElementById('model-pill').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  const labels = [...h.document.querySelectorAll('.menu-item')].map((i: DomNode) => i.textContent);
  assert.ok(labels.some((l: string) => /another account/.test(l)), labels.join(' | '));
});

/**
 * A host carrying `interactive-widget=resizes-content` shrinks the LAYOUT
 * viewport rather than the visual one, so this frame simply gets a smaller
 * innerHeight. Taking the smaller of the two means the panel follows either,
 * without needing to know which the platform did.
 *
 * Where a host does neither, nothing here can see the keyboard, and the
 * guesses that stood in for it reserved space on screens with no keyboard on
 * them. That is the server's job now, not this file's.
 */
test('keyboard: a shrinking frame is followed, not just a shrinking viewport', () => {
  const h = createHarness('kbd-layout-shrink');
  withViewport(h, { windowVisible: 2400, frame: 2200 });
  assert.equal(bodyHeight(h), 2200);

  // The keyboard resized the workbench: the frame shrank, the window did not.
  withViewport(h, { windowVisible: 2400, frame: 1300 });
  assert.equal(bodyHeight(h), 1300);
});

// ---------------------------------------------------------------------------
// The branch chip lists where the conversation is working
//
// The chip can only ever name one place, and once subagents take worktrees of
// their own it names none of them -- it counts. The names lived in a tooltip,
// which does not exist on a touch screen.
// ---------------------------------------------------------------------------

function sendPlaces(h: Harness, name: string, worktree: boolean, places: unknown[]): void {
  h.send({ type: 'branch', name, worktree, path: '/repo', held: [], places });
}

const openChip = (h: Harness): void =>
  h.document.getElementById('branch-chip').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));

test('branch chip: one place shows its name and lists just that', () => {
  const h = createHarness('branch-one');
  sendPlaces(h, 'main', false, [
    { name: 'main', branch: 'main', path: '/repo', worktree: false, current: true },
  ]);
  assert.match(h.document.getElementById('branch-chip').textContent, /main/);

  openChip(h);
  const names = [...h.document.querySelectorAll('.place-name')].map((n: DomNode) => n.textContent);
  assert.deepEqual(names, ['main']);
});

test('branch chip: several places are all listed, with the current one marked', () => {
  const h = createHarness('branch-many');
  sendPlaces(h, '3', true, [
    { name: 'main', branch: 'main', path: '/repo', worktree: false, current: true },
    { name: '1130', branch: 'fix/1130', path: '/repo/.claude/worktrees/1130', worktree: true, current: false },
    { name: '1131', branch: 'fix/1131', path: '/repo/.claude/worktrees/1131', worktree: true, current: false },
  ]);
  // The chip counts rather than naming one of three.
  assert.match(h.document.getElementById('branch-chip').textContent, /3/);

  openChip(h);
  const names = [...h.document.querySelectorAll('.place-name')].map((n: DomNode) => n.textContent);
  assert.deepEqual(names, ['main', '1130', '1131']);

  const checked = [...h.document.querySelectorAll('.place-item')]
    .filter((row: DomNode) => row.querySelector('.menu-check').textContent === '✓')
    .map((row: DomNode) => row.querySelector('.place-name').textContent);
  assert.deepEqual(checked, ['main'], 'the session should mark where it is itself');
});

/** A worktree is named for the task it was cut for, not the branch it is on. */
test('branch chip: a worktree shows its branch beside its name', () => {
  const h = createHarness('branch-branchname');
  sendPlaces(h, '2', true, [
    { name: 'main', branch: 'main', path: '/repo', worktree: false, current: true },
    { name: '1130', branch: 'fix/1130', path: '/w/1130', worktree: true, current: false },
  ]);
  openChip(h);
  const branches = [...h.document.querySelectorAll('.place-branch')].map((n: DomNode) => n.textContent);
  assert.deepEqual(branches, ['fix/1130'], 'a branch equal to the name would be noise');
});

test('branch chip: tapping again closes the list', () => {
  const h = createHarness('branch-toggle');
  sendPlaces(h, 'main', false, [
    { name: 'main', branch: 'main', path: '/repo', worktree: false, current: true },
  ]);
  openChip(h);
  assert.equal(h.document.querySelector('.branch-menu').hidden, false);
  openChip(h);
  assert.equal(h.document.querySelector('.branch-menu').hidden, true);
});
