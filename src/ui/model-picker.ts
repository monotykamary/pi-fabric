import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ModelLike = { provider: string; id: string; name?: string };

/** Structural shape buildModelSource needs; the real ModelRegistry satisfies this. */
type ModelRegistryLike = {
  getAvailable(): ModelLike[];
};

const buildModelKey = (provider: string, id: string): string => `${provider}/${id}`;

/** Value used for the "no override" picker entry. Stored as "" on disk. */
export const INHERIT_VALUE = "Inherit";

/** A model list plus pi-model-sort's last-used timestamps, ready for the picker. */
export interface ModelSource {
  models: ModelLike[];
  lastUsed: Record<string, number>;
}

/**
 * Read pi-model-sort's last-used timestamps from
 * ~/.pi/agent/extensions/pi-model-sort.json (best-effort). Returns {} when the
 * file is absent or unreadable so the picker degrades to alphabetical order.
 */
export function readModelSortLastUsed(): Record<string, number> {
  try {
    const configPath = join(getAgentDir(), "extensions", "pi-model-sort.json");
    if (!existsSync(configPath)) return {};
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
      lastUsed?: Record<string, number>;
    };
    return parsed.lastUsed ?? {};
  } catch {
    return {};
  }
}

/**
 * Sort models the way pi-model-sort reorders the /model picker: current model
 * first, then most recently used (descending), then provider/id alphabetical.
 * Mirrors sortByLastUsed from pi-model-sort/src/index.ts so this picker matches
 * the order users see in /model.
 */
export function sortByLastUsed<T extends ModelLike>(
  items: T[],
  lastUsed: Record<string, number>,
  currentModelKey: string | null,
): T[] {
  const sorted = [...items];
  sorted.sort((a, b) => {
    const aKey = buildModelKey(a.provider, a.id);
    const bKey = buildModelKey(b.provider, b.id);
    if (currentModelKey !== null) {
      const aIsCurrent = aKey === currentModelKey;
      const bIsCurrent = bKey === currentModelKey;
      if (aIsCurrent && !bIsCurrent) return -1;
      if (!aIsCurrent && bIsCurrent) return 1;
    }
    const aLast = lastUsed[aKey] ?? 0;
    const bLast = lastUsed[bKey] ?? 0;
    if (aLast !== bLast) return bLast - aLast;
    return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
  });
  return sorted;
}

/** Build a ModelSource from the registry, degrading to an empty list on failure. */
export function buildModelSource(registry: ModelRegistryLike): ModelSource {
  let models: ModelLike[];
  try {
    models = registry.getAvailable();
  } catch {
    models = [];
  }
  return { models, lastUsed: readModelSortLastUsed() };
}

/** Build the canonical `provider/id` key used on disk and by `pi --model`. */
export const modelKey = buildModelKey;
