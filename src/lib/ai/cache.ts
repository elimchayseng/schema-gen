/**
 * LLM response cache (Phase 5, TODOS "Response caching for LLM calls"). A 24h,
 * content-hash-keyed cache over `generateSchemas`. The key is a SHA-256 of the exact
 * prompt input (model + user message), so the cache is *correct* by construction —
 * identical input always maps to the output it produced. The real, guaranteed win is
 * re-run dedup: a resumed agent run or a re-crawl of an unchanged page within 24h pays
 * zero LLM cost. It does NOT dedup distinct same-template product pages (their HTML
 * differs, so the prompt differs) — that part of the TODO estimate is optimistic.
 *
 * In-memory only (per server process). FIFO eviction at a size cap; TTL via an
 * injectable clock so tests can advance time without real waits.
 */
import { createHash } from "node:crypto";
import type { GeneratorResult } from "./types";

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_ENTRIES = 500;

/** SHA-256 hex of a string — the stable cache key for a prompt input. */
export function hashContent(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Map-backed TTL cache with FIFO eviction. `now` is injectable for tests; production
 * uses `Date.now`. Insertion order (Map iteration order) is the eviction order, and a
 * re-`set` of an existing key refreshes its position so it is not evicted prematurely.
 */
export class TtlCache<V> {
  private store = new Map<string, Entry<V>>();

  constructor(
    private readonly ttlMs: number = CACHE_TTL_MS,
    private readonly maxEntries: number = MAX_ENTRIES,
    private readonly now: () => number = Date.now
  ) {}

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    // Refresh position so a re-set key is treated as most-recent for eviction.
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

/** Process-wide cache for `generateSchemas` results. */
export const generationCache = new TtlCache<GeneratorResult>();

/** Test isolation: reset the singleton between cases. */
export function clearGenerationCache(): void {
  generationCache.clear();
}
