/**
 * Post-publish verification (post-publish.ts): re-verify the touched pages at
 * their REAL urls after themePublish. The load-bearing property under test is
 * the stale/fail distinction — a render missing the staged blocks is a cache
 * copy (re-poll, never fail), a render carrying them is the new theme's output
 * (any gate failure is definite). fetchHtml/sleep injected; no network.
 */
import { describe, it, expect, vi } from "vitest";
import { postPublishVerify } from "../post-publish";
import type { TypeRequirement } from "../types";

const stagedProduct = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Staged Tee",
  description: "A lightweight cotton t-shirt staged by this run.",
  image: "https://example.com/tee.jpg",
  sku: "TEE-001",
  brand: { "@type": "Brand", name: "Acme" },
  offers: {
    "@type": "Offer",
    price: 29.99,
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
    url: "https://example.com/tee",
  },
};

const otherValidProduct = {
  ...stagedProduct,
  name: "Old Theme Tee",
  sku: "TEE-OLD",
};

const requirements: TypeRequirement[] = [{ type: "Product", outcome: "valid" }];

function htmlWith(...blocks: unknown[]): string {
  return blocks
    .map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`)
    .join("\n");
}

const URL1 = "https://shop.com/products/p1";
const noSleep = async () => {};

function page(url = URL1) {
  return { url, expectBlocks: stagedProduct, requirements };
}

describe("postPublishVerify", () => {
  it("verified on first attempt when the published render carries the staged blocks", async () => {
    const fetchHtml = vi.fn(async () => htmlWith(stagedProduct));
    const r = await postPublishVerify({
      pages: [page()],
      fetchHtml,
      unique: false,
      sleep: noSleep,
    });
    expect(r.status).toBe("verified");
    expect(r.pages).toEqual([
      expect.objectContaining({ url: URL1, status: "pass", attempts: 1 }),
    ]);
  });

  it("re-polls a stale cache copy (staged blocks absent) until it converges", async () => {
    // Two stale renders of the OLD theme (a valid Product, but not OUR block),
    // then the new render appears. Stale must re-poll, not false-pass or fail.
    const fetchHtml = vi
      .fn<(u: string) => Promise<string>>()
      .mockResolvedValueOnce(htmlWith(otherValidProduct))
      .mockResolvedValueOnce(htmlWith(otherValidProduct))
      .mockResolvedValue(htmlWith(stagedProduct));
    const r = await postPublishVerify({
      pages: [page()],
      fetchHtml,
      unique: false,
      sleep: noSleep,
    });
    expect(r.status).toBe("verified");
    expect(r.pages[0].attempts).toBe(3);
  });

  it("budget exhausted while stale ⇒ 'stale' (inconclusive), never 'failed'", async () => {
    const fetchHtml = vi.fn(async () => htmlWith(otherValidProduct));
    const r = await postPublishVerify({
      pages: [page()],
      fetchHtml,
      unique: false,
      maxAttempts: 3,
      sleep: noSleep,
    });
    expect(r.status).toBe("stale");
    expect(r.pages[0].status).toBe("stale");
    expect(r.pages[0].attempts).toBe(3);
    expect(fetchHtml).toHaveBeenCalledTimes(3);
  });

  it("a fresh render (staged blocks present) that fails the dup gate is a definite fail — stops polling", async () => {
    // The new theme's own render carries the staged block PLUS a competing valid
    // Product — suppression didn't take. No amount of polling changes this.
    const fetchHtml = vi.fn(async () => htmlWith(stagedProduct, otherValidProduct));
    const r = await postPublishVerify({
      pages: [page()],
      fetchHtml,
      unique: true,
      maxAttempts: 10,
      sleep: noSleep,
    });
    expect(r.status).toBe("failed");
    expect(r.pages[0].status).toBe("fail");
    expect(r.pages[0].detail).toContain("duplicate");
    expect(fetchHtml).toHaveBeenCalledTimes(1);
  });

  it("fetch errors are transient: re-polled, and an exhausted budget is 'stale' not 'failed'", async () => {
    const fetchHtml = vi.fn(async () => {
      throw new Error("429 too many requests");
    });
    const r = await postPublishVerify({
      pages: [page()],
      fetchHtml,
      unique: false,
      maxAttempts: 2,
      sleep: noSleep,
    });
    expect(r.status).toBe("stale");
    expect(r.pages[0].detail).toContain("fetch failed");
  });

  it("mixed pages: one definite fail makes the whole verdict 'failed'", async () => {
    const P2 = "https://shop.com/products/p2";
    const fetchHtml = vi.fn(async (u: string) =>
      u.startsWith(URL1)
        ? htmlWith(stagedProduct)
        : htmlWith(stagedProduct, otherValidProduct)
    );
    const r = await postPublishVerify({
      pages: [page(), page(P2)],
      fetchHtml,
      unique: true,
      sleep: noSleep,
    });
    expect(r.status).toBe("failed");
    expect(r.pages.map((p) => p.status)).toEqual(["pass", "fail"]);
  });

  it("appends a unique cache-bust param per attempt so no two fetches share a cache key", async () => {
    const seen: string[] = [];
    const fetchHtml = vi.fn(async (u: string) => {
      seen.push(u);
      return seen.length < 3 ? htmlWith(otherValidProduct) : htmlWith(stagedProduct);
    });
    await postPublishVerify({
      pages: [page()],
      fetchHtml,
      unique: false,
      sleep: noSleep,
      bustSeed: "seed",
    });
    expect(seen).toEqual([
      `${URL1}?sgpp=seed-0`,
      `${URL1}?sgpp=seed-1`,
      `${URL1}?sgpp=seed-2`,
    ]);
  });

  it("passes pages stop being fetched while stale pages keep polling", async () => {
    const P2 = "https://shop.com/products/p2";
    let p2Calls = 0;
    const fetchHtml = vi.fn(async (u: string) => {
      if (u.startsWith(URL1)) return htmlWith(stagedProduct);
      p2Calls++;
      return p2Calls < 3 ? htmlWith(otherValidProduct) : htmlWith(stagedProduct);
    });
    const r = await postPublishVerify({
      pages: [page(), page(P2)],
      fetchHtml,
      unique: false,
      sleep: noSleep,
    });
    expect(r.status).toBe("verified");
    expect(r.pages[0].attempts).toBe(1);
    expect(r.pages[1].attempts).toBe(3);
  });
});
