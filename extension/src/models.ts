import type { ModelDescriptor } from '@claude-persist/shared';

/**
 * Merge user-configured extra model ids (claudePersist.extraModels) into the
 * SDK-probed list. Lets users reach models the runtime doesn't list yet
 * (e.g. a just-released model) without hardcoding names in code; entries the
 * probe already knows are deduped, so the setting self-heals once the SDK
 * catches up.
 */
export function mergeExtraModels(
  probed: ModelDescriptor[],
  extras: string[],
): ModelDescriptor[] {
  const known = new Set(probed.map((m) => m.value));
  const merged = [...probed];
  for (const raw of extras) {
    const value = raw.trim();
    if (!value || known.has(value)) continue;
    known.add(value);
    merged.push({ value, displayName: value });
  }
  return merged;
}
