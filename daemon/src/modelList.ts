import type { ModelDescriptor } from '@claude-persist/shared';

/**
 * Only the newest model of each family: Opus, Fable, Sonnet, Haiku.
 *
 * Claude's own list carries every version it still serves -- fourteen
 * entries, Opus 4.6 through 5.5 among them -- and the picker is for choosing
 * between kinds of model, not between their histories. Worked out from the
 * names Claude gives, never from a list kept here, so a new release replaces
 * its predecessor by itself. Anything not named "<Family> <version>" (the
 * default entry) is kept as it is. A chat already on an older model keeps it;
 * the pickers still show what a chat uses even when it is not listed.
 */
export function newestOfEachFamily(models: ModelDescriptor[]): ModelDescriptor[] {
  const parse = (m: ModelDescriptor) => {
    const match = /^([A-Za-z]+) (\d+(?:\.\d+)*)$/.exec(m.displayName.trim());
    return match ? { family: match[1].toLowerCase(), version: match[2].split('.').map(Number) } : null;
  };
  const newer = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      if (d !== 0) return d > 0;
    }
    return false;
  };
  // Of two entries for the same model, the plain alias ("opus") over a pinned
  // id or a long-context variant: the alias follows the family as it moves on.
  const plainness = (m: ModelDescriptor) => (m.value.includes('[') ? 2 : 0) + (m.value.startsWith('claude-') ? 1 : 0);

  const best = new Map<string, { m: ModelDescriptor; version: number[] }>();
  for (const m of models) {
    const p = parse(m);
    if (!p) continue;
    const cur = best.get(p.family);
    const same = cur && !newer(p.version, cur.version) && !newer(cur.version, p.version);
    if (!cur || newer(p.version, cur.version) || (same && plainness(m) < plainness(cur.m))) best.set(p.family, { m, version: p.version });
  }
  const keep = new Set([...best.values()].map((b) => b.m));
  return models.filter((m) => !parse(m) || keep.has(m));
}
