/**
 * Streamed text to a phone, a few times a second instead of piece by piece.
 *
 * Claude's answers arrive as many small text deltas -- 164 for a 2,000
 * character answer, about 20 a second -- and each went to the phone as its
 * own WebSocket frame: its own packet, an acknowledgement back, the radio at
 * full power, and the app re-reading and redrawing the whole answer every
 * time. Gathered over a short window they are one frame each, with no visible
 * difference: the first piece still goes at once, and anything else for the
 * same chat sends what was gathered first, so the order never changes.
 */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

type Message = { kind: string; sessionId?: string; text?: string };

export function coalescingSender<M extends Message>(
  send: (message: M) => void,
  windowMs = 250,
  timers: Timers = realTimers,
): { send(message: M): void; close(): void } {
  /** Text gathered per chat and kind (answer or thinking) since the window opened, in arrival order. */
  const gathered = new Map<string, { kind: string; sessionId: string; text: string }>();
  const streamed = (kind: string) => kind === 'delta' || kind === 'thinking_delta';
  let timer: unknown = null;

  const out = (g: { kind: string; sessionId: string; text: string }) => ({ kind: g.kind, sessionId: g.sessionId, text: g.text }) as unknown as M;

  const flushAll = (): void => {
    for (const g of gathered.values()) send(out(g));
    gathered.clear();
  };

  /** The window closed: send what it gathered, and keep a window open only while text keeps coming. */
  const tick = (): void => {
    if (gathered.size === 0) {
      timer = null;
      return;
    }
    flushAll();
    timer = timers.setTimeout(tick, windowMs);
  };

  return {
    send(message: M): void {
      if (streamed(message.kind) && message.sessionId && typeof message.text === 'string') {
        if (timer === null) {
          // Nothing recent: this piece goes now, so an answer starts without delay.
          send(message);
          timer = timers.setTimeout(tick, windowMs);
          return;
        }
        const key = `${message.kind}\u0000${message.sessionId}`;
        const had = gathered.get(key);
        if (had) had.text += message.text;
        else gathered.set(key, { kind: message.kind, sessionId: message.sessionId, text: message.text });
        return;
      }
      // Anything else about a chat follows the text gathered for it.
      const sessionId = message.sessionId;
      if (sessionId !== undefined) {
        for (const [key, g] of gathered) {
          if (g.sessionId !== sessionId) continue;
          gathered.delete(key);
          send(out(g));
        }
      }
      send(message);
    },
    close(): void {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      gathered.clear();
    },
  };
}
