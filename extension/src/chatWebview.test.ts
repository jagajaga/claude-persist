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
  Element: { prototype: { scrollIntoView: (...args: unknown[]) => void } };
  MessageEvent: new (type: string, init: { data: unknown }) => DomNode;
  setTimeout: (cb: () => void, ms: number) => unknown;
  dispatchEvent: (event: DomNode) => boolean;
  acquireVsCodeApi?: () => unknown;
  IntersectionObserver?: unknown;
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
  <main id="messages"><div id="thread"></div></main>
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
        <button id="perm-toggle"><span>Bypass permissions</span></button>
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

function createHarness(sessionId = 'harness-session'): Harness {
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
  const scrollIntoViewCalls: DomNode[] = [];
  window.Element.prototype.scrollIntoView = function (this: DomNode): void {
    scrollIntoViewCalls.push(this);
  };

  const runScript = (code: string) => {
    const script = window.document.createElement('script');
    script.textContent = code;
    window.document.body.appendChild(script);
  };
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
