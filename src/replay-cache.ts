export type ReplayCache = {
  seen: (key: string, nowMs?: number) => boolean;
  clear: () => void;
  size: () => number;
};

export function createReplayCache(options: {
  ttlMs: number;
  maxEntries: number;
}): ReplayCache {
  const entries = new Map<string, number>();

  function prune(nowMs: number): void {
    for (const [key, expiresAt] of entries) {
      if (expiresAt <= nowMs) entries.delete(key);
    }
    while (entries.size > options.maxEntries) {
      const oldest = entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  return {
    seen(key, nowMs = Date.now()) {
      if (!key) return false;
      const expiresAt = entries.get(key);
      if (expiresAt !== undefined && expiresAt > nowMs) return true;
      entries.delete(key);
      entries.set(key, nowMs + options.ttlMs);
      prune(nowMs);
      return false;
    },
    clear() {
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}
