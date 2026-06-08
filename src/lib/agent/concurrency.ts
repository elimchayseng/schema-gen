/**
 * Concurrency helpers (Phase 5, plan §7 item 5). The perceive/act loops process
 * pages in bounded-size batches so the LLM/scan fan-out never floods the inference
 * endpoint or the Asset API. The bound is realized by `Promise.all` over a `chunk`
 * of size ≤ limit; `run.ts` keeps the per-batch kill + circuit-breaker checks.
 */

/** Default and bounds for the act/perceive concurrency cap (plan: "3–5"). */
export const DEFAULT_CONCURRENCY = 4;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 5;

/**
 * Clamp a caller-supplied concurrency to the safe 1..5 range. A non-finite or
 * absent value falls back to DEFAULT_CONCURRENCY, so `runGoal` can pass the raw
 * option through without pre-validating it.
 */
export function clampConcurrency(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  return Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, Math.floor(n)));
}

/**
 * Split an array into consecutive chunks of at most `size`, preserving order.
 * The last chunk may be shorter. `size` is clamped to >= 1 so a bad cap can never
 * produce an infinite loop or zero-width chunks.
 */
export function chunk<T>(items: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) {
    out.push(items.slice(i, i + n));
  }
  return out;
}
