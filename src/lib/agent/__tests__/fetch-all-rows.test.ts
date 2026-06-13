/**
 * Issue #35: PostgREST caps a bare select at 1000 rows. fetchAllRows pages with
 * .range() until a short page, so full-catalog reports / committed-URL sets are
 * never silently truncated.
 */
import { describe, it, expect, vi } from "vitest";
import { fetchAllRows } from "../audit";

function makeRows(n: number): { url: string }[] {
  return Array.from({ length: n }, (_, i) => ({ url: `/p${i}` }));
}

describe("fetchAllRows", () => {
  it("pages until a short page and concatenates everything", async () => {
    // 2300 rows → page sizes 1000, 1000, 300 (the short page stops the loop).
    const total = makeRows(2300);
    const buildPage = vi.fn(async (from: number, to: number) => ({
      data: total.slice(from, to + 1),
      error: null,
    }));

    const rows = await fetchAllRows(buildPage);

    expect(rows).toHaveLength(2300);
    expect(buildPage).toHaveBeenCalledTimes(3);
    expect(buildPage.mock.calls[0]).toEqual([0, 999]);
    expect(buildPage.mock.calls[1]).toEqual([1000, 1999]);
    expect(buildPage.mock.calls[2]).toEqual([2000, 2999]);
  });

  it("stops after one page when the first page is short", async () => {
    const buildPage = vi.fn(async () => ({ data: makeRows(5), error: null }));
    const rows = await fetchAllRows(buildPage);
    expect(rows).toHaveLength(5);
    expect(buildPage).toHaveBeenCalledTimes(1);
  });

  it("makes a second request only when the first page is exactly full", async () => {
    const pages = [makeRows(1000), makeRows(0)];
    const buildPage = vi.fn(async () => ({ data: pages.shift() ?? [], error: null }));
    const rows = await fetchAllRows(buildPage);
    expect(rows).toHaveLength(1000);
    expect(buildPage).toHaveBeenCalledTimes(2); // full page → probe once more
  });

  it("throws on a query error (caller decides how to degrade)", async () => {
    const buildPage = vi.fn(async () => ({ data: null, error: { message: "boom" } }));
    await expect(fetchAllRows(buildPage)).rejects.toThrow();
  });
});
