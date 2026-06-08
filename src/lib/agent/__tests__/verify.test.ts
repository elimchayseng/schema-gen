import { describe, it, expect, vi } from "vitest";
import { l4Verify } from "../verify";

const URL = "https://shop.myshopify.com/products/tee";

/** A valid Product schema (passes the validation engine). */
const VALID_PRODUCT = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Summer Collection Tee",
  description: "A lightweight cotton t-shirt.",
  image: "https://example.com/tee.jpg",
  sku: "TEE-001",
  brand: { "@type": "Brand", name: "Acme" },
  offers: {
    "@type": "Offer",
    price: "29.99",
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
    url: "https://example.com/tee",
  },
};

function pageWith(schema: unknown): string {
  return `<!doctype html><html><head>
    <script type="application/ld+json">${JSON.stringify(schema)}</script>
    </head><body>tee</body></html>`;
}

const EMPTY_PAGE = `<!doctype html><html><head></head><body>no schema here</body></html>`;

const noSleep = () => Promise.resolve();

describe("l4Verify (live verify)", () => {
  it("passes when the live render carries a valid required type", async () => {
    const fetchHtml = vi.fn(async () => pageWith(VALID_PRODUCT));
    const r = await l4Verify({
      fetchHtml,
      url: URL,
      requireTypes: ["Product"],
      minOutcome: "valid",
      maxAttempts: 1,
    });
    expect(r.passed).toBe(true);
    expect(fetchHtml).toHaveBeenCalledTimes(1);
  });

  it("fails when the snippet did not render (no JSON-LD on the page)", async () => {
    const r = await l4Verify({
      fetchHtml: async () => EMPTY_PAGE,
      url: URL,
      requireTypes: ["Product"],
      minOutcome: "valid",
      maxAttempts: 1,
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/no JSON-LD/i);
  });

  it("fails when a required type is missing from the live render", async () => {
    const article = { "@context": "https://schema.org", "@type": "Article", headline: "x" };
    const r = await l4Verify({
      fetchHtml: async () => pageWith(article),
      url: URL,
      requireTypes: ["Product"],
      minOutcome: "valid",
      maxAttempts: 1,
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/no valid 'Product'/);
  });

  it("fails when the required type is present but invalid live", async () => {
    const brokenProduct = { "@context": "https://schema.org", "@type": "Product" }; // missing name etc.
    const r = await l4Verify({
      fetchHtml: async () => pageWith(brokenProduct),
      url: URL,
      requireTypes: ["Product"],
      minOutcome: "valid",
      maxAttempts: 1,
    });
    expect(r.passed).toBe(false);
  });

  it("returns a failed GateResult (does not throw) when the fetch errors", async () => {
    const r = await l4Verify({
      fetchHtml: async () => {
        throw new Error("ECONNREFUSED");
      },
      url: URL,
      requireTypes: ["Product"],
      minOutcome: "valid",
      maxAttempts: 1,
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/could not fetch/i);
  });

  it("polls past a stale render: empty first, schema on retry", async () => {
    const fetchHtml = vi
      .fn<(url: string) => Promise<string>>()
      .mockResolvedValueOnce(EMPTY_PAGE) // not propagated yet
      .mockResolvedValueOnce(pageWith(VALID_PRODUCT)); // now live
    const sleep = vi.fn(noSleep);
    const r = await l4Verify({
      fetchHtml,
      url: URL,
      requireTypes: ["Product"],
      minOutcome: "valid",
      maxAttempts: 4,
      sleep,
    });
    expect(r.passed).toBe(true);
    expect(fetchHtml).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1); // slept once between the two attempts
  });

  it("exhausts attempts when the page never renders the schema", async () => {
    const fetchHtml = vi.fn(async () => EMPTY_PAGE);
    const sleep = vi.fn(noSleep);
    const r = await l4Verify({
      fetchHtml,
      url: URL,
      requireTypes: ["Product"],
      minOutcome: "valid",
      maxAttempts: 3,
      sleep,
    });
    expect(r.passed).toBe(false);
    expect(fetchHtml).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // slept between attempts, not after the last
  });
});
