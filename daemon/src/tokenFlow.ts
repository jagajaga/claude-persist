// How many tokens are going through Claude, across every chat, right now.
//
// Every API call reports its usage -- fresh input, cache writes, cache reads,
// output -- on the assistant message it produces, subagents' calls included.
// Nothing added those up across chats or over time. This does, over a
// rolling hour, so the phone can show the flow as a rate.
//
// Measured on this machine for one hour: 99 calls, 97% of all tokens were
// cache reads (each step of a turn re-reads the conversation). "Processed"
// -- fresh input + cache writes + output -- is the new work, and is what the
// phone's top bar shows; cache reads are reported beside it, not hidden.

export interface Usage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

export interface TokenCounts {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** input + cacheWrite + output: the new work. */
  processed: number;
}

export interface TokenFlow {
  /** Over the last 60 seconds. */
  lastMinute: TokenCounts;
  lastHour: TokenCounts;
  calls: { lastMinute: number; lastHour: number };
  /** The chats with the most processed tokens in the last five minutes, busiest first. */
  bySession: Array<{ sessionId: string; processed: number }>;
}

interface Call {
  at: number;
  sessionId: string;
  counts: TokenCounts;
}

const HOUR = 3_600_000;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const zero = (): TokenCounts => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, processed: 0 });

function add(into: TokenCounts, c: TokenCounts): void {
  into.input += c.input;
  into.cacheWrite += c.cacheWrite;
  into.cacheRead += c.cacheRead;
  into.output += c.output;
  into.processed += c.processed;
}

export class TokenMeter {
  private calls: Call[] = [];
  /** Message ids already counted: the SDK repeats one call's usage on every content block. */
  private seen = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  record(sessionId: string, usage: Usage | undefined, messageId?: string): void {
    if (!usage) return;
    const at = this.now();
    if (messageId) {
      if (this.seen.has(messageId)) return;
      this.seen.set(messageId, at);
    }
    const input = num(usage.input_tokens);
    const cacheWrite = num(usage.cache_creation_input_tokens);
    const cacheRead = num(usage.cache_read_input_tokens);
    const output = num(usage.output_tokens);
    if (input + cacheWrite + cacheRead + output === 0) return;
    this.calls.push({ at, sessionId, counts: { input, cacheWrite, cacheRead, output, processed: input + cacheWrite + output } });
    this.prune(at);
  }

  snapshot(): TokenFlow {
    const at = this.now();
    this.prune(at);
    const lastMinute = zero();
    const lastHour = zero();
    let minuteCalls = 0;
    const recent = new Map<string, number>();
    for (const call of this.calls) {
      add(lastHour, call.counts);
      if (at - call.at <= 60_000) {
        add(lastMinute, call.counts);
        minuteCalls++;
      }
      if (at - call.at <= 300_000) recent.set(call.sessionId, (recent.get(call.sessionId) ?? 0) + call.counts.processed);
    }
    return {
      lastMinute,
      lastHour,
      calls: { lastMinute: minuteCalls, lastHour: this.calls.length },
      bySession: [...recent].map(([sessionId, processed]) => ({ sessionId, processed }))
        .sort((a, b) => b.processed - a.processed)
        .slice(0, 5),
    };
  }

  private prune(at: number): void {
    const cutoff = at - HOUR;
    let drop = 0;
    while (drop < this.calls.length && this.calls[drop].at <= cutoff) drop++;
    if (drop) this.calls.splice(0, drop);
    for (const [id, when] of this.seen) if (when <= cutoff) this.seen.delete(id);
  }
}
