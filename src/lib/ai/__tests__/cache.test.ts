import { describe, it, expect } from "vitest";
import { TtlCache, hashContent, CACHE_TTL_MS } from "../cache";

describe("hashContent", () => {
  it("is stable and distinct per input", () => {
    expect(hashContent("a")).toBe(hashContent("a"));
    expect(hashContent("a")).not.toBe(hashContent("b"));
    expect(hashContent("a")).toMatch(/^[0-9a-f]{64}$/); // sha-256 hex
  });
});

describe("TtlCache", () => {
  it("returns a stored value before expiry and undefined after", () => {
    let now = 1_000;
    const cache = new TtlCache<string>(CACHE_TTL_MS, 100, () => now);
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");

    now += CACHE_TTL_MS - 1;
    expect(cache.get("k")).toBe("v"); // still inside the window

    now += 2; // crosses expiresAt
    expect(cache.get("k")).toBeUndefined();
  });

  it("evicts the oldest entry past the size cap (FIFO)", () => {
    const cache = new TtlCache<number>(CACHE_TTL_MS, 2, () => 0);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // evicts "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("re-setting a key refreshes its eviction position", () => {
    const cache = new TtlCache<number>(CACHE_TTL_MS, 2, () => 0);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 11); // a is now most-recent
    cache.set("c", 3); // evicts "b", not "a"
    expect(cache.get("a")).toBe(11);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });

  it("clear empties the cache", () => {
    const cache = new TtlCache<number>();
    cache.set("a", 1);
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
