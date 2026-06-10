import { describe, it, expect } from "vitest";
import { groupRunPages } from "../run-grouping";

const A = "https://shop.test/products/a";
const B = "https://shop.test/products/b";
const C = "https://shop.test/products/c";
const D = "https://shop.test/products/d";
const E = "https://shop.test/products/e";

describe("groupRunPages", () => {
  it("excludes skipped pages from fixed (satisfied is a superset of skipped)", () => {
    // The load-bearing trap: satisfied = [...skipped, ...newly-staged]. A naive
    // fixed=satisfied would double-count the already-good pages.
    const g = groupRunPages({
      satisfied: [B, A, C], // A,C were skipped; B is the only fresh fix
      unsatisfied: [],
      skipped: [A, C],
      perceivedUrls: [A, B, C],
    });
    expect(g.fixed).toEqual([B]);
    expect(g.alreadyGood).toEqual([A, C]);
    expect(g.failed).toEqual([]);
    expect(g.notReached).toEqual([]);
  });

  it("derives notReached as perceived minus satisfied minus unsatisfied", () => {
    const g = groupRunPages({
      satisfied: [A],
      unsatisfied: [B, C],
      skipped: [],
      perceivedUrls: [A, B, C, D, E],
    });
    // D and E were scanned but a breaker halted the run before they were acted on.
    expect(g.fixed).toEqual([A]);
    expect(g.failed).toEqual([B, C]);
    expect(g.notReached).toEqual([D, E]);
    expect(g.alreadyGood).toEqual([]);
  });

  it("handles a kill mid-perceive: notReached only spans perceived pages", () => {
    // Killed after perceiving A and B; A failed, B never acted. Pages never perceived
    // (the rest of the store) are simply unknown to the client and absent everywhere.
    const g = groupRunPages({
      satisfied: [],
      unsatisfied: [A],
      skipped: [],
      perceivedUrls: [A, B],
    });
    expect(g.notReached).toEqual([B]);
    expect(g.failed).toEqual([A]);
    expect(g.fixed).toEqual([]);
  });

  it("surfaces committed-but-unperceived pages as alreadyGood without crashing", () => {
    // Resumed run: a prior-committed page X is in satisfied+skipped but was filtered out
    // before perceive, so it is NOT in perceivedUrls. It must still show as alreadyGood
    // and must never leak into notReached.
    const X = "https://shop.test/products/x";
    const g = groupRunPages({
      satisfied: [X, B],
      unsatisfied: [],
      skipped: [X],
      perceivedUrls: [B],
    });
    expect(g.alreadyGood).toEqual([X]);
    expect(g.fixed).toEqual([B]);
    expect(g.notReached).toEqual([]);
  });

  it("returns empty groups for an empty run without throwing", () => {
    const g = groupRunPages({
      satisfied: [],
      unsatisfied: [],
      skipped: [],
      perceivedUrls: [],
    });
    expect(g).toEqual({ fixed: [], alreadyGood: [], failed: [], notReached: [] });
  });

  it("de-duplicates within each group", () => {
    const g = groupRunPages({
      satisfied: [B, B],
      unsatisfied: [C, C],
      skipped: [],
      perceivedUrls: [B, C, D, D],
    });
    expect(g.fixed).toEqual([B]);
    expect(g.failed).toEqual([C]);
    expect(g.notReached).toEqual([D]);
  });
});
