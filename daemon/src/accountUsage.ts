// Remembering what each account's limits looked like the last time we saw them.
//
// Usage is only ever read off a live query, so the daemon knows the numbers for
// exactly one account: the active one. The account menu wants them for all of
// them, to answer "which of these has room" before switching.
//
// So: record the active account's reading as it arrives, keep the last one per
// account, and let the UI say how old it is. A stale number with its age
// attached is useful; a stale number pretending to be current is not.
import fs from 'node:fs';
import path from 'node:path';
import type { RateLimits } from '@claude-persist/shared';
import { baseDir } from './paths.js';

export interface AccountReading {
  windows: RateLimits;
  /** Epoch ms this reading was taken. */
  at: number;
}

const FILE = path.join(baseDir, 'account-usage.json');

export class AccountUsageStore {
  private readings = new Map<string, AccountReading>();

  constructor(private readonly file: string = FILE) {
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, AccountReading>;
      for (const [key, reading] of Object.entries(raw ?? {})) {
        if (reading && typeof reading.at === 'number') this.readings.set(key, reading);
      }
    } catch {
      // first run, or a file we cannot parse: start empty rather than fail
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.readings)));
    } catch {
      // a reading is not worth failing a turn over
    }
  }

  get(key: string): AccountReading | undefined {
    return this.readings.get(key);
  }

  /**
   * Record a reading for an account.
   *
   * @returns true when this actually changed what we would show, so the caller
   * can avoid broadcasting an identical account list after every turn.
   */
  record(key: string, windows: RateLimits, now = Date.now()): boolean {
    const previous = this.readings.get(key);
    this.readings.set(key, { windows, at: now });
    const changed = JSON.stringify(previous?.windows ?? null) !== JSON.stringify(windows);
    if (changed) this.persist();
    return changed;
  }
}
