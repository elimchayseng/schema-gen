import { describe, it, expect } from "vitest";
import { chunk, clampConcurrency, DEFAULT_CONCURRENCY } from "../concurrency";

describe("clampConcurrency", () => {
  it("defaults when undefined or non-finite", () => {
    expect(clampConcurrency(undefined)).toBe(DEFAULT_CONCURRENCY);
    expect(clampConcurrency(NaN)).toBe(DEFAULT_CONCURRENCY);
    expect(clampConcurrency(Infinity)).toBe(DEFAULT_CONCURRENCY);
  });

  it("clamps to the 1..5 range and floors fractions", () => {
    expect(clampConcurrency(0)).toBe(1);
    expect(clampConcurrency(-3)).toBe(1);
    expect(clampConcurrency(3)).toBe(3);
    expect(clampConcurrency(3.9)).toBe(3);
    expect(clampConcurrency(99)).toBe(5);
  });
});

describe("chunk", () => {
  it("splits into consecutive ordered chunks of at most `size`", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
    expect(chunk([1, 2, 3, 4], 5)).toEqual([[1, 2, 3, 4]]);
  });

  it("returns [] for an empty input", () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it("clamps a non-positive size to 1 (never an infinite loop)", () => {
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
    expect(chunk([1, 2], -4)).toEqual([[1], [2]]);
  });

  it("bounds in-flight work: Promise.all over each chunk never exceeds `size`", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let active = 0;
    let maxActive = 0;
    for (const batch of chunk(items, 3)) {
      await Promise.all(
        batch.map(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active--;
        })
      );
    }
    expect(maxActive).toBeLessThanOrEqual(3);
  });
});
